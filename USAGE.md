# 使用方法（详细版）

> 哔哩哔哩 MCP / B站 MCP / bilibili MCP server / 开放平台 API 助手。
> 关键词：`哔哩哔哩 MCP`、`B站 MCP`、`bilibili MCP`、`B站 MCP server`、`哔哩哔哩开放平台`、`bilibili open platform api`、`Model Context Protocol`。
>
> 本文是**操作手册**：从装到用、每个工具的入参、真实输出长什么样、卡住了怎么查。
> 契约类说明（给 AI 读的）在 [`AGENTS.md`](AGENTS.md)；能力边界与免责在 [`DISCLAIMER.md`](DISCLAIMER.md)。

---

## 目录

- [0. 先确认你能用哪些功能](#0-先确认你能用哪些功能)
- [1. 安装](#1-安装)
- [2. 接入 MCP 客户端](#2-接入-mcp-客户端)
- [3. 凭据：两套体系，别混](#3-凭据两套体系别混)
- [4. 工具详解（19 个）](#4-工具详解19-个)
- [5. 端到端工作流](#5-端到端工作流)
- [6. 报错与排查](#6-报错与排查)
- [7. 数据从哪来 / 怎么更新](#7-数据从哪来--怎么更新)
- [8. 免责声明](#8-免责声明)

---

## 0. 先确认你能用哪些功能

**凭据决定能力边界。** 装完先看这张表，别对着一个用不了的工具调半天：

| 你想做的事 | 需要什么 | 用哪些工具 |
| --- | --- | --- |
| 查文档、看接口参数、生成调用代码 | **不需要凭据** | `bili_docs_*`、`bili_api_spec`、`bili_api_prepare`、`bili_codegen`、`bili_endpoints`、`bili_scopes` |
| 查错误码、看长连/推送协议、看签名串 | **不需要凭据** | `bili_error_lookup`、`bili_ws_protocol`、`bili_webhook`、`bili_api_sign`、`bili_api_call {dryRun:true}` |
| 打官方沙盒 | **不需要凭据** | `bili_mock {action:"call"}` |
| 真调开放平台业务接口、投稿、上传 | `BILI_CRED_FILE` → `secrets/open-platform.json` | `bili_api_call`、`bili_upload_plan`、`bili_oauth`（除 `help`/`status`） |
| 以你自己的登录身份调主站 Web 接口 | `BILI_COOKIE_FILE` → `secrets/cookies.json` | `bili_cookie`、`bili_web_call` |

**两个凭据都没有时**，上表前 3 行照常可用，后 2 行全部不可用。这是设计如此，不是 bug。

任何时候想知道"现在到底缺哪一格"，调这两个：

```
bili_oauth  { "action": "status" }
bili_cookie { "action": "status" }
```

真实输出（未配置时）：

```
# 开放平台凭据状态
- ❌ clientId       未配置
- ❌ appSecret      未配置
- ❌ accessToken    未配置
- ❌ refreshToken   未配置
凭据文件: C:\path\to\bili-open-mcp\secrets\open-platform.json（不存在）
→ 先去 https://open.bilibili.com 控制台创建应用，拿到 Client ID 与 Secret（或 npm run login 按提示填）
```

```
# Cookie 罐  C:\path\to\bili-open-mcp\secrets\cookies.json（文件不存在，jar 为空）

- ❌ SESSDATA           缺失    登录凭证（必需）
- ❌ bili_jct           缺失    CSRF token，POST 必带
- ❌ DedeUserID         缺失    登录用户 uid
- ❌ DedeUserID__ckMd5  缺失    uid 校验
- ❌ buvid3             缺失    设备指纹（风控）
- ❌ buvid4             缺失    设备指纹（风控）
- ❌ b_nut              缺失    设备指纹时间戳
- ❌ sid                缺失    会话 id
- ❌ bili_ticket        缺失    风控票据（部分接口）

共 0 个 cookie，其中 0 个与登录无关（播放器偏好、埋点等）：

下一步:
- 验证登录态: bili_cookie {action:"whoami"}
- 导入: bili_cookie {action:"import", jar:[{name:"SESSDATA", value:"…"}, …]}
- 调用主站接口: bili_web_call {path:"x/web-interface/nav"}
```

---

## 1. 安装

要求 **Node.js ≥ 18**（服务本体只依赖 `@modelcontextprotocol/sdk` 和 `zod`）。

```bash
git clone https://github.com/3810220770/bili-open-mcp-bilibili-mcp-server.git
cd bili-open-mcp-bilibili-mcp-server
npm ci
```

跑一遍自检，四条命令各有分工：

```bash
npm run selftest      # 起服务 → 逐个调 19 个工具 / 资源 / 提示 → 生成代码还要过编译
npm run audit         # 11 类数据一致性检查（文档 ↔ 结构化数据是否对得上）
npm run check-config  # 用一份真实的 opencode 项目配置拉起服务，验证客户端侧能连上
npm run build         # 从 Markdown 重新生成 data/*.json 与 llms.txt
```

期望结尾：

```
tools(19):
  bili_quickstart
  …
===== resources OK: bili://catalog | templates: bili://doc/{ref} | prompts: integrate-bili-api =====
===== catalog / doc 资源 + prompt OK =====
ALL SELFTEST PASSED
```

`npm run audit` 期望：`AUDIT PASSED — 11 类检查全部通过`。

自检是**只读**的：主站写操作全部指向临时 jar，跑完会校验 `secrets/cookies.json` 没被动过。

不想 clone 也可以只要那个单文件：服务本体是 `src/server.mjs` + 同目录 7 个模块，`data/` 是数据。

---

## 2. 接入 MCP 客户端

服务入口固定是 **stdio**：

```
node <仓库路径>/src/server.mjs
```

`data/` 是相对脚本解析的，**与启动目录无关**；
`secrets/` 的查找顺序是 **显式参数 → 环境变量 → 包目录 → 启动方 cwd**（见 [§3.4](#34-凭据文件放在哪)）。

> 下面所有配置里的 `C:/path/to/bili-open-mcp` 都要换成**你自己 clone 的实际路径**。

### 2.1 Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bili-open": {
      "command": "node",
      "args": ["C:/path/to/bili-open-mcp/src/server.mjs"],
      "env": {
        "BILI_CLIENT_ID": "your_client_id",
        "BILI_APP_SECRET": "your_app_secret",
        "BILI_ACCESS_TOKEN": "your_access_token"
      }
    }
  }
}
```

改完**完全退出** Claude Desktop 再启动（托盘图标也要退），否则不会重读配置。

### 2.2 Claude Code

```bash
# 无凭据（只用文档类工具）
claude mcp add bili-open -- node "C:/path/to/bili-open-mcp/src/server.mjs"

# 带凭据
claude mcp add bili-open \
  -e BILI_CLIENT_ID=xxx -e BILI_APP_SECRET=yyy -e BILI_ACCESS_TOKEN=zzz \
  -- node "C:/path/to/bili-open-mcp/src/server.mjs"

claude mcp list
```

### 2.3 Cursor

`~/.cursor/mcp.json`（全局）或项目里的 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "bili-open": {
      "command": "node",
      "args": ["C:/path/to/bili-open-mcp/src/server.mjs"],
      "env": { "BILI_CLIENT_ID": "", "BILI_APP_SECRET": "", "BILI_ACCESS_TOKEN": "" }
    }
  }
}
```

在 `Cursor Settings → MCP` 里看到绿灯、工具列表出现 19 个即为成功。

### 2.4 Codex

`~/.codex/config.toml`：

```toml
[mcp_servers.bili-open]
command = "node"
args = ["C:/path/to/bili-open-mcp/src/server.mjs"]
env = { BILI_CLIENT_ID = "your_client_id", BILI_APP_SECRET = "your_app_secret", BILI_ACCESS_TOKEN = "your_access_token" }
```

### 2.5 OpenCode

项目级 `opencode.json`（只对该项目生效，推荐）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bili-open": {
      "type": "local",
      "command": ["node", "C:/path/to/bili-open-mcp/src/server.mjs"],
      "enabled": true,
      "timeout": 60000,
      "environment": {
        "BILI_CLIENT_ID": "",
        "BILI_APP_SECRET": "",
        "BILI_ACCESS_TOKEN": ""
      }
    }
  }
}
```

字段来自 `https://opencode.ai/config.json` 的 `McpLocalConfig`：`type` 必填 `"local"`，
`command` 必填字符串数组，可选 `cwd` / `environment` / `enabled` / `timeout`
（默认 5000ms，**本服务建议 60000** —— 上传、长连、批量检索会超 5 秒）。

全局配置在 `%USERPROFILE%\.config\opencode\opencode.json`，把 `mcp` 那段合并进去。

一个坑：`command` 用相对路径时，服务会以**该项目的目录**为 cwd 被拉起。
本服务已把 `secrets/` 升级为包目录优先查找，所以凭据放在包目录下不受影响；
要绝对确定，就给 `BILI_COOKIE_FILE` / `BILI_CRED_FILE` 填绝对路径，或在配置里显式给 `cwd`。

### 2.6 其他客户端

任何支持 MCP stdio 的客户端都行，本质就是"启动 `node src/server.mjs`，收发 JSON-RPC"。
Windsurf / Cline / Roo Code / Continue 的字段名可能是 `mcpServers` 或 `mcp.servers`，语义一致。

### 2.7 怎么确认接上了

让 AI 调这两个，都可以在**没有任何凭据**时跑通：

```
bili_quickstart {}
bili_docs_search { "query": "投稿" }
```

`bili_docs_search {query:"投稿"}` 的真实输出：

```
命中 16 条，显示 3:

#16 [api] 唤起粉端投稿接口说明  (title)
    POST /arcopen/fn/resource/add_share  ·  开放能力 / 视频稿件管理 / 用户端唤起粉端投稿

#168 [event] 投稿失败消息  (title)
    开放能力 / 消息推送 / 推送事件列表 / 视频稿件

#167 [event] 投稿开发浏览消息  (title)
    开放能力 / 消息推送 / 推送事件列表 / 视频稿件

用 bili_api_spec {ref:"#num"} 看参数。
```

看到类似的就说明通了。

---

## 3. 凭据：两套体系，别混

这是本项目最容易踩的坑。**开放平台**和**主站 Web** 是两套完全独立的认证：

| | 开放平台 | 主站 Web |
| --- | --- | --- |
| 用什么 | `client_id` + `app_secret` + `access_token` | 浏览器 `Cookie`（`SESSDATA` / `bili_jct`） |
| 从哪来 | [open.bilibili.com](https://open.bilibili.com) 控制台，需**实名认证 + 开发者入驻** | 浏览器登录 bilibili.com 后导出 cookie |
| 认证方式 | HMAC-SHA256 签名（`x-bili-*` 头 + `access-token`） | 直接带 `Cookie` 头（POST 补 `csrf`） |
| 存哪 | `secrets/open-platform.json`（`BILI_CRED_FILE`） | `secrets/cookies.json`（`BILI_COOKIE_FILE`） |
| 工具 | `bili_api_*` / `bili_oauth` / `bili_upload_plan` | `bili_cookie` / `bili_web_call` |

**Cookie 里永远没有 `client_id` / `app_secret` / `access_token`** —— 这三个不是 cookie，
任何 cookie 导出插件都拿不到。反过来，`SESSDATA` 也换不来开放平台的 `access_token`。两边不能互填。

### 3.1 拿开放平台凭据

1. 登录 <https://open.bilibili.com> → **实名认证**
2. 完成**开发者入驻**
3. **应用管理 → 创建应用**，类型选「网页应用」
4. 授权回调域填一个你能接住的地址，例如 `http://127.0.0.1:8848/callback`
5. 记下 `Client ID` 与 `Secret`
6. 一键跑完授权回环（自动起本地服务抓 `code` → 换 `token` → 落盘）：

```bash
npm run login -- --client-id <ClientID> --secret <Secret>
```

跑完 `secrets/open-platform.json` 里就有 `accessToken` 了，`bili_api_call` 立刻能发真实请求。

**不用命令行也行**，直接对 AI 说：

```
bili_oauth { "action": "authorize-url", "gourl": "http://127.0.0.1:8848/callback" }
```

拿回授权链接 → 浏览器点同意 → 从回调地址里抠出 `code`：

```
bili_oauth { "action": "exchange", "code": "<code>" }
```

`exchange` 成功后会自动把 token 写进 `secrets/open-platform.json`。
`refresh_token` 是**一次性的**，续期用：

```
bili_oauth { "action": "refresh" }
```

> 授权页地址格式（来自「接入指引 / 网页应用接入」）：
>
> ```
> https://account.bilibili.com/pc/account-pc/auth/oauth?client_id=<ClientID>&gourl=<urlencoded 回调地址>&state=<随机串>
> ```
>
> `gourl` 与应用里配的「授权回调域」不一致会报「不合法的授权请求」。

### 3.2 拿主站 Cookie

1. 浏览器登录 <https://www.bilibili.com>
2. F12 → `Application → Cookies → https://www.bilibili.com`
3. 用 EditThisCookie 之类的插件导出，或手动复制

然后导入（三种格式都收）：

```
// EditThisCookie 数组
bili_cookie { "action": "import", "jar": [{ "name": "SESSDATA", "value": "…" }, { "name": "bili_jct", "value": "…" }] }

// {name: value} 对象
bili_cookie { "action": "import", "jar": { "SESSDATA": "…", "bili_jct": "…" } }

// "k=v; k=v" 字符串
bili_cookie { "action": "import", "jar": "SESSDATA=…; bili_jct=…" }
```

导入后马上验证：

```
bili_cookie { "action": "whoami" }
```

也可以用环境变量临时注入，不落盘：

```bash
BILI_COOKIE="SESSDATA=…; bili_jct=…"
```

> **`SESSDATA` 等同于账号登录凭证，泄露它等于交出账号。**
> 工具默认对所有凭据脱敏（`SESSDATA` 显示成 `abcdef…wxyz [len=124]`），
> 只有显式传 `reveal:true` 才会输出原值。不要往截图、Issue、对话里贴。

### 3.3 环境变量总表

| 变量 | 含义 | 备注 |
| --- | --- | --- |
| `BILI_CLIENT_ID` | 应用 client_id（= `x-bili-accesskeyid`） | 别名 `BILI_ACCESS_KEY_ID` |
| `BILI_APP_SECRET` | 应用 secret | 别名 `BILI_SECRET` |
| `BILI_ACCESS_TOKEN` | OAuth2 access_token | 别名 `BILI_TOKEN` |
| `BILI_COOKIE_FILE` | 主站 Cookie jar 路径 | 覆盖默认解析 |
| `BILI_CRED_FILE` | 开放平台凭据文件路径 | 覆盖默认解析 |
| `BILI_COOKIE` | 直接给 Cookie 字符串 | 不写文件 |

**开放平台凭据的解析顺序**：显式参数 → 环境变量 → `secrets/open-platform.json`。
用 `bili_oauth {action:"status"}` 能看清每一格到底有没有、**从哪来**（会标 `参数` / `环境变量 xxx` / `文件 clientId`）。

### 3.4 凭据文件放在哪

查找顺序：

1. 工具入参（`bili_cookie` 的 `file`）
2. 环境变量 `BILI_COOKIE_FILE` / `BILI_CRED_FILE`
3. **包目录**的 `secrets/<文件名>`（存在就用）
4. **启动方 cwd** 的 `secrets/<文件名>`（存在就用）
5. 都没有 → 用**包目录**的路径（写入也落在这里）

**放包目录下的 `secrets/` 最稳。** MCP 客户端是用它自己的项目目录当 cwd 拉起服务的，
只按 cwd 找会一直显示「文件不存在」。

```bash
# 想放别处，就给绝对路径
BILI_CRED_FILE=C:/my-creds/open-platform.json
BILI_COOKIE_FILE=C:/my-creds/cookies.json
```

`secrets/` 整个目录在 `.gitignore` 里。**不要把它提交到任何仓库。**

---

## 4. 工具详解（19 个）

分五组：**找文档 → 看懂接口 → 生成/发请求 → 专题能力 → 主站 Web**。

### 4.1 找文档（4 个）

#### `bili_docs_list` —— 按目录或类型浏览

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `folder` | string | | 目录名**包含匹配**，如 `视频稿件` / `交易电商` / `消息推送` |
| `type` | enum | | `api` \| `guide` \| `event` \| `protocol` \| `multi-api` |
| `limit` | int | | 默认 60 |

```
bili_docs_list { "folder": "视频稿件" }
bili_docs_list { "type": "event", "limit": 100 }
```

共 170 篇：95 篇单接口 + 2 篇多接口（合 100 个端点）、41 个推送事件、30 篇指南、2 篇协议说明。

#### `bili_docs_search` —— 全文检索

先按标题/目录/摘要命中，再回退全文。返回的 `ref(#num)` 可以直接喂给 `bili_api_spec` / `bili_docs_get`。

```
bili_docs_search { "query": "upload_token" }
bili_docs_search { "query": "refresh_token", "limit": 5 }
```

#### `bili_docs_get` —— 读原文

```
bili_docs_get { "ref": "#12" }
bili_docs_get { "ref": "视频稿件提交", "maxChars": 8000 }
```

`maxChars` 默认 40000。真实输出：

```
doc: #12  id: f7fc57dd-55a1-5cb1-cba4-61fb2994bf0f  type: api  folder: 开放能力 / 视频稿件管理 / 服务端视频稿件投递  bytes: 3506
(截断到 500/2736 字符，需要更多请提高 maxChars)

---

# 视频稿件提交

Scope: `ARC_BASE`   <font color="green">需要申请权限</font>   <font color="red">需要用户授权</font>
...
```

#### `bili_endpoints` —— 按维度筛端点

比全文搜索准，适合「所有需要 `SHOP_ORDER_INFO` 的 POST 接口」这类问题。

| 参数 | 说明 |
| --- | --- |
| `method` | `GET` / `POST` / `PUT` / `DELETE` / `PATCH` |
| `scope` | 权限点，如 `ARC_BASE` |
| `host` | `member.bilibili.com` / `openupos.bilivideo.com` / `api.bilibili.com` |
| `pathContains` | 路径或标题关键词 |
| `limit` | 默认 40 |

```
bili_endpoints { "scope": "ARC_BASE", "method": "POST" }
```

```
命中 9 条，显示前 3

#8 POST /arcopen/fn/archive/video/init ⟨member.bilibili.com⟩  [ARC_BASE]  文件上传预处理
#9 POST /video/v2/part/upload ⟨openupos.bilivideo.com⟩  [ARC_BASE]  文件分片上传
#10 POST /arcopen/fn/archive/video/complete ⟨member.bilibili.com⟩  [ARC_BASE]  文件分片合片
```

### 4.2 看懂接口（5 个）

#### `bili_quickstart` —— 先读这一篇

无参数。一次讲清：主机、OAuth2 全流程、2.0 签名算法、通用返回结构、错误码分段、投稿技术限制。
**第一次用、或者要写对接代码之前先调它。**

#### `bili_api_spec` —— 结构化规格

参数用**接口 URL** 或 `ref` 定位：

```
bili_api_spec { "ref": "#12" }
bili_api_spec { "url": "https://member.bilibili.com/arcopen/fn/archive/add-by-utoken" }
```

真实输出：

```
# 视频稿件提交  [api]
doc: #12  id: f7fc57dd-55a1-5cb1-cba4-61fb2994bf0f  file: 012_视频稿件提交.md
folder: 开放能力 / 视频稿件管理 / 服务端视频稿件投递
scope: ARC_BASE
POST https://member.bilibili.com/arcopen/fn/archive/add-by-utoken

## url 参数
- upload_token (string, 必填): 通过文件上传预处理(upload_token)授权获取

## body 参数
- title (string, 必填): 稿件标题，长度小于80，短时间内标题不能相同
- cover (string, 可选): 封面地址，必须由上传封面接口得到
- tid (int, 必填): 分区id，由获取分区信息接口得到
- no_reprint (int, 可选): 是否允许转载 0-允许，1-不允许。默认0
- desc (string, 可选): 视频描述，长度小于250
- tag (string, 必填): 视频标签，多个标签用英文逗号分隔，总长度小于200
- copyright (int, 必填): 1-原创，2-转载(转载时source必填)
- source (string, 可选): 如果copyright为转载，则此字段表示转载来源
...
```

#### `bili_api_prepare` —— 提交前先验一遍

按文档类型做转换（`int`→数字、`bool`→布尔、`[]x`→数组），查必填缺失、查多传字段。

```
bili_api_prepare { "ref": "#12", "body": { "title": "x" } }
```

````
# 视频稿件提交  (#12)
POST https://member.bilibili.com/arcopen/fn/archive/add-by-utoken
## query 缺必填
- upload_token (string) 通过文件上传预处理(upload_token)授权获取
## body 缺必填
- tid (int) 分区id，由获取分区信息接口得到
- tag (string) 视频标签，多个标签用英文逗号分隔，总长度小于200
- copyright (int) 1-原创，2-转载(转载时source必填)
## 最终 query
```json
{}
```
## 最终 body
```json
{"title":"x"}
```
## 下一步
- 真调: bili_api_call { "ref": "12", "query": ..., "body": ... }
- 看签名: bili_api_sign { "url": "https://member.bilibili.com/arcopen/fn/archive/add-by-utoken", "body": ... }
````

#### `bili_scopes` —— 确认要申请哪些权限

```
bili_scopes { }                              // 20 个 scope 全览
bili_scopes { "scope": "SHOP_ORDER_INFO" }   // 该 scope 下的端点
bili_scopes { "ref": "#12" }                 // 该接口要什么 scope
```

```
共 20 个 scope，94 个端点带标注:

- ATC_BASE: 14 个端点  (例: #21 文章提交)
- ARC_BASE: 12 个端点  (例: #8 文件上传预处理)
- SHOP_COMMODITY_INFO: 10 个端点  (例: #68 商品发布)
- SHOP_LOGISTICS_INFO: 10 个端点  (例: #86 发货回调)
...
- UPOWER_ORDER_DATA: 1 个端点  (例: #110 查询充电记录)
```

**创建应用时申请错了，后面所有调用都是权限错误**，先查这里。

#### `bili_error_lookup` —— 错误码

```
bili_error_lookup { "code": "4002" }
```

```
4002: 签名异常
```

前缀模糊查询（4 位前缀列出该模块全部码）：

```
bili_error_lookup { "code": "1230", "fuzzy": true }
```

共 118 个错误码，分「通用 / OAuth / 视频稿件 / 直播 / 电商 / 充电」等段。

### 4.3 生成与发送（5 个）

#### `bili_codegen` —— 生成可运行代码

| 参数 | 说明 |
| --- | --- |
| `ref` | 必填，`#num` / 标题 / 接口 URL |
| `lang` | `python`(默认) \| `node` \| `curl` \| `java` \| `php` \| `go`，另有 `bash` |

```
bili_codegen { "ref": "#12", "lang": "python" }
```

生成的东西**包含完整 2.0 签名实现**——必填参数直接写进代码，可选参数注释掉，带返回码处理：

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
接口: 视频稿件提交  (doc #12)
POST https://member.bilibili.com/arcopen/fn/archive/add-by-utoken
scope: ARC_BASE
由 bili-open-mcp 生成；TODO 处需填真实值，未执行的步骤请自行补齐
"""
import hashlib, hmac, json, os, time, urllib.parse, urllib.request, uuid

CLIENT_ID = os.environ.get("BILI_CLIENT_ID", "YOUR_CLIENT_ID")
...
```

**自己手拼签名极容易错**，优先用它。

#### `bili_api_sign` —— 只看签名，不发请求

```
bili_api_sign { "url": "https://member.bilibili.com/arcopen/fn/archive/video/param", "query": { "a": 1 } }
```

```
## 待签名串
x-bili-accesskeyid:YOUR_CLIENT_ID
x-bili-content-md5:d41d8cd98f00b204e9800998ecf8427e
x-bili-signature-method:HMAC-SHA256
x-bili-signature-nonce:b8cdd7f4-cd3d-4f08-ac68-856bd82b7f05
x-bili-signature-version:2.0
x-bili-timestamp:1793433370
## 请求头
Accept: application/json
Content-Type: application/json
Authorization: 762e736a5a8970abbc7d63b7329ebd7d975c5007c275a0be6adff0884f6139af
X-Bili-Accesskeyid: YOUR_CLIENT_ID
X-Bili-Content-Md5: d41d8cd98f00b204e9800998ecf8427e
...
## curl
curl --location --request GET 'https://member.bilibili.com/arcopen/fn/archive/video/param?a=1' \
--header 'Accept: application/json' \
--header 'Content-Type: application/json' \
...
```

没配凭据时会用 `YOUR_CLIENT_ID` / `YOUR_ACCESS_TOKEN` 占位，
**签名结构是真的，值要你填** —— 拿去对照自己的实现排错正合适。

#### `bili_api_call` —— 真发请求

```
bili_api_call { "ref": "#12", "query": { "upload_token": "…" }, "body": { … } }
bili_api_call { "ref": "#12", "dryRun": true }        // 只看将要发的请求
bili_api_call { "url": "https://member.bilibili.com/arcopen/fn/archive/video/param", "method": "GET" }
```

`dryRun:true` 的真实输出：

````
## dryRun — 未发送
```
curl --location --request POST 'https://member.bilibili.com/arcopen/fn/archive/add-by-utoken' \
--header 'Accept: application/json' \
--header 'Content-Type: application/json' \
--header 'Authorization: c0fdbe2094f5b288432f2d02374126735f4d19e266f26fb4ac70d663a5dff271' \
--header 'X-Bili-Accesskeyid: YOUR_CLIENT_ID' \
--header 'X-Bili-Content-Md5: d41d8cd98f00b204e9800998ecf8427e' \
--header 'X-Bili-Signature-Method: HMAC-SHA256' \
--header 'X-Bili-Signature-Nonce: 8bb260eb-b578-4f3d-8aac-35b63c811bf4' \
--header 'X-Bili-Signature-Version: 2.0' \
--header 'X-Bili-Timestamp: 1793433370' \
--header 'Access-Token: YOUR_ACCESS_TOKEN'
```
````

**先用 `dryRun` 看一遍再真调**，尤其写操作。

#### `bili_upload_plan` —— 投稿分片计划

给文件大小，算单文件还是分片、分几片、每片 offset、`part_number` 起止，并给出完整调用顺序。

```
bili_upload_plan { "fileSizeMB": 250 }
bili_upload_plan { "fileSizeBytes": 314572800, "chunkMB": 10, "filename": "video.mp4" }
```

```
# 投稿上传计划
文件: video.mp4  250.0 MB
模式: 分片（10MB/片，utype=0）
分片数: 25，请求数: 28

## 调用顺序
1. POST /arcopen/fn/archive/video/init          body {"name":"video.mp4","utype":"0"}  → upload_token
2. POST https://openupos.bilivideo.com/video/v2/part/upload?upload_token=<token>&part_number=N   body=裸分片字节  ×25
3. POST /arcopen/fn/archive/video/complete        url upload_token=<token>
4. POST /arcopen/fn/archive/add-by-utoken   url upload_token=<token>   body 见 #12

## 分片表
| part_number | 起始 offset | 结束 offset | 字节数 |
| --- | --- | --- | --- |
| 1 | 0 | 10485759 | 10485760 |
| 2 | 10485760 | 20971519 | 10485760 |
...
```

注意第 2 步走的是 `openupos.bilivideo.com`，**裸二进制、不带签名头**，靠 url 上的 `upload_token` 鉴权。

#### `bili_mock` —— 官方沙盒

不需要凭据（但应用仍需已申请对应 scope）。

```
bili_mock { "action": "list" }                       // 43 个 mock 接口
bili_mock { "action": "map", "ref": "12" }           // 正式接口 → mock 地址
bili_mock { "action": "call", "mockUrl": "https://member.bilibili.com/mock/arcopen/fn/archive/add" }
```

**mock 路径与正式路径不总一致**，务必先 `map` 换算。例如：

| 正式 | mock |
| --- | --- |
| `/arcopen/fn/archive/video/init` | `/mock/video/part/init` |
| `/arcopen/fn/archive/video/upload` | `/mock/video/part/upload` |
| `/arcopen/fn/archive/video/complete` | `/mock/video/part/complete` |

### 4.4 专题能力（4 个）

#### `bili_oauth`

| action | 作用 |
| --- | --- |
| `help`（默认） | 讲清整条链路 |
| `status` | 看 clientId / secret / token 各自有没有、**从哪来** |
| `authorize-url` | 拼授权页链接（`gourl`、`state`） |
| `exchange` | `code` → `access_token`（自动落盘） |
| `refresh` | 续期（`refresh_token` **只能用一次**） |

#### `bili_webhook` —— 41 个推送事件

| action | 作用 |
| --- | --- |
| `list`（默认） | 41 个事件按模块分组 |
| `detail` | 某个事件的内容字段，`ref` 传 `#num` 或事件名 |
| `verify-code` | 生成验签 + 应答代码（`python` / `node`） |
| `notes` | 配置与校验说明 |

```
bili_webhook { "action": "detail", "ref": "164" }
bili_webhook { "action": "verify-code", "lang": "node" }
```

验签要点（**最容易错的地方**）：

```
1. 取收到的原始 body 字节，拼 app_secret + body 做 SHA1
2. 与请求头 x-bilibili-signature 比对
⚠ 必须用原始字节，不要重新序列化 —— 重排 key 会验签失败
```

平台配置回调时会先发一次校验请求：

```json
{ "event": "verify_webhooks", "content": { "data": 1371848576 }, "timestamp": "2021-01-01 12:01:01" }
```

要**原样**回 `{"data": 1371848576}`。失败最多重试 3 次（连接超时 5s），**业务侧必须幂等去重**。

#### `bili_ws_protocol` —— 直播间长连

```
bili_ws_protocol { }
bili_ws_protocol { "code": "python" }   // 额外生成内联 Python 客户端
```

```
# 直播间长连协议（文档 #43 / #44 / #45 / #46）

## 建立流程
1. POST /arcopen/fn/live/room/ws-start  (scope LIVE_ROOM_DATA)
   → data.conn_id, data.websocket_info.wss_link[], data.websocket_info.auth_body
2. 连 wss_link[0]，第一个包必须是 OP_AUTH(7)，body = auth_body（JSON 字符串，UTF-8）
3. 每 30s 发 OP_HEARTBEAT(2)，body 为空
4. 服务端推 OP_SEND_SMS_REPLY(5) 即消息；OP_HEARTBEAT_REPLY(3) 是心跳回执

## 包头（16 字节，全大端）
  Packet Length uint32   # 含 header 的总长
  Header Length uint16   # 固定 16
  Version       uint16   # 0=body 为明文, 2=body 为 zlib 压缩
  Operation     uint32   # 见下表
  Sequence ID   uint32   # 保留字段，可忽略
  Body          bytes
```

完整的可跑客户端在 [`examples/live_ws.py`](examples/live_ws.py)（含 zlib 多包拆解）。

### 4.5 主站 Web（2 个）

主站走 Cookie，**不走 2.0 签名**，两套体系互不通用。

#### `bili_cookie`

| action | 作用 |
| --- | --- |
| `status`（默认） | 列关键 cookie 与过期时间 |
| `whoami` | 验证登录态 |
| `import` | 收 EditThisCookie 数组 / `{name:value}` / `"k=v; k=v"` |
| `set` | 设单个（`name` / `value`） |
| `clear` | 清空 |
| `export` | 导出 |

`reveal:true` 才显示原值，默认脱敏。

#### `bili_web_call`

```
bili_web_call { "path": "x/web-interface/nav" }
bili_web_call { "path": "x/relation/modify", "method": "POST", "form": { "fid": 123, "act": 5, "re_src": 11 } }
bili_web_call { "url": "https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD" }
```

| 参数 | 说明 |
| --- | --- |
| `path` | 如 `x/web-interface/nav`，默认拼到 `https://www.bilibili.com` |
| `url` | 完整 URL，给了就忽略 `path` |
| `method` | `GET` / `POST`，默认 GET（有 `form` 则 POST） |
| `query` | url 参数 |
| `form` | 表单参数，**自动补 `csrf=bili_jct`** |
| `body` | JSON body |
| `wbi` | 强制开关 wbi 签名；留空按路径自动判断 |
| `dryRun` | 只看请求 |
| `maxBytes` | 响应截断，默认 60000 |

`dryRun` 输出：

````
## dryRun — 未发送
```
GET https://www.bilibili.com/x/web-interface/nav

请求头:
  User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36
  Referer: https://www.bilibili.com/
  Accept: application/json, text/plain, */*
```

jar: C:\path\to\bili-open-mcp\secrets\cookies.json（0 个 cookie）
````

自动补的请求头：`Cookie`、`User-Agent`（桌面 Chrome）、`Referer: https://www.bilibili.com/`。

### 4.6 wbi 签名

2023 起 `/x/space/wbi/*`、`/x/polymer/*`、`/x/v2/reply/wbi/*` 这些要 **wbi 签名**。
`bili_web_call` 按路径自动判断（`/wbi/`、`/polymer/` 等命中），也可以用 `wbi:true/false` 强制。

算法（`src/wbi.mjs`）：

1. 从 `/x/web-interface/nav` 的 `data.wbi_img` 取 `img_key` / `sub_key`
2. 按固定重排表拼出 32 位 `mixin_key`
3. 参数按字典序 → 去掉 `!'()*` → urlencode → 末尾接 `mixin_key` → md5 = `w_rid`
4. 请求带上 `wts` + `w_rid`

实测：

- `/x/space/wbi/acc/info?mid=<uid>` 带签名 → `code:0`；`wbi:false` → `-403 访问权限不足`
- 坑：`/x/space/wbi/arc/search`（投稿列表）现在**直接 `-403`**，补 `dm_img_list`/`dm_img_str`/`dm_img_inter`
  三件套也没用；**旧路径 `/x/space/arc/search` 仍然 `code:0` 可用**

### 4.7 资源与提示

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| resource | `bili://catalog` | 170 篇压成的一页纸清单（`data/llms.txt`） |
| resource template | `bili://doc/{ref}` | 单篇文档原文 Markdown |
| prompt | `integrate-bili-api` | 按开放平台规范生成接入任务说明（参数 `ref`） |

---

## 5. 端到端工作流

### 流程 A：从"我要投稿"到能跑的代码（不需要凭据）

```
你   ：我想用开放平台投稿视频，帮我理一遍。
AI   ：bili_docs_search { "query": "投稿" }
       → bili_api_spec { "ref": "#12" }
       → bili_scopes { "ref": "#12" }          // 需要申请 ARC_BASE
       → bili_upload_plan { "fileSizeMB": 250 } // 分片计划
       → bili_codegen { "ref": "#12", "lang": "python" }
```

### 流程 B：真调一个只读接口（需要开放平台凭据）

```
bili_oauth  { "action": "status" }                          // 先确认凭据在
bili_api_prepare { "ref": "#4" }                            // 查必填
bili_api_call { "ref": "#4", "dryRun": true }               // 看请求
bili_api_call { "ref": "#4" }                               // 真发
bili_error_lookup { "code": "<返回的 code>" }                // 非 0 就查
```

### 流程 C：完整投稿

```
1. bili_upload_plan { "fileSizeMB": 250 }                    // 拿调用顺序与分片表
2. POST /arcopen/fn/archive/video/init          → upload_token
3. POST openupos.bilivideo.com/video/v2/part/upload?upload_token=…&part_number=N   ×25   （裸二进制）
4. POST /arcopen/fn/archive/video/complete
5. POST /arcopen/fn/archive/add-by-utoken       （body 见 #12）
6. 收 Webhook「投稿成功 / 投稿失败」事件（bili_webhook {action:"detail", ref:"…"}）
```

### 流程 D：用主站 Cookie 做只读查询

```
bili_cookie { "action": "import", "jar": "SESSDATA=…; bili_jct=…" }
bili_cookie { "action": "whoami" }
bili_web_call { "path": "x/web-interface/nav" }
bili_web_call { "path": "x/space/wbi/acc/info", "query": { "mid": 2 } }   // 自动 wbi 签名
```

### 流程 E：接直播间长连

```
bili_ws_protocol { }                       // 先读协议
bili_api_call { "url": "https://member.bilibili.com/arcopen/fn/live/room/ws-start", "method": "POST" }
→ python examples/live_ws.py --conn-id <id> --auth-body '<auth_body>' --wss 'wss://…'
```

### 流程 F：接 Webhook 推送

```
bili_webhook { "action": "list" }                       // 选事件
bili_webhook { "action": "detail", "ref": "164" }       // 看字段
bili_webhook { "action": "verify-code", "lang": "python" }   // 拿验签代码
```

---

## 6. 报错与排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 客户端里看不到工具 | 路径写错 / Node < 18 / 没重启客户端 | `node src/server.mjs` 手动起一次；`npm run selftest`；完全退出客户端再开 |
| 一直显示「凭据文件不存在」 | 客户端用**它自己的项目目录**当 cwd | 把 `secrets/` 放在包目录下（本版已支持），或给 `BILI_CRED_FILE` 绝对路径 |
| `bili_api_call` 返回 `4002 签名异常` | secret 不对 / 时间戳偏移 / body md5 与实际 body 不一致 | 用 `bili_api_sign` 对照**待签名串**，逐行比 |
| 返回 `-352` | 风控 | 降低频率、加设备指纹 cookie；**不要重试轰炸** |
| 返回 `-509` / `12019` | 请求过于频繁 | 退避重试（指数），并发降到 1 |
| 返回 `-111` | `csrf` 失败 | `bili_jct` 过期，重新导入 cookie |
| 返回权限错误 | 应用没申请该 scope | `bili_scopes { "ref": "…" }` 查需要哪个，去控制台申请 |
| `-403 访问权限不足`（主站 wbi） | 漏了 wbi 签名 | 别关 `wbi`，或看 §4.6 的路径现状 |
| Webhook 验签一直失败 | 重新序列化了 body | 用**原始字节**，字段顺序不能动 |
| 长连收到乱码 | `Version=2` 是 zlib | 按 `Packet Length` 循环拆包后分别解压 |
| `bili_upload_plan` 说分片，实际失败 | 分片走的是 openupos 裸二进制 | 不要加签名头，用 url 上的 `upload_token` |
| 投稿 `code` 非 0 但说不清 | 分区分片等限制 | `bili_quickstart` 有投稿技术限制一节 |

**通用第一步**：任何报错都先 `bili_error_lookup { "code": "<code>" }`。

---

## 7. 数据从哪来 / 怎么更新

`data/` 由 `scripts/build-spec.mjs` 从 Markdown 生成，Markdown 来自开放平台的目录接口：

```
GET https://open.bilibili.com/arcopen/user/open-doc/view?id=4
```

`data.online_doc` 是整棵目录树，每个 Article 节点带 `md_url`。文档更新后：

```bash
npm run build     # 重新解析
npm run audit     # 校验一致性
```

规模：

- 文档 **170 篇** = 95 篇单接口 + 2 篇多接口（共 **100 个端点**）+ 41 个推送事件 + 30 篇指南 + 2 篇协议说明
- **1243 个参数对象，100% 带类型**；359/364 个请求参数带「必传」标记
- **20 个 scope、118 个错误码、43 个沙盒 mock 接口**

---

## 8. 免责声明

**使用本项目前请先读全文：[DISCLAIMER.md](DISCLAIMER.md)。** 摘要（各条完整表述见原文）：

1. **接口来源**：本项目调用的所有接口均为**哔哩哔哩官方提供并公开的接口**
   （开放平台文档 / 官方业务域名 / 官方 OAuth2 / 官方上传域名 / 官方直播间长连协议 / 官方 Webhook 规范），
   不含私有接口、破解接口或绕过鉴权的实现。
2. **无隶属关系**：第三方项目，与哔哩哔哩（上海幻电信息科技有限公司 / 上海宽娱数码科技有限公司）没有隶属、赞助、合作或背书关系。
3. **凭据自备、缺失即功能受限**：不内置、不收集、不上传任何凭据；没有 `BILI_COOKIE_FILE` 和
   `BILI_CRED_FILE` 时，开放平台接口与主站 Web 接口**全部不可用**（见 [§0](#0-先确认你能用哪些功能)）。
4. **账号安全**：`SESSDATA` 等同登录凭证，泄露即交出账号；勿在日志、截图、Issue、对话中暴露。
5. **使用者责任**：遵守用户协议、社区公约、开放平台开发者协议与当地法律；**本项目不做自动限速，
   节流责任在调用方**，滥用会导致**你自己的账号**被限流或封停。
6. **无担保**：按"现状"提供，官方接口随时可能变更，不承担因使用本项目造成的任何损失。
7. **数据为快照**：`data/` 是某一时点抓取的结构化快照，**一切以官方文档与实际返回为准**；
   生成的代码是骨架，边界条件与错误处理需自行补齐测试。
8. **隐私**：本地服务，**无遥测、无上报**；但通过 AI 客户端使用时，你发送的内容与工具返回值会经过该客户端与模型提供方。
9. **不构成法律/合规建议**；第三方依赖（`@modelcontextprotocol/sdk`、`zod`）请自行评估。
10. **下架通道**：权利人如认为本仓库内容侵犯权益，开 Issue 或联系仓库所有者，会尽快处理。
