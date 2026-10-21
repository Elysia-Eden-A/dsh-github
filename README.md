# dsh-github

A **DeepSeek Harness (DSH) plugin** that lets the agent work with your GitHub account: sign in once, then create repositories and upload a local project folder — without touching a terminal, a token prompt, or `git push`.

[中文说明见下方](#中文说明)

---

## Why it exists

Pushing a folder to GitHub normally means `git`, credentials, and a working connection to `github.com`. This plugin turns that into one tool call:

- **one-time sign-in** — a personal access token, encrypted with Windows DPAPI
- **create + push in one step** — repository is created if it does not exist
- **two transport paths** — `git` when `github.com` is reachable, the GitHub **Git Data API** over `api.github.com` when it is not

That second path matters: on networks where `github.com` is unreachable but `api.github.com` is not, plain `git push` fails forever. The plugin probes the host first and silently switches transports, so the upload still lands.

## Tools

| tool | actions |
|---|---|
| `github_login` | validate a token against `GET /user`, then store it |
| `github` | `whoami` · `list_repos` · `create_repo` · `push` |

`push` parameters: `dir` (absolute local path), `name` (repo name), `branch` (default `main`), `message`, `private`, `create_if_missing`.

## Install

```json
{ "action": "install_bundle", "target": "D:\\path\\to\\dsh-github" }
```

Requires DSH with `plugin_manager`, Windows, and PowerShell 5.1 (built in).

## Credentials

- Tokens are validated before being stored.
- Storage is `%LOCALAPPDATA%\dsh-github\cred.txt`, encrypted with **DPAPI** (`CurrentUser` scope) — only your Windows account on this machine can decrypt it.
- The token never enters the DSH profile, the plugin config, or the chat transcript.
- Revoke it on GitHub at any time; the stored copy simply stops working.

Scope needed: classic token with `repo` (or fine-grained with Contents + Administration write).

## How `push` works

1. Ensure the repository exists (create when `create_if_missing` is not `false`).
2. Probe `github.com:443` for 2.5 s.
3. Reachable → `git add/commit/push` with the token in the URL.
4. Not reachable → upload every file through the Git Data API: `blobs` → `trees` → `commits` → `refs`.
5. An empty repository rejects the blob API, so it is seeded once through the contents API first.

The probe is not a micro-optimisation: without it, a blocked `github.com` makes `git` pop a *CredentialHelperSelector* dialog on Windows that blocks the call.

## Limits

- Files larger than 40 MB are skipped on the API path (the REST API caps blob size).
- `.git` and `node_modules` are never uploaded.
- The API path writes one commit per push, no history rewriting.
- Windows only (DPAPI).

## License

MIT

---

## 中文说明

给 **DeepSeek Harness** 用的 GitHub 集成插件。登录一次之后，Agent 就能直接建仓库、把本地文件夹推上去，不用你开终端、不用复制 token、也不用 `git push`。

**两个工具**：`github_login`（验证并加密保存 token）、`github`（`whoami` / `list_repos` / `create_repo` / `push`）。

**为什么要两条通道**：有些网络能连 `api.github.com` 但连不上 `github.com`，这时 `git push` 永远失败。插件会先探测 2.5 秒，通就用 git，不通就改用 GitHub 的 Git Data API 直接上传文件，结果一样。

**凭证怎么存**：用 Windows DPAPI 加密放在 `%LOCALAPPDATA%\dsh-github\cred.txt`，只有本机这个 Windows 账户能解开；不进 DSH 配置、不进仓库、不进对话。随时可以在 GitHub 上撤销，撤销后本地这份就失效。

**需要什么权限**：classic token 勾 `repo` 即可（fine-grained 需要 Contents + Administration 写权限）。

**注意**：API 通道会跳过 40 MB 以上的文件；`.git` 和 `node_modules` 不会上传。
