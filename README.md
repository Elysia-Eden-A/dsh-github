# dsh-github

让 Agent 能直接往你 GitHub 推东西。不用开终端，不用每次贴 token。

## 为什么写这个

推一个文件夹上去，正常流程是三件事：装 git、凭证、能连上 github.com。任何一件出岔子就卡死。

我这边卡的是第三件：`github.com` 握手被重置，`api.github.com` 反而是通的。于是就有了两条路：

1. 先做一次 TLS 握手探测，通了就走 `git add/commit/push`
2. 不通就把文件一个个走 Git Data API 传上去：`blobs` → `trees` → `commits` → `refs`

结果一样。区别是不通的时候不会再去惊动 git——不然它会弹一个 `CredentialHelperSelector` 框卡住整个调用，我第一次遇到时还以为是中了什么病毒。

## 登录一次就够了

`github_login` 收一个 personal access token，先拿去 `GET /user` 验一下，确认有效才存。

存哪儿：`%LOCALAPPDATA%\dsh-github\cred.txt`，用 **Windows DPAPI** 加密，只有你这台机器上这个 Windows 账户能解开。不进 DSH 配置，不进仓库，也不进聊天记录。

之后换会话、重启电脑都不用再给。要收回就在 GitHub 上点 revoke，本地这份立刻失效。

需要的权限：classic token 勾 `repo` 就够。

## 两个工具

| 工具 | 干什么 |
|---|---|
| `github_login` | 验证 token 并存起来 |
| `github` | `whoami` / `list_repos` / `create_repo` / `push` |

`push` 要的参数：`dir`（本地绝对路径）、`name`（仓库名），可选 `branch`、`message`、`private`。仓库不存在会自动建。

## 踩过的坑

写的时候撞上的，记下来免得再撞：

- **空仓库拒收 blob**。往一个零提交的仓库 POST `/git/blobs` 会返回 409 `Git Repository is empty`。得先用 contents API 塞一个文件把它初始化
- **BOM 让 DPAPI 读不出来**。`Set-Content -Encoding UTF8` 在 PowerShell 5.1 下会写 BOM，`ConvertTo-SecureString` 直接报 "Input string was not in a correct format"。改成 ASCII 写、读的时候再剥 BOM
- **TCP 通不等于能用**。只看端口通不通会误判，得做 TLS 握手才算数
- **git 直推会一直等**。现在超时压到 30 秒，没 `.git` 的目录先 `git init`

## 局限

- API 通道会跳过 40 MB 以上的文件（REST 接口的 blob 上限）
- `.git` 和 `node_modules` 不上传
- 每次推送一个提交，不重写历史
- 只有 Windows（DPAPI）

## License

MIT

---

## English, briefly

A DeepSeek Harness plugin for GitHub: sign in once with a token (stored via Windows DPAPI), then create repositories and upload a folder from a single tool call.

It has two transports because the network here does not behave: `github.com` resets the handshake while `api.github.com` works fine, so a plain `git push` fails forever. The plugin probes with a real TLS handshake first; if that fails it uploads through the Git Data API instead (blobs → trees → commits → refs). Same result, and no credential-helper dialog blocking the call.

`github_login` validates the token before storing it. `github` handles `whoami`, `list_repos`, `create_repo` and `push`. Files over 40 MB are skipped on the API path; `.git` and `node_modules` are never uploaded. Windows only. MIT.
