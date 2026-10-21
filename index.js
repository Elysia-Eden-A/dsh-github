import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { Socket } from "node:net";

export const name = "dsh-github";
export const inject = ["tools"];

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, "gh.ps1");
const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const API = "https://api.github.com";

function runHelper(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER, "-Payload", encoded],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("credential helper timed out")); }, 20000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim())); } catch { reject(new Error(`helper output: ${out.slice(0, 300)} ${err.slice(0, 300)}`)); }
    });
  });
}

async function credential() {
  const r = await runHelper({ action: "read" });
  if (!r.ok) throw new Error("还没有登录 GitHub：请先调用 github_login 提供 token");
  return JSON.parse(r.credential);
}

async function api(path, init, token) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body && typeof body === "object" ? body.message : String(body).slice(0, 200);
    throw new Error(`GitHub ${res.status} on ${path}: ${msg}`);
  }
  return body;
}

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "echo" },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("git timed out")); }, 120000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`git ${args[0]} failed (${code}): ${(err || out).trim().slice(0, 600)}`));
    });
  });
}

/** Plain TCP probe; github.com is unreachable on some networks and git would pop a credential dialog. */
function canReach(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

const loginTool = {
  name: "github_login",
  description: "Store a GitHub personal access token for this user, encrypted with Windows DPAPI (per-user, current machine only). Validates the token against GET /user before saving. Needs a classic token with `repo` scope (or fine-grained with Contents+Administration read/write). The token is never written to the DSH profile in plain text.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["token"],
    properties: {
      token: { type: "string", description: "The GitHub token to validate and store (ghp_... or github_pat_...)." },
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" }, action: { type: "string" }, detail: { type: "string" } },
    },
    render: (_a, v) => [{ type: "text", text: v.detail }],
  },
  timeoutMs: 40000,
  isConcurrencySafe: () => false,
  async execute(args) {
    const token = String(args?.token ?? "").trim();
    if (!token) throw new Error("token is required");
    const me = await api("/user", {}, token);
    await runHelper({ action: "save", token, login: me.login });
    return { ok: true, action: "login", detail: `已登录 GitHub，账号 ${me.login}（${me.name ?? "no name"}）。token 已用 DPAPI 加密保存在 %LOCALAPPDATA%\\dsh-github\\cred.txt。` };
  },
  presentCall: (a) => ({ card: "generic", title: "github_login", kind: "execute", rawInput: { token: "***" } }),
};

const ghTool = {
  name: "github",
  description: [
    "Act on the signed-in user's GitHub account through the REST API and local git.",
    "Actions:",
    "- whoami: show the authenticated account.",
    "- list_repos: recent repositories (newest first, up to 30).",
    "- create_repo: create a repository for the user. Params: name, private (boolean, default false).",
    "- push: commit everything in dir and push it to owner/name. Params: dir (absolute local path), name, branch (default main), message (commit message). Creates the repo if it does not exist yet when create_if_missing is true.",
    "Requires github_login first.",
  ].join("\n"),
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["whoami", "list_repos", "create_repo", "push"], description: "Operation to perform." },
      name: { type: "string", description: "Repository name (create_repo, push)." },
      private: { type: "boolean", description: "Create as private. Defaults to false." },
      dir: { type: "string", description: "Absolute local directory to commit and push (push)." },
      branch: { type: "string", description: "Target branch. Defaults to main." },
      message: { type: "string", description: "Commit message (push)." },
      create_if_missing: { type: "boolean", description: "Create the repository when it does not exist (push). Defaults to true." },
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" }, action: { type: "string" }, detail: { type: "string" } },
    },
    render: (_a, v) => [{ type: "text", text: v.detail }],
  },
  timeoutMs: 180000,
  isConcurrencySafe: () => false,
  async execute(args) {
    const cred = await credential();
    const action = String(args?.action ?? "");

    if (action === "whoami") {
      const me = await api("/user", {}, cred.token);
      return { ok: true, action, detail: `登录账号：${me.login}（${me.name ?? "-"}），公开仓库 ${me.public_repos} 个。` };
    }

    if (action === "list_repos") {
      const repos = await api("/user/repos?sort=updated&per_page=30", {}, cred.token);
      const lines = repos.map((r) => `- ${r.full_name}${r.private ? " [private]" : ""}  ${r.default_branch}`);
      return { ok: true, action, detail: `${repos.length} 个仓库：\n${lines.join("\n")}` };
    }

    if (action === "create_repo") {
      const name = String(args?.name ?? "").trim();
      if (!name) throw new Error("name is required");
      const repo = await api("/user/repos", { method: "POST", body: JSON.stringify({ name, private: args?.private === true, auto_init: false }) }, cred.token);
      return { ok: true, action, detail: `已创建 ${repo.full_name}（${repo.private ? "private" : "public"}）` };
    }

    if (action === "push") {
      const name = String(args?.name ?? "").trim();
      const dir = String(args?.dir ?? "").trim();
      if (!name || !dir) throw new Error("name and dir are required");
      const branch = String(args?.branch ?? "main").trim() || "main";
      const message = String(args?.message ?? "chore: update").trim() || "chore: update";
      const owner = cred.login;

      let created = "";
      try {
        await api(`/repos/${owner}/${name}`, {}, cred.token);
      } catch {
        if (args?.create_if_missing !== false) {
          await api("/user/repos", { method: "POST", body: JSON.stringify({ name, private: args?.private === true, auto_init: false }) }, cred.token);
          created = "（仓库不存在，已新建）";
        }
      }

      // fast path: real git, but only when github.com actually accepts connections.
      // Probing first matters: a blocked host makes git pop a credential-helper dialog.
      let gitError = "";
      const gitReachable = await canReach("github.com", 443, 2500);
      if (gitReachable) {
        try {
        await git(["add", "-A"], dir);
        const status = await git(["status", "--porcelain"], dir);
        if (status) {
          await git(["-c", `user.name=${owner}`, "-c", `user.email=${owner}@users.noreply.github.com`, "commit", "-m", message], dir);
        }
        await git(["branch", "-M", branch], dir);
        try { await git(["remote", "remove", "origin"], dir); } catch { /* none yet */ }
        await git(["remote", "add", "origin", `https://github.com/${owner}/${name}.git`], dir);
        const url = `https://x-access-token:${cred.token}@github.com/${owner}/${name}.git`;
        const out = await git(["push", url, `HEAD:${branch}`, "--force"], dir);
        return {
          ok: true,
          action,
          detail: `已通过 git 推送到 ${owner}/${name}:${branch}${created}\n${out.split("\n").slice(-2).join("\n")}\nhttps://github.com/${owner}/${name}`,
        };
      } catch (error) {
        gitError = error.message;
      }
      } else {
        gitError = "github.com 不可达，跳过 git 直推";
      }

      // fallback: Git Data API over api.github.com (works when github.com is blocked)
      const files = [];
      const walk = (base, rel) => {
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          const abs = join(base, entry.name);
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(abs, relPath);
          else if (entry.isFile()) {
            const size = statSync(abs).size;
            if (size > 40 * 1024 * 1024) continue;
            files.push({ path: relPath, buffer: readFileSync(abs) });
          }
        }
      };
      walk(dir, "");

      let parents = [];
      let baseTree;
      const loadParent = async () => {
        const ref = await api(`/repos/${owner}/${name}/git/ref/heads/${branch}`, {}, cred.token);
        parents = [ref.object.sha];
        const parentCommit = await api(`/repos/${owner}/${name}/git/commits/${ref.object.sha}`, {}, cred.token);
        baseTree = parentCommit.tree.sha;
      };
      try {
        await loadParent();
      } catch {
        // an empty repository rejects /git/blobs, so seed it through the contents API first
        await api(`/repos/${owner}/${name}/contents/.gitkeep`, {
          method: "PUT",
          body: JSON.stringify({ message: "chore: initialize repository", content: Buffer.from("\n").toString("base64") }),
        }, cred.token);
        await loadParent();
      }

      const treeEntries = [];
      for (const file of files) {
        const blob = await api(`/repos/${owner}/${name}/git/blobs`, {
          method: "POST",
          body: JSON.stringify({ content: file.buffer.toString("base64"), encoding: "base64" }),
        }, cred.token);
        treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
      }

      const tree = await api(`/repos/${owner}/${name}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ tree: treeEntries, ...(baseTree ? { base_tree: baseTree } : {}) }),
      }, cred.token);

      const commit = await api(`/repos/${owner}/${name}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message, tree: tree.sha, parents }),
      }, cred.token);

      if (parents.length > 0) {
        await api(`/repos/${owner}/${name}/git/refs/heads/${branch}`, {
          method: "PATCH",
          body: JSON.stringify({ sha: commit.sha, force: true }),
        }, cred.token);
      } else {
        await api(`/repos/${owner}/${name}/git/refs`, {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
        }, cred.token);
      }

      return {
        ok: true,
        action,
        detail: [
          `已通过 GitHub API 推送 ${files.length} 个文件到 ${owner}/${name}:${branch}${created}`,
          `commit ${commit.sha.slice(0, 7)}`,
          `（git 直推失败，已自动改走 api.github.com：${gitError.split("\n")[0].slice(0, 120)}）`,
          `https://github.com/${owner}/${name}`,
        ].join("\n"),
      };
    }

    throw new Error(`unknown action: ${action}`);
  },
  presentCall: (a) => ({ card: "generic", title: `github · ${a?.action ?? "?"}`, kind: "execute", rawInput: a }),
};

export function apply(ctx) {
  ctx.effect(() => {
    const a = ctx.tools.register(loginTool);
    const b = ctx.tools.register(ghTool);
    return () => { a(); b(); };
  });
}
