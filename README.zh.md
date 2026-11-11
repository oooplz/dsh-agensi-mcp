# dsh-agensi-mcp

把 [Agensi](https://www.agensi.io)（技能市场）作为原生 `mcp__agensi__*` 工具接进 DeepSeek
Harness。一个远端 MCP 端点，由 Harness 自带的 MCP 客户端直接连接（Streamable HTTP）；这个
bundle 补上 Harness 自己做不到的那一步——**OAuth 2.1 登录**。

English | [中文](README.zh.md) → [English README](README.md)

```
tools/oauth_login.py         OAuth 2.1（DCR + PKCE + 本地回调）──► $DSH_HOME/dsh-runtimes/agensi-mcp/config.json（0600）
                                                                        │  组装时读取
                                                                        ▼
cordis.patch.yml  ──  @deepseek-ai/dsh-mcp-client（streamable-http + Bearer 头）──► https://mcp.agensi.io/mcp/auth
                    ▲
index.js（Host 半边）在过期前用 refresh_token 续期 ──► pluginManager.reload(['agensi-mcp'])
```

两行顺序不能反：先 `dsh-agensi-mcp`（Host 半边 `index.js`），再 `agensi-mcp`（MCP 连接）。

## 为什么必须有登录这一步

未授权的请求会得到：

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.agensi.io/.well-known/oauth-protected-resource/mcp/auth", scope="read install"
```

而 Harness 的 MCP 客户端只接受 `url` + 静态 `headers`：没有 `authProvider`、没有令牌存储、
没有交互式授权。所以授权码流程在带外跑一次，把结果留在一个私有文件里供那一行读取。
**令牌不会出现在仓库里，也不会出现在对话里。**

因此本插件**不提供匿名模式，也不提供 API Key 输入框**：该端点只通过上述 OAuth 授权发放令牌。

## 登录

Agensi 的授权服务器是公开客户端（`token_endpoint_auth_method: none`），注册不需要密钥；
`config.json` 里还没有 client id 时，`start` 会自己完成注册：

```powershell
python tools/oauth_login.py start
```

`start` 会打印 `AUTHORIZE_URL=…`。打开它，登录 Agensi 并点 **允许**；浏览器会落到
`http://127.0.0.1:8791/callback`，脚本写入 `config.json` 并打印 `SIGNED_IN=1`。client id 与
令牌一起存下，后续运行直接复用；要指定固定 id 就设 `AGENSI_CLIENT_ID`，只想做注册则运行
`python tools/oauth_login.py register`。

然后安装插件并确认工具可用：

```powershell
dsh plugin --profile <profile> add dsh-agensi-mcp@0.1.0
```

```
mcp__agensi__search_skills   （或 tools/list 返回的任意工具名）
```

## 续期

访问令牌只有 **1 小时**（`expires_in: 3600`）。Host 半边（`index.js`）每分钟检查一次，在过期
前 5 分钟用 refresh_token 续期、改写 `config.json`，并让插件管理器重新组装 `agensi-mcp` 那一行，
所以长时间会话里工具不会因为令牌过期失效。`status.json` 记录 `expiresAt`、`refreshedAt` 和
`reload` 结果。

需要手动时（Host 半边被停用，或 Harness 没在跑）：

```powershell
python tools/oauth_login.py refresh   # refresh_token 续期，改写 config.json
python tools/check.py                 # initialize + tools/list，遇 401 自动续期一次
```

手动续期后，在插件面板里把这个 bundle 关掉再打开（`plugin_manager` 的 `set_bundle`），
让新令牌进到那一行的 `headers`。如果续期返回 invalid grant，说明授权被吊销了：重新跑 `start`。

## 文件

| 路径 | 作用 |
| :-- | :-- |
| `cordis.patch.yml` | 插入 Host 半边，再插入 `@deepseek-ai/dsh-mcp-client` 那一行（`serverName: agensi`、`streamable-http`、Bearer 头取自 `config.json`） |
| `index.js` | Host 半边：过期前续期，并重新组装 MCP 行 |
| `tools/oauth_login.py` | OAuth 2.1 助手：`start` / `url` / `refresh` |
| `tools/check.py` | 握手检查（`initialize` + `tools/list`），打印工具名，不改动 MCP 数据；遇到 401 可能续期一次 |
| `locale/{en,zh}.json` | 插件标题与描述 |
| `$DSH_HOME/dsh-runtimes/agensi-mcp/config.json` | 运行时令牌存储，POSIX 上权限 `0600`（Windows 上沿用用户目录 ACL），不属于仓库 |
| `$DSH_HOME/dsh-runtimes/agensi-mcp/status.json` | Host 半边最近一次观察结果 |
| `$DSH_HOME/dsh-runtimes/agensi-mcp/plugin.log` | 每次登录 / 续期 / 重组行的一行记录 |

## 已知限制

- Harness 里没有给这一行显示「登录」按钮；登录是上面的助手命令。要做成面板内流程，需要
  `@deepseek-ai/dsh-mcp-client` 支持 `authProvider`，目前没有。
- client id 存在 `config.json` 里；删掉该文件就丢了它。注册是开放的，`start` 会自己注册一个新的，不需要手工恢复。
- 付费技能、付费工具调用都不会自动购买：必须先经用户同意，`get_skill` / `run_tool` 只在用户
  明确说「可以」之后才会被调用。

## 许可证

MIT
