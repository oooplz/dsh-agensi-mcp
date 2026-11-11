# dsh-agensi-mcp

把 [Agensi](https://www.agensi.io)（技能市场）接成 DeepSeek Harness 里的原生
`mcp__agensi__*` 工具，并且**在插件详情页就有登录卡片**：看得到登录状态、过期时间，点一下
按钮就能登录——不用开终端，不用粘贴任何令牌。

[English](README.md) · 中文说明

```
插件详情页（client.js）               Host 半边（index.js）                       MCP 连接
  状态 · 过期时间 · [登录]  ──►  OAuth 2.1：注册 → PKCE → 本地回调  ──►  @deepseek-ai/dsh-mcp-client
                                  │                                   streamable-http
                                  └─► $DSH_HOME/dsh-runtimes/agensi-mcp/config.json ──► Authorization: Bearer …
                                      （令牌，0600）                                     https://mcp.agensi.io/mcp/auth
```

## 能做什么

一个 Streamable HTTP 的 MCP 连接，指向 `https://mcp.agensi.io/mcp/auth`。服务端会公布
**25 个工具**，日常用得上的是这些：

| 用途 | 工具 |
| :-- | :-- |
| 找技能、装技能 | `search_skills`、`get_skill`、`list_categories`、`get_popular`、`get_creator` |
| 账号与已购内容 | `my_library`、`my_credits`、`my_skills` |
| 付费工具（先报价、经你同意） | `find_tools`、`skill_tools`、`quote_tool`、`run_tool`、`check_job`、`quote_status` |
| 发布自己的技能 | `submit_skill`、`update_skill`、`edit_changelog`、`upload_skill_media`、`creator_status`、`set_skill_tools` |
| 反馈与评价 | `skill_feedback`、`review_skill`、`submit_skill_request` |

本插件自己不会花钱：付费技能、付费工具调用都必须先得到你明确同意。

## 安装

```powershell
dsh plugin --profile <profile> add dsh-agensi-mcp
```

然后打开 **设置 → 插件 → Agensi**，卡片就在插件说明下面。要求：带 Web UI 的 DeepSeek
Harness。不需要额外运行时、不需要 Python、也没有任何依赖。

## 登录

1. 打开 Agensi 插件详情页。
2. 点 **登录 Agensi**，会新开一个 Agensi 页面。
3. 登录并点 **允许**。
4. 那个标签页显示「Agensi 已连接」，关掉即可；卡片会在几秒内变成**已登录**。

背后发生的事（不是黑盒）：

- 插件先通过 Agensi 的**动态客户端注册**建一个公开客户端（没有密钥，也不需要你复制什么）；
- 在 `127.0.0.1:8791`（被占用时依次 8792 / 8793）上开一个**本地回调监听**，把它作为
  redirect URI，带 **PKCE（S256）** 和 RFC 8707 的 `resource` 参数；
- 授权码在 Harness 进程内换成令牌，写入
  `$DSH_HOME/dsh-runtimes/agensi-mcp/config.json`（POSIX 权限 `0600`）；
- 立刻重新组装 MCP 那一行，新令牌马上生效。

另外两个按钮：**重新登录**（不用先退出就能换授权）、**退出登录**（清空已存令牌，保留客户端
注册）；浏览器授权还没回来时可以点**取消**。

## 卡片上的信息

| 字段 | 含义 |
| :-- | :-- |
| 状态点 + 文字 | 已登录 / 未登录 / 已过期 |
| 过期时间 | 本地时间 + 倒计时（例如 `15:42 · 42 分钟后到期`） |
| 授权范围 | 令牌拿到的 scope（`read install`） |
| 错误行 | 最近一次登录或续期失败的原因，原样显示 |

卡片会轮询宿主：空闲时 15 秒一次，等待浏览器授权时 2 秒一次。

## 令牌续期

Agensi 的访问令牌只有 **1 小时**。Host 半边会在过期前 5 分钟用 refresh_token 续期、改写令牌
文件，并重新组装 MCP 行，所以长时间会话不需要你手动做什么。续期失败会写日志、写
`status.json`，十分钟后重试；如果是授权被吊销，卡片会说明，点**重新登录**即可。

## 多语言（i18n）

卡片语言跟随 **Harness 的界面语言**（设置 → 通用 → 语言），不是操作系统语言。内置中文与
英文，切换语言时卡片会即时重绘。

- 界面文案放在 `client.js` 的 `I18N` 表里（客户端半边不能 import 模块）；
- `locale/en.json`、`locale/zh.json` 只放插件标题与描述，用于安装前在插件列表里显示；
- 想加一门语言：在 `I18N` 里加一个字典，再补 `locale/<lang>.json` 的
  `meta.title` / `meta.description`；缺的键会退回英文。

## 隐私

- 令牌只存在一个地方：`$DSH_HOME/dsh-runtimes/agensi-mcp/` 下的 `config.json`。不会进仓库、
  不会写进日志，插件的接口也不会把它返回给前端——`status` 只给时间和 scope。
- 插件只和 `mcp.agensi.io` 通信，不上报任何遥测。
- 点退出登录会把令牌从那个文件里删掉。

## 文件

仓库：

| 路径 | 作用 |
| :-- | :-- |
| `cordis.patch.yml` | 先插入 Host 半边，再插入 `@deepseek-ai/dsh-mcp-client` 那一行（Bearer 头从令牌文件读取） |
| `index.js` | Host 半边：OAuth 流程、续期、`status` / `login` / `cancel` / `logout` 接口 |
| `client.js` | 插件详情页卡片：状态、过期时间、登录/退出、i18n |
| `locale/{en,zh}.json` | 插件标题与描述 |
| `icon.svg` | 插件图标 |

运行时（按需生成，不属于仓库）：

| 路径 | 含义 |
| :-- | :-- |
| `$DSH_HOME/dsh-runtimes/agensi-mcp/config.json` | 客户端 id、令牌、过期时间——POSIX 上 `0600`，Windows 上沿用用户目录 ACL |
| `$DSH_HOME/dsh-runtimes/agensi-mcp/status.json` | 最近一次续期观察到的结果 |
| `$DSH_HOME/dsh-runtimes/agensi-mcp/plugin.log` | 只追加的记录：登录、续期、重组行、失败 |

## 排错

| 现象 | 原因 | 处理 |
| :-- | :-- | :-- |
| 卡片提示无法监听 `127.0.0.1:8791–8793` | 端口被别的程序占着 | 关掉它，再点一次登录 |
| 卡片一直「等待浏览器授权…」 | 没点允许就把标签页关了 | 点卡片里的链接，或取消重来 |
| 卡片显示已登录，但工具报 401 | 授权在令牌看似有效时被吊销了 | 点**重新登录** |
| 完全没有 `mcp__agensi__*` 工具 | MCP 那一行没连上 | 把插件关掉再打开，看 `plugin.log` |
| 提示「插件宿主没有响应」 | Host 半边被停用，或当前是无界面环境 | 检查 `status.json` |

Windows 上可以用 `netstat -ano | findstr :8791` 看端口占用。

## 开发

```powershell
git clone https://github.com/oooplz/dsh-agensi-mcp
cd dsh-agensi-mcp
```

profile 里保存的是安装副本，所以改完要重新装：

```
plugin_manager install_bundle  file:<你的仓库路径>
```

在运行中的 Harness 里，把插件关掉再打开即可生效。改完先跑 `node --check index.js` 和
`node --check client.js` 检查语法。

## 已知限制

- 卡片由 Harness Web UI 提供；无界面（headless）环境仍能自动续期，但没有页面可展示。
- 客户端注册信息存在令牌文件里。删掉该文件后，下次登录会自动注册新客户端，不需要手工恢复。
- 购买技能、调用付费工具始终是单独的、明确的确认动作。

## 许可证

MIT
