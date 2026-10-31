# AGENTS.md — 给 AI 的使用契约（详细版）

本目录是哔哩哔哩开放平台的 MCP 服务 + 结构化接口库 + 可运行示例。

**第一原则：不要凭记忆猜 B 站开放接口。** 一切以本仓库的 `data/` 与仓库根目录的 `*.md` 为准。
文档没写的字段不要编，不确定就在回答里标「文档未说明」。

**文档地图**：`USAGE.md` 是给人看的操作手册（安装、接入各客户端、19 个工具的入参与真实输出、报错排查表）；
本文件是给你（AI）的契约与决策树；`DISCLAIMER.md` 是接口来源、能力边界与免责条款。
**用户问「怎么装 / 怎么接 / 这个工具怎么用 / 报错怎么办」→ 直接引 `USAGE.md` 的对应小节。**

**接口来源与凭据**：本项目调用的接口全部是官方公开提供的（开放平台文档 / 开放平台域名 / 主站 Web
接口 / 官方直播间长连），不含私有或绕过鉴权的实现。凭据由使用者自备：没有 `BILI_COOKIE_FILE`
（`secrets/cookies.json`）→ `bili_cookie` / `bili_web_call` 不可用；没有 `BILI_CRED_FILE`
（`secrets/open-platform.json`）→ 开放平台那套接口不可用；两者都没有时只剩文档检索、错误码、
代码生成、沙盒 mock 与签名演示。详见 [DISCLAIMER.md](DISCLAIMER.md)。

**凭据文件位置**：`secrets/` 的解析顺序是 显式参数 → 环境变量 → 包目录 → **启动方 cwd**，
写入固定落在包目录。MCP 客户端是用它自己的项目目录当 cwd 拉起服务的 ——
用户说「凭据文件不存在」时，让他把文件放到包目录的 `secrets/` 下，或给
`BILI_COOKIE_FILE` / `BILI_CRED_FILE` 绝对路径（详见 `USAGE.md §3.4`）。
**不要**因为读不到凭据就断定用户没配，先确认路径。

---

## 1. 这份数据是什么

| 项 | 值 |
| --- | --- |
| 来源 | `https://open.bilibili.com/doc/4`（开放平台「开放能力」目录） |
| 抓取入口 | `GET https://open.bilibili.com/arcopen/user/open-doc/view?id=4` → `data.online_doc` |
| 文档数 | 170 篇（`001_…md` ~ `170_…md`，同级目录） |
| HTTP 接口 | 95 篇单接口文档 + 2 篇多接口文档（#1 含 2 个、#84 含 3 个端点）→ **合计 100 个端点** |
| 推送事件 | 41 个（Webhook） |
| 错误码 | 118 条 |
| 文档类型 | `api` 95 · `event` 41 · `guide` 30 · `protocol` 2 · `multi-api` 2 |
| 参数对象 | 1243 个，**全部带 `type`**；359/364 个请求参数带 `required` |
| 生成时间 | 见 `data/index.json.generatedAt` |

`ref` 的规则：`#num` 就是文件名前缀。`#12` ⇔ `012_视频稿件提交.md` ⇔ `data/index.json` 里 `num=12` 的那条。

---

## 2. 核心概念

| 名称 | 含义 | 出处 |
| --- | --- | --- |
| `client_id` | 应用标识，即签名头 `x-bili-accesskeyid` | 申请应用时分配 |
| `app_secret` | 应用密钥，HMAC 的 key；**只用于签名，不随请求发送** | 同上 |
| `access_token` | 用户授权的访问凭证，放 `access-token` 头，有有效期 | OAuth2 换取 |
| `refresh_token` | 续期令牌，**一次性的**，用过即废 | OAuth2 换取 |
| `scope` | 接口权限点，如 `ARC_BASE`；应用要申请、用户要勾选 | 每篇接口文档首行 |
| `open_id` | 「开发者 × 应用」维度唯一的用户 ID，替代 uid 外显（合规） | 用户接口返回 |
| `union_id` | 同一开发者下**多应用通用**的用户 ID | `POST /user/account/union_id` |
| `mid` | B 站用户 uid，部分接口用它，注意 127003「缺少 mid 或 mid 不匹配」 | — |
| `biz_code` | 业务线标识，部分投稿接口的权限按 biz_code 配置 | #15 |
| `upload_token` | 文件上传预处理拿到的凭证，后续分片/合片/提交都靠它 | #8 |

### 全部 scope（20 个，按出现次数）

`SHOP_COMMODITY_INFO`(22) · `SHOP_AFTERSALES_INFO`(19) · `SHOP_ORDER_INFO`(18) ·
`ATC_BASE`(14) · `ARC_BASE`(12) · `SHOP_BA_CHAT`(10) · `SHOP_LOGISTICS_INFO`(10) ·
`USER_INFO`(7) · `LIVE_ROOM_DATA`(6) · `SHOP_TICKET_ORDER_DATA`(5) · `COURSE_ORDER_DATA`(3) ·
`COPYRIGHT_MUSIC_DATA`(3) · `ARC_DATA`(2) · `ATC_DATA`(2) · `SHOP_STOCK_INFO`(2) ·
`USER_DATA`(1) · `LIVE_STREAM_DATA`(1) · `SHOP_STORE_INFO`(1) · `SHOP_LIVE_COMMERC_DATA`(1) ·
`UPOWER_ORDER_DATA`(1)

140 篇文档带 scope 标注。`scripts/audit.mjs` 会把这份白名单与数据比对，出现新 scope 会报错。

新增 scope 后，**已授权的老用户不会自动获得**，必须引导其重新授权并勾选，否则报 127011。

---

## 3. 主机与路径约定

| 主机 | 用途 | 数量 |
| --- | --- | --- |
| `https://member.bilibili.com` | 几乎所有业务接口 | 87 |
| `https://openupos.bilivideo.com` | 视频分片上传 / 单文件上传（**裸二进制，无签名**） | 2 |
| `https://api.bilibili.com` | OAuth2 换 token / 刷新 | 1 |

路径前缀：

- `/arcopen/fn/...` — 主要业务前缀
- `/liveopen/fn/live/thirdPartyLive/...` — 一键开播（#50/#52/#53），注意不是 `/arcopen`
- `/mock/...` — 沙盒环境，见 §11

---

## 4. 数据文件 schema

### `data/index.json`

```jsonc
{
  "generatedAt": "…", "source": "https://open.bilibili.com/doc/4", "docRoot": "<文档 Markdown 所在目录>",
  "totals": { "docs": 170, "api": 95, "withBodyParams": 71, "withResponseParams": 72 },
  "docs": [
    {
      "num": 12,                    // ref
      "id": "f7fc57dd-…",           // 平台 uuid
      "title": "视频稿件提交",       // 取自目录名（官方接口名）
      "h1": "…",                    // 仅当文档内 H1 与目录名不同时才有
      "file": "012_视频稿件提交.md",
      "folder": "开放能力 / 视频稿件管理 / 服务端视频稿件投递",
      "path": "开放能力 / 视频稿件管理 / 服务端视频稿件投递 / 视频稿件提交",
      "type": "api",                // api | guide | event | protocol | multi-api | missing
      "scopes": ["ARC_BASE"],
      "signVersion": "1.0",         // 仅有：文档标注非 2.0 的接口（目前只有 #16）
      "url": "https://member.bilibili.com/arcopen/fn/archive/add-by-utoken",
      "method": "POST",
      "endpoints": [ … ],           // 仅 multi-api
      "hints": [ … ],               // 解析时发现的坑，见下
      "summary": "调用该接口完成稿件投递 …",
      "urlParams":  [ { "name": "upload_token", "type": "string", "required": true, "desc": "…" } ],
      "bodyParams": [ { "name": "title", "type": "string", "required": true, "desc": "…" },
                      { "name": "episode_id", "type": "int64", "required": true, "desc": "…", "depth": 2 } ],
      "responseParams": [ { "name": "resource_id", "type": "string", "desc": "稿件唯一ID" } ],
      "subSchemas": [ { "title": "common_msg参考字段", "params": [ … ] } ],
      "requestExample": "curl --location …",
      "responseExample": "{ \"code\": 0, … }",
      "bytes": 2965, "lines": 93
    }
  ]
}
```

字段约定：

- `type`：`api` 单接口 / `multi-api` 一篇多接口 / `event` 推送事件 / `protocol` 协议说明 / `guide` 文档。
- `title` 用**目录名**（官方接口名）；文档内 H1 有时只是「简介」「长连说明」，不同才写进 `h1`。
- 参数对象：`{ name, type, required?, desc?, depth? }`。
  - **每个参数都有 `type`**（1243/1243），值按原文，可能是 `string` / `int64` / `struct` / `[]string` / `array<struct>`。
  - `required` **可能缺失**（359/364 有）：文档没写「必传」列时就没有这个字段，**不代表可选**，不要臆测。
  - `depth` 仅嵌套表出现（用 `├─` / `│` 画层级时），1 = 顶层字段。
- `subSchemas`：请求/响应里单独展开的子结构（如 `common_msg参考字段`、`shop_order_list结构体`），
  **不要把它们和主参数混在一起**；`bili_api_spec` 会用 `## 子结构：<title>` 单独列出。
- `hints`：解析阶段发现的使用陷阱，例如「GET 请求但参数列在 body 参数下」「签名版本 1.0」。
- `responseParams` 嵌套字段按原文写法（`area.area_id_name`）或 `depth` 表达，两种都出现过。
- 样例文本截断到 4000 字符。

### `data/llms.txt`

一页纸清单，适合整段喂模型。格式：

```
[#12] api 视频稿件提交 | POST https://member.bilibili.com/arcopen/fn/archive/add-by-utoken | scope=ARC_BASE | …
  desc: 调用该接口完成稿件投递 …
  url: upload_token:string*  ;  body: title:string*, cover:string, tid:int*  ;  resp: resource_id:string
  sub(common_msg参考字段): source:string*, cover:string, title:string, …
  signVersion=1.0
```

`名字:类型*` 里的 `*` 表示必填；`sub(...)` 是子结构；`signVersion=` 只在非 2.0 时出现。

### `data/status-codes.json`

`{ "4002": "签名异常", "127007": "应用无该接口权限", … }`，118 条。

### `data/mock.json`

沙盒环境（#169）的「功能 → mock 地址」表，43 条：

```jsonc
{ "source": "#169 沙盒环境", "host": "https://member.bilibili.com/mock",
  "entries": [ { "group": "视频稿件管理", "feature": "文件上传预处理", "url": "https://member.bilibili.com/mock/video/part/init" } ] }
```

`group` 是 #169 里的小节名，`feature` 是「功能」列原文。注意 **mock 路径与正式路径不总一致**
（正式 `/arcopen/fn/archive/video/init` ↔ mock `/mock/video/part/init`），用 `bili_mock {action:"map"}` 换算。

---

## 5. MCP 工具：决策树与参数

19 个工具（17 个开放平台 + 2 个主站 Cookie/Web）。先看决策树，再看下面的逐条说明（`ref` 一律接受 `#12` / `12` / `012` / uuid / 标题片段 / 接口 URL）。

```
第一次接触        → bili_quickstart {}
不知道接口叫什么  → bili_docs_search {query} / bili_endpoints {pathContains}
想按模块浏览      → bili_docs_list {folder|type}
要确认申请哪些权限 → bili_scopes {}
已知 ref 看参数   → bili_api_spec {ref}
看非接口文档      → bili_docs_get {ref}
要写代码          → bili_codegen {ref, lang}      ← 自己拼签名容易错
参数不确定/要校验 → bili_api_prepare {ref, query, body}
要发请求          → bili_api_sign（出 curl） / bili_api_call（dryRun → 真调）
投稿上传怎么切    → bili_upload_plan {fileSizeMB}
拿 token / 续期   → bili_oauth {action}
接消息推送        → bili_webhook {action}
做直播消息        → bili_ws_protocol {}
沙盒联调          → bili_mock {action}
主站登录态        → bili_cookie {action:"whoami"}
调主站 Web 接口   → bili_web_call {path}
报错码            → bili_error_lookup {code}
```

对应关系速记：**`bili_docs_search` 找 → `bili_api_spec` 看 → `bili_codegen` 写 → `bili_api_prepare` 校验 → `bili_api_call` 发**。

### `bili_quickstart`

无参数。返回主机 / OAuth2 流程 / 签名规则 / 返回结构 / 错误码分段 / 投稿技术限制。
**在写任何对接代码前先调它。**

### `bili_docs_list`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `folder` | string? | 目录包含匹配，如 `视频稿件管理`、`直播能力`、`消息推送`、`电商` |
| `type` | enum? | `api` / `guide` / `event` / `protocol` / `multi-api` |
| `limit` | int? | 默认 60，最大 200 |

返回：`共 N 条` + 每行 `#num [type] 标题` / 缩进行 `METHOD /path · 目录`。

### `bili_docs_search`

| 参数 | 说明 |
| --- | --- |
| `query` | 必填。支持中文、字段名、错误信息，如 `投稿`、`upload_token`、`弹幕`、`refresh_token` |
| `limit` | 默认 8，最大 30 |

打分：标题 100 / url 40 / 目录 30 / scope 25 / 摘要 20 / 正文 5。返回命中原因与正文片段，末尾给出下一步提示。

**技巧**：找「哪个接口能传某字段」直接搜字段名；找「报错什么意思」用 `bili_error_lookup`。

### `bili_docs_get`

| 参数 | 说明 |
| --- | --- |
| `ref` | `#12` / `12` / `012` / uuid / 标题片段 / 文件名 |
| `maxChars` | 默认 40000。超长会截断并明确标注 |

### `bili_api_spec`

| 参数 | 说明 |
| --- | --- |
| `ref` \| `url` | 二选一 |

返回 Markdown：标题、ref/id/file、目录、scope、`METHOD url`、摘要、`## url 参数`、`## body 参数`、`## 响应`、请求/响应样例、`## 调用方式`。
**写代码前必须看这个，不要凭摘要猜字段。**

### `bili_api_sign`

| 参数 | 说明 |
| --- | --- |
| `url` | 必填，完整 URL |
| `method` | 默认 `GET` |
| `query` | 对象，会 urlencode 进 URL |
| `body` | 对象（自动 JSON 序列化）或字符串 |
| `clientId` / `appSecret` / `accessToken` | 覆盖环境变量 |

返回：待签名串、全部请求头、可粘贴 curl、`content_md5`。
无凭据时用 `YOUR_CLIENT_ID` / `YOUR_APP_SECRET` 占位并告警 —— **这是给人看的示意，不要当真去调**。

### `bili_api_call`

| 参数 | 说明 |
| --- | --- |
| `ref` \| `url` | 二选一；`ref` 会自动带上 METHOD 和 URL |
| `method` / `query` / `body` | 同上 |
| `dryRun` | `true` 只生成请求与 curl，不发送 |

无凭据时只有 `dryRun:true` 可用，否则报错 —— 这是预期行为，不要重试。

返回：`httpStatus`、`code`、`message`、`requestId`、`data`、`raw`、`request`。

### `bili_error_lookup`

| 参数 | 说明 |
| --- | --- |
| `code` | `4002` 精确查 |
| `fuzzy` | `true` 时按前缀列出，如 `1270` 列出全部鉴权/限频码 |

---

## 5b. 新增工具（9 个）

### `bili_endpoints`

按条件过滤全部端点，比全文搜索精确。

| 参数 | 说明 |
| --- | --- |
| `method` | `GET`/`POST`/… |
| `scope` | 权限点，如 `SHOP_ORDER_INFO` |
| `host` | `member.bilibili.com` / `openupos.bilivideo.com` / `api.bilibili.com` |
| `pathContains` | 路径或标题关键词 |
| `source` | `open`（默认，开放平台）/ `web`（主站隐藏能力）/ `all`（两边都列） |
| `limit` | 默认 40 |

典型问法：「所有需要 `SHOP_ORDER_INFO` 的 POST 接口」「上传类接口有哪些」→ `{host:"openupos.bilivideo.com"}`。
「举报怎么调」「有哪些写操作」→ `{source:"web", pathContains:"举报"}`。

`source:"web"` 的数据来自 `data/web.json`：112 条主站 Web 隐藏能力（开放平台文档里没有的那些），
每条带方法 / 完整地址 / 参数 / 返回码 / 无 Cookie 实测状态。整块读用 resource `bili://web`，
逐条复核用 `npm run web:probe`。

### `bili_scopes`

| 参数 | 说明 |
| --- | --- |
| 无 | 列出全部 scope 及覆盖端点数 |
| `scope` | 该 scope 下所有端点 |
| `ref` | 该接口的 scope，以及每个 scope 下的其它接口 |

**申请权限前先问它**，避免 127007 / 127011。

### `bili_api_prepare`

| 参数 | 说明 |
| --- | --- |
| `ref` | 必填 |
| `query` / `body` | 待校验的参数对象 |

做的四件事：① 按文档类型转换（`"21"`→`21`、`"true"`→`true`、`"a,b"`→`["a","b"]`）
② 列缺必填 ③ 列多传的字段（文档未列出）④ 把 GET 文档里写在 body 下的参数归到 query。
**注意：它不猜测可选参数的默认值。**

### `bili_codegen`

| 参数 | 说明 |
| --- | --- |
| `ref` | 必填 |
| `lang` | `python` / `node` / `curl` / `java` / `php` / `go`，默认 python |

生成的是**可编译**的骨架：完整签名实现 + 该接口全部参数（必填直接写入、可选注释掉）+ `code != 0` 处理。
参数值留 `TODO`。生成结果在 `npm run selftest` 里会被 `py_compile` / `node --check` 真实编译一遍。

### `bili_upload_plan`

| 参数 | 说明 |
| --- | --- |
| `fileSizeBytes` \| `fileSizeMB` | 二选一 |
| `chunkMB` | 默认 10 |
| `filename` | 默认 `video.mp4` |

输出：单文件还是分片、片数、每片 offset 区间、part_number 起止、完整调用顺序、注意事项。
**回答「这个大文件怎么传」直接用它，别自己算。**

### `bili_oauth`

| action | 说明 |
| --- | --- |
| `help` | 字段、注意事项、以及「授权页 URL 文档未给出」的说明 |
| `exchange` | 传 `code` 真实换取 token |
| `refresh` | 传 `refreshToken` 真实续期（老 refresh_token 立即失效） |

凭据取自参数或 `BILI_CLIENT_ID` / `BILI_APP_SECRET`。返回里会把 `expires_in` 换算成 UTC 时间。

### `bili_webhook`

| action | 说明 |
| --- | --- |
| `list` | 41 个事件按模块分组 + 配置/验签/重试要点 |
| `detail` | 单个事件的内容字段（`ref` 传 `#164` 或事件名） |
| `verify-code` | 生成验签 + `verify_webhooks` 应答代码（`lang` = python/node） |
| `notes` | 只要文字说明 |

验签三条铁律都写进生成代码里了：**原始字节**算 SHA1、`verify_webhooks` 原样回 `data`、重复消息幂等。

### `bili_ws_protocol`

`{code:"python"}` 会在协议说明后附一份内联客户端（含 `pack`/`unpack`/zlib 递归/心跳任务）。

### `bili_mock`

| action | 说明 |
| --- | --- |
| `list` | 43 个 mock 接口按模块分组 |
| `map` | 正式 `ref` → mock 地址（两者路径不总一致） |
| `call` | 真调 mock，只允许 `member.bilibili.com/mock/` 下的地址 |

---

## 5c. 凭据：两套体系，别混

| | 开放平台 | 主站 Web |
| --- | --- | --- |
| 凭据 | `client_id` + `app_secret` + `access_token` | 浏览器 Cookie（`SESSDATA` / `bili_jct`） |
| 来源 | open.bilibili.com 控制台 → 应用管理（需实名 + 开发者入驻） | 登录 bilibili.com 后导出 cookie |
| 认证 | HMAC-SHA256（`x-bili-*` 6 个头） | 直接带 `Cookie` 头 |
| 文件 | `secrets/open-platform.json` | `secrets/cookies.json` |
| 覆盖变量 | `BILI_CRED_FILE` | `BILI_COOKIE_FILE` |
| 工具 | `bili_api_*` / `bili_oauth` / `bili_upload_plan` | `bili_cookie` / `bili_web_call` |

**`client_id` / `app_secret` / `access_token` 不在任何 cookie 里**，导出多少次 cookie 也拿不到；
`SESSDATA` 同样换不来开放平台的 token。

凭据解析顺序：**显式参数 → 环境变量（`BILI_CLIENT_ID` / `BILI_APP_SECRET` / `BILI_ACCESS_TOKEN`）→ 凭据文件**。
`bili_oauth {action:"status"}` 逐格显示「有没有 / 从哪来」。

### 补齐开放平台凭据

```bash
# 控制台建应用（类型选「网页应用」），回调域填 http://127.0.0.1:8848/callback
npm run login -- --client-id <ClientID> --secret <Secret>
```

脚本起本地回调服务 → 打印授权链接并自动打开浏览器 → 抓 `code` → POST 换 token →
写入 `secrets/open-platform.json`（`accessToken` / `refreshToken` / `expires_in` / `scopes`）。

授权页 URL（2025-03 新版，旧的 `passport.bilibili.com/register/pc_oauth2.html` 已停维护）：

```
https://account.bilibili.com/pc/account-pc/auth/oauth?client_id=<ClientID>&gourl=<urlencoded>&state=<随机串>
```

- `gourl` 必须与应用「授权回调域」一致，**拼接前 URL encode**；不一致 → 「不合法的授权请求」
- 回调：`<return_url>?code=<code>&state=<state>`
- `code` 一次性、短时效；`refresh_token` 一次性
- `bili_oauth {action:"authorize-url", gourl:"…"}` 自动组链接

---

## 5d. 主站 Web（Cookie，非开放平台）

**与开放平台是两套体系**：开放平台用 `client_id` + `secret` + HMAC 签名 + `access_token`；
主站 `www.bilibili.com` / `api.bilibili.com` 的 Web 接口用浏览器 Cookie（`SESSDATA` 等）。
两边的凭证不能互换 —— 把 SESSDATA 填进 `BILI_ACCESS_TOKEN` 只会拿到 401/`-101` ——
反过来，`client_id`/`app_secret` 也不在 cookie 里（获取方式见 5c）。

### Cookie 从哪来

优先级：`bili_cookie {jar:...}` 显式导入 → `BILI_COOKIE_FILE` 指向的文件 → `BILI_COOKIE` 环境变量 → `secrets/cookies.json`。

支持三种格式：

| 格式 | 例子 |
| --- | --- |
| EditThisCookie 导出的数组 | `[{"name":"SESSDATA","value":"…","domain":".bilibili.com"}, …]` |
| 对象 | `{"SESSDATA":"…","bili_jct":"…"}` |
| 字符串 | `"SESSDATA=…; bili_jct=…"` |

### `bili_cookie`

| action | 说明 |
| --- | --- |
| `status`（默认） | 9 个关键 cookie 的存在性 + 过期时间 + 剩余天数；无关 cookie 只列名字 |
| `whoami` | 真调 `/x/web-interface/nav`，返回 uid / uname / 等级 / 硬币 / 大会员；`-101` 即 cookie 已失效 |
| `import` | 传 `jar`，同名覆盖、其余保留 |
| `set` | 传 `name`（`value` 省略即删除该条） |
| `export` | 导出整个罐子 |
| `clear` | 清空 |

**默认脱敏**（`SESSDATA` 显示成 `b50af9…IIEC [len=222]`），`reveal:true` 才出原值。
报告登录态时用 `whoami`，不要靠字符串长度猜。

### `bili_web_call`

| 参数 | 说明 |
| --- | --- |
| `path` \| `url` | `path` 拼到 `https://www.bilibili.com`；`url` 优先 |
| `method` | `GET` / `POST`，给 `form` 时默认 POST |
| `query` / `form` / `body` | `form` → `x-www-form-urlencoded` 且**自动补 `csrf=bili_jct`**；`body` → JSON |
| `headers` | 额外头（`Cookie`、`UA`、`Referer` 已自动带） |
| `wbi` | 强制开关 wbi 签名；留空按路径自动判断（`/wbi/`、`/polymer/`、`/v2/reply/wbi/`） |
| `dryRun` | 只打印请求 |
| `maxBytes` | 响应截断，默认 60000 |

**域名白名单**：只允许 `*.bilibili.com` / `*.hdslb.com`，其它直接拒绝（这是硬编码的，别试着绕）。

**wbi 签名**（`src/wbi.mjs`）：`/x/space/wbi/*`、`/x/polymer/*` 要 `w_rid` + `wts`。
流程：nav 取 `wbi_img` → 重排表出 `mixin_key` → 参数字典序、去掉 `!'()*` → urlencode →
末尾接 `mixin_key` → md5。
实测 `/x/space/wbi/acc/info?mid=<uid>` 带签名 `code:0`，`wbi:false` 得 `-403 访问权限不足`。

已知失效：`/x/space/wbi/arc/search` 恒 `-403`（补 `dm_img_list`/`dm_img_str`/`dm_img_inter`
也无效）→ 改用旧路径 `/x/space/arc/search`（`code:0`）。

**举报**：两个入口。

① 报**用户**：`POST /x/space/report`，body `mid` / `reason` / `scene` / `tag_version`（csrf 自动带）。
合法组合由 `GET /x/space/report/options` 决定，**先拉它再用，别写死**：

| reason | 含义 | 可用 scene |
| --- | --- | --- |
| 5 | 传播色情/赌博/垃圾广告资源、诱导交易 | 1~7 |
| 1 | 色情低俗 | 1~7 |
| 4 | 引战、人身攻击 | 1~7 |
| 3 | 违法违禁行为 | 1 |
| 2 | 虚假不实信息 | 1 |

scene：1 用户资料（头像/签名/昵称）· 2 稿件 · 3 评论 · 4 动态 · 5 私信 · 6 专栏 · 7 其他。

② 报**单条评论**：`POST /x/v2/reply/report`，参数 `type` / `oid` / `rpid` / `reason` / `content`。
`reason`：0其他 1垃圾广告 2色情 3刷屏 4引战 5剧透 6政治 7人身攻击 8内容不相关 9违法违规
10低俗 11非法网站 12赌博诈骗 13传播不实信息 14怂恿教唆 15侵犯隐私 16抢楼 17青少年不良。
返回 `12008` 已举报过 / `12019` 举报过于频繁 / `-509` 请求过于频繁 / `-111` csrf 失败；
这个接口风控更紧，静默调用常见 `-352`。

要报评论就得先拿到 `oid`/`rpid`：

| 要什么 | 调用 |
| --- | --- |
| 动态列表 | `/x/polymer/web-dynamic/v1/feed/space?host_mid=<uid>`（wbi）→ `id_str` |
| 动态正文 | `/x/polymer/web-dynamic/v1/detail?id=<id_str>`（wbi） |
| 投稿列表 | `/x/space/arc/search?mid=<uid>&ps=20&pn=1` → `aid` / `bvid` |
| 稿件评论 | `/x/v2/reply/wbi/main?oid=<aid>&type=1&mode=3`（wbi）→ `rpid` |

常见坑：
- 写操作（点赞、投币、发评论）缺 `csrf` 会返回 `-111  csrf校验失败` —— `bili_jct` 必须在罐里
- `SESSDATA` 是 `httpOnly` + `Secure` 的，浏览器里只能通过导出插件拿到
- 同一 `SESSDATA` 多设备并发容易触发风控（`-352`），换设备指纹（`buvid3`/`buvid4`）或降频
- `bili_ticket` 只活 3 天左右，部分接口要它；`status` 里会标出来

---

## 5c. 资源与提示

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| resource | `bili://catalog` | `llms.txt` 全文，客户端可直接挂成上下文 |
| resource | `bili://doc/{ref}` | 单篇文档原文 Markdown |
| resource | `bili://web` | 112 条主站 Web 隐藏能力（举报 / 拉黑 / 动态 / 评论 / 弹幕 / 私信 / 直播 …），Markdown 全文，带实测状态 |
| prompt | `integrate-bili-api` | 参数 `ref`，产出「把该接口接入现有项目」的完整任务说明（含 5 条硬性要求） |

---

## 6. 请求总则

### 6.1 2.0 签名（HMAC-SHA256）

> **版本例外**：`#16 唤起粉端投稿接口说明` 在文档里明确写「该接口使用的签名为 `1.0`」，
> 但其 C# Demo 只是把 `SignatureVersion` 填成 `"1.0"`，文档**没有给出 1.0 的算法差异**。
> 本仓库的签名实现只做 2.0；接 #16 前需向平台确认 1.0 的规则。`data/index.json` 里这条带
> `signVersion: "1.0"`，`bili_api_spec` 会打上 ⚠ 标记。

参与签名的**只有这 6 个头**，按 key 字典序排列：

```
x-bili-accesskeyid
x-bili-content-md5
x-bili-signature-method
x-bili-signature-nonce
x-bili-signature-version
x-bili-timestamp
```

拼成 `k:v`，行间用 `\n`，**末尾不留换行**；`Authorization` = `HMAC-SHA256(app_secret, 待签串)` 的 hex 小写。

**可复现的例子**（secret = `test_secret`）：

```
x-bili-accesskeyid:93a0f774fae84e6c
x-bili-content-md5:d41d8cd98f00b204e9800998ecf8427e
x-bili-signature-method:HMAC-SHA256
x-bili-signature-nonce:1730185575446751000
x-bili-signature-version:2.0
x-bili-timestamp:1730185575
```

→ `Authorization: 93daf316cf499f313e6e7c487857fe3b1c8e9b6a262123e36ddf867bd97e5e1f`
（待签串 223 字节；`md5("") = d41d8cd98f00b204e9800998ecf8427e`；`md5('{"title":"demo"}') = 0644a83ba42a8257fe418164beb5509a`）

用这两个值可以自检任何实现的正确性。

### 6.2 实际发出的请求头

| 头 | 值 |
| --- | --- |
| `Accept` | `application/json` |
| `Content-Type` | `application/json`（上传文件时 `application/octet-stream` 或 `multipart/form-data`） |
| `Authorization` | 上一步的签名 |
| `X-Bili-Accesskeyid` | = client_id |
| `X-Bili-Content-Md5` | `md5(body)` 小写 |
| `X-Bili-Signature-Method` | `HMAC-SHA256` |
| `X-Bili-Signature-Nonce` | 随机 GUID，每次不同（防重放） |
| `X-Bili-Signature-Version` | `2.0` |
| `X-Bili-Timestamp` | 秒级 unix 时间，偏差 > 10 分钟直接丢弃 |
| `access-token` | OAuth2 的 access_token（v2.0 必填） |

### 6.3 三个最常见的签名错误

1. **md5 算错对象**：必须是实际发出的字节。Python 里 `md5(str(dict))` ≠ `md5(json.dumps(dict))`。
2. **末尾多一个 `\n`**，或少了某一行 → `4002 签名异常`。
3. **GET 用了非空 body 的 md5**：GET 没 body，`x-bili-content-md5` 必须是 `md5("")`。

### 6.4 无需签名的接口（唯一例外）

分片上传 / 单文件上传（#9 / #14）走 `openupos.bilivideo.com`，**裸二进制、不带任何 `X-Bili-*`**，
凭 URL 上的 `upload_token` 鉴权，`Content-Type: application/octet-stream`。

### 6.5 文档里已知的坑（已写进 `hints`）

| 现象 | 涉及 | 处理 |
| --- | --- | --- |
| 方法是 `GET`，参数却列在「body 参数」下 | #24 #25 #27 #33 #38 | 按 **query** 传（看 curl 样例：GET 无 body） |
| 文档标注签名版本 1.0 | #16 | 见 6.1，先向平台确认算法 |
| 分片上传用 API 签名头 | #9 #14 | 不要带，会失败 |
| 篇内多张表靠 `├─` / `│` 画层级 | #114 等 | 用 `depth` 字段还原嵌套 |

---

## 7. OAuth2 完整流程

```
① 用户在授权页同意 → 回调地址收到 code
② POST https://api.bilibili.com/x/account-oauth2/v1/token
   Content-Type: application/x-www-form-urlencoded
   client_id / client_secret / grant_type=authorization_code / code
   → { access_token, refresh_token, expires_in, scopes[] }
③ 业务请求带 access-token: <access_token>
④ 过期前用 refresh_token 续期（一次一份）
   POST https://api.bilibili.com/x/account-oauth2/v1/refresh_token
   grant_type=refresh_token / refresh_token
```

要点：

- `expires_in` 是 **UTC 时间戳**（不是剩余秒数），文档样例 `1630220614`。
- 每个 `refresh_token` **只能用一次**，续期后要用返回的新 token。
- access_token 过期后不能再刷新，必须让用户重新授权。
- 用户主动解除授权时，平台会推 `解除授权` 事件（#123），要接。
- 客户端应用走 SDK 拿 code，网站应用走重定向，两者拿到的 code 等价。

---

## 8. 返回结构与错误码

### 通用返回

```json
{ "code": 0, "message": "0", "ttl": 1, "data": {}, "request_id": "…" }
```

- `code == 0` 才算成功。**HTTP 200 也可能是业务失败**，必须看 `code`。
- `request_id` 是唯一请求 id，报障时给运营。
- 三方回传结构（电商等）同样要求 `code/message/data/request_id`。

### 错误码分段

| 段 | 含义 | 代表 |
| --- | --- | --- |
| `4000–4012` | 通用 / 签名 | `4002 签名异常`、`4003 请求过期`、`4008 MD5 校验失败`、`4007/4009 Content-Type/Accept 不对` |
| `1220xx` | OAuth2 | `122000 client_id 错`、`122001 secret 错`、`122002 code 未找到`、`122007 refreshToken 非法` |
| `1270xx` | 鉴权 / 限频 | `127001 token 错`、`127002 sign 错`、`127007 应用无该接口权限`、`127009 超限`、`127011 用户未授权`、`127304/127305/127306 权限/白名单/频率` |
| `1230xx` | 视频稿件 | `123004 不存在该稿件`、`123009 该分区不存在`、`123026 频率过快`、`123035 已开放不能定时发布` |
| `1290xx` | 专栏 | `129005 标题不合法`、`129006 正文要超 200 字或 3 张图`、`129018 当日投稿上限` |
| `1410xx` | 直播长连 | `141002 心跳超时`、`141005 获取长连失败` |
| `1300xx` | 服务市场 / 电商 | `130001 未授权店铺`、`130004 订单服务异常` |
| `1310xx` | 创作中心 | `131001 系统繁忙` |

逐条查：`bili_error_lookup`。

---

## 9. 接口索引（95 篇单接口 + 2 篇多接口 = 100 个端点）

`ref` 列直接用于 `bili_api_spec {ref}` / `bili_api_call {ref}`。PATH 不含主机时默认 `https://member.bilibili.com`。

### 用户管理（3）

| ref | METHOD | PATH | scope |
| --- | --- | --- | --- |
| #4 | GET | `/arcopen/fn/user/account/scopes` | USER_INFO |
| #5 | GET | `/arcopen/fn/user/account/info` | USER_INFO |
| #6 | POST | `/arcopen/fn/user/account/union_id` | USER_INFO |

### 视频稿件管理（12）

| ref | METHOD | PATH | scope |
| --- | --- | --- | --- |
| #8 | POST | `/arcopen/fn/archive/video/init` | ARC_BASE |
| #9 | POST | `/video/v2/part/upload` ⟨openupos.bilivideo.com⟩ | ARC_BASE |
| #10 | POST | `/arcopen/fn/archive/video/complete` | ARC_BASE |
| #11 | POST | `/arcopen/fn/archive/cover/upload` | ARC_BASE |
| #12 | POST | `/arcopen/fn/archive/add-by-utoken` | ARC_BASE |
| #13 | GET | `/arcopen/fn/archive/type/list` | ARC_BASE |
| #14 | POST | `/video/v2/upload` ⟨openupos.bilivideo.com⟩ | ARC_BASE |
| #16 | POST | `/arcopen/fn/resource/add_share` | ARC_BASE |
| #17 | GET | `/arcopen/fn/archive/view` | ARC_BASE |
| #18 | GET | `/arcopen/fn/archive/viewlist` | ARC_BASE |
| #19 | POST | `/arcopen/fn/archive/edit` | ARC_BASE |
| #20 | POST | `/arcopen/fn/archive/delete` | ARC_BASE |

### 专栏稿件管理（14）

| ref | METHOD | PATH | scope |
| --- | --- | --- | --- |
| #21 | POST | `/arcopen/fn/article/add` | ATC_BASE |
| #22 | POST | `/arcopen/fn/article/edit` | ATC_BASE |
| #23 | POST | `/arcopen/fn/article/delete` | ATC_BASE |
| #24 | GET | `/arcopen/fn/article/detail` | ATC_BASE |
| #25 | GET | `/arcopen/fn/article/list` | ATC_BASE |
| #26 | GET | `/arcopen/fn/article/categories` | ATC_BASE |
| #27 | GET | `/arcopen/fn/article/card` | ATC_BASE |
| #28 | POST | `/arcopen/fn/article/anthology/add` | ATC_BASE |
| #29 | POST | `/arcopen/fn/article/anthology/edit` | ATC_BASE |
| #30 | POST | `/arcopen/fn/article/belong` | ATC_BASE |
| #31 | POST | `/arcopen/fn/article/anthology/delete` | ATC_BASE |
| #32 | GET | `/arcopen/fn/article/anthology/list` | ATC_BASE |
| #33 | GET | `/arcopen/fn/article/anthology/detail` | ATC_BASE |
| #34 | POST | `/arcopen/fn/article/upload/image` | ATC_BASE |

### 数据开放服务（5）

| ref | METHOD | PATH | scope |
| --- | --- | --- | --- |
| #35 | GET | `/arcopen/fn/data/user/stat` | USER_DATA |
| #36 | GET | `/arcopen/fn/data/arc/stat` | ARC_DATA |
| #37 | GET | `/arcopen/fn/data/arc/inc-stats` | ARC_DATA |
| #38 | GET | `/arcopen/fn/data/art/stat` | ATC_DATA |
| #39 | GET | `/arcopen/fn/data/art/inc-stats` | ATC_DATA |

### 直播能力（9）

| ref | METHOD | PATH | scope |
| --- | --- | --- | --- |
| #41 | GET | `/arcopen/fn/live/room/info` | LIVE_ROOM_DATA |
| #42 | POST | `/arcopen/fn/live/room/detail` | LIVE_ROOM_DATA |
| #43 | POST | `/arcopen/fn/live/room/ws-start` | LIVE_ROOM_DATA |
| #45 | POST | `/arcopen/fn/live/room/ws-heartbeat` | — |
| #46 | POST | `/arcopen/fn/live/room/ws-batch-heartbeat` | — |
| #50 | GET | `/liveopen/fn/live/thirdPartyLive/grantUrl` | LIVE_ROOM_DATA |
| #52 | POST | `/liveopen/fn/live/thirdPartyLive/startLive` | LIVE_ROOM_DATA |
| #53 | POST | `/liveopen/fn/live/thirdPartyLive/endLive` | LIVE_ROOM_DATA |
| #54 | POST | `/arcopen/fn/live/room/stream` | LIVE_STREAM_DATA |

### 经营号客服（7）

| ref | METHOD | PATH | scope |
| --- | --- | --- | --- |
| #59 | POST | `/arcopen/fn/market/customer/conversation/send_msg` | SHOP_BA_CHAT |
| #60 | POST | `/arcopen/fn/market/customer/conversation/user_from` | SHOP_BA_CHAT |
| #61 | POST | `/arcopen/fn/market/customer/conversation/staff_status_update` | SHOP_BA_CHAT |
| #62 | POST | `/arcopen/fn/market/customer/conversation/close` | SHOP_BA_CHAT |
| #63 | POST | `/arcopen/fn/market/customer/image_upload` | SHOP_BA_CHAT |
| #64 | POST | `/arcopen/fn/market/customer/conversation/acquisition_tool_list` | SHOP_BA_CHAT |
| #65 | POST | `/arcopen/fn/market/customer/conversation/cus_info_update` | SHOP_BA_CHAT |

### 交易电商（38）

| ref | METHOD | PATH | scope |
| --- | --- | --- | --- |
| #67 | GET | `/arcopen/fn/v2/market/shop/info/get` | SHOP_STORE_INFO |
| #68 | POST | `/arcopen/fn/market/common/product_add` | SHOP_COMMODITY_INFO |
| #69 | GET | `/arcopen/fn/v2/market/commodity/item/list` | SHOP_COMMODITY_INFO |
| #70 | POST | `/arcopen/fn/market/common/product_get_product_publish_rule` | SHOP_COMMODITY_INFO |
| #71 | POST | `/arcopen/fn/market/common/product_detail` | SHOP_COMMODITY_INFO |
| #72 | POST | `/arcopen/fn/market/common/product_edit` | SHOP_COMMODITY_INFO |
| #73 | POST | `/arcopen/fn/market/common/product_del` | SHOP_COMMODITY_INFO |
| #74 | POST | `/arcopen/fn/v2/market/commodity/image/upload` | SHOP_COMMODITY_INFO |
| #75 | POST | `/arcopen/fn/market/common/product_get_cate_property` | SHOP_COMMODITY_INFO |
| #76 | GET | `/arcopen/fn/market/commodity/category/qualified/list` | SHOP_COMMODITY_INFO |
| #77 | POST | `/arcopen/fn/common/market_add_customization_product` | SHOP_COMMODITY_INFO |
| #78 | POST | `/arcopen/fn/market/common/order_searchList` | SHOP_ORDER_INFO |
| #79 | POST | `/arcopen/fn/market/common/order_detail` | SHOP_ORDER_INFO |
| #80 | POST | `/arcopen/fn/market/common/order_remark` | SHOP_ORDER_INFO |
| #81 | POST | `/arcopen/fn/market/common/order_review` | SHOP_ORDER_INFO |
| #82 | POST | `/arcopen/fn/market/common/order_batch_decrypt` | SHOP_ORDER_INFO |
| #83 | POST | `/arcopen/fn/market/common/page` | SHOP_ORDER_INFO |
| #86 | POST | `/arcopen/fn/market/common/logistics_add` | SHOP_LOGISTICS_INFO |
| #87 | POST | `/arcopen/fn/common/market_add_virtual_logistics` | SHOP_LOGISTICS_INFO |
| #88 | POST | `/arcopen/fn/market/common/logistics_edit` | SHOP_LOGISTICS_INFO |
| #89 | POST | `/arcopen/fn/market/common/logistics_company_list` | SHOP_LOGISTICS_INFO |
| #90 | POST | `/arcopen/fn/market/common/address_create` | SHOP_LOGISTICS_INFO |
| #91 | POST | `/arcopen/fn/market/common/address_list` | SHOP_LOGISTICS_INFO |
| #92 | POST | `/arcopen/fn/market/common/address_get_province` | SHOP_LOGISTICS_INFO |
| #93 | POST | `/arcopen/fn/market/common/address_get_areas_by_province` | SHOP_LOGISTICS_INFO |
| #94 | POST | `/arcopen/fn/market/common/logistics_freight_template_list` | SHOP_LOGISTICS_INFO |
| #95 | POST | `/arcopen/fn/common/market_get_upload_url` | SHOP_LOGISTICS_INFO |
| #97 | POST | `/arcopen/fn/market/common/after_sale_query_list` | SHOP_AFTERSALES_INFO |
| #98 | POST | `/arcopen/fn/market/common/after_sale_query_detail` | SHOP_AFTERSALES_INFO |
| #99 | POST | `/arcopen/fn/market/common/after_sale_check_after_sale` | SHOP_AFTERSALES_INFO |
| #100 | POST | `/arcopen/fn/market/common/after_sale_confirm_receipt` | SHOP_AFTERSALES_INFO |
| #101 | POST | `/arcopen/fn/market/common/after_sale_barter_ship` | SHOP_AFTERSALES_INFO |
| #102 | POST | `/arcopen/fn/market/common/after_sale_stop` | SHOP_AFTERSALES_INFO |
| #103 | GET | `/arcopen/fn/v2/market/stock/query` | SHOP_STOCK_INFO |
| #104 | POST | `/arcopen/fn/v2/market/stock/update` | SHOP_STOCK_INFO |
| #105 | POST | `/arcopen/fn/market/live/commerce/generate/promotion/url` | SHOP_LIVE_COMMERC_DATA |
| #107 | POST | `/arcopen/fn/common/market_create_early_purchase` | SHOP_TICKET_ORDER_DATA |
| #108 | POST | `/arcopen/fn/common/market_ticket_decrypt` | SHOP_TICKET_ORDER_DATA |

### 充电业务（1）

| ref | METHOD | PATH | scope |
| --- | --- | --- | --- |
| #110 | POST | `/arcopen/fn/common/charge_order_search_list` | UPOWER_ORDER_DATA |

### 课堂业务（3）

| ref | METHOD | PATH | scope |
| --- | --- | --- | --- |
| #112 | POST | `/arcopen/fn/common/by_orderno_for_course_order` | COURSE_ORDER_DATA |
| #113 | POST | `/arcopen/fn/common/student_study_progress_list` | COURSE_ORDER_DATA |
| #114 | POST | `/arcopen/fn/common/student_study_progress_detail` | COURSE_ORDER_DATA |

### 站内版权授权曲库（3）

| ref | METHOD | PATH | scope |
| --- | --- | --- | --- |
| #118 | POST | `/arcopen/fn/music/meta/list` | COPYRIGHT_MUSIC_DATA |
| #119 | POST | `/arcopen/fn/music/list` | COPYRIGHT_MUSIC_DATA |
| #120 | POST | `/arcopen/fn/music/search` | COPYRIGHT_MUSIC_DATA |

### 多接口文档（同一篇文档里有多个端点）

**#1 账号授权**

- `POST https://api.bilibili.com/x/account-oauth2/v1/token`
- `POST https://api.bilibili.com/x/account-oauth2/v1/refresh_token`

**#84 修改订单地址**

- `POST https://member.bilibili.com/arcopen/fn/market/common/address_apply`
- `POST https://member.bilibili.com/arcopen/fn/market/common/address_modify`
- `POST https://member.bilibili.com/arcopen/fn/market/common/address_apply_status`

不在上表里的 ref 是文档/事件/协议类，用 `bili_docs_get {ref}` 读正文。

## 10. 分模块要点

### 10.1 视频投稿（最常用）

```
init(utype=0) → part upload ×N → complete → add-by-utoken
init(utype=1) → upload(单文件 <100M)      → add-by-utoken
唤起粉端投稿：add_share → 拿 link_url → 用系统浏览器打开 → 客户端唤起投稿页
```

- 分片 `part_number` **从 1 开始连续递增**，除最后一片外必须等大（建议 10MB）。
- body 是**裸字节**，不要 `multipart/form-data`，否则转码失败。
- 推荐虚拟分片：按 offset/length 从原文件读，不落地切片。
- `cover` 必须是封面上传接口返回的 url。
- **删除稿件不可逆**（123005 / #20）。
- 技术限制：≤4GB、时长 <5h、推荐 mp4/flv、峰值码率 ≤60Mbps、分辨率 ≤4096×4096、帧率 ≤120fps、
  关键帧 ≥10s、yuv420、SDR 8bit / HDR 10bit、音频 ≤320Kbps / 2ch / 48kHz。
- 分区会不定期调整，建议定时查 #13。
- 非正式会员单日限投 5 个（123036）。
- **#16 唤起粉端投稿**：`scene_code` 固定 `ARC_APP_SHARE`，需要预先和运营约定 `biz_code` 与
  `common_msg` 的 JSON 结构（子结构见 `#16 subSchemas`）；返回的 `link_url` 交给移动端系统浏览器打开。
  这个接口文档标注签名版本 `1.0`，见 6.1。

### 10.2 专栏

- 正文要 >200 字或 ≥3 图（129006）；标题 ≤40；文集/文章有数量上限（129009/129012）。
- 图片先走 #34 上传拿地址，再放进正文。

### 10.3 直播长连（#43/#44/#45/#46）

`ws-start` → `conn_id` + `websocket_info{ wss_link[], auth_body }`。

```
包头 16 字节，全部大端:
  Packet Length uint32 | Header Length uint16(=16) | Version uint16 |
  Operation uint32 | Sequence ID uint32 | Body
```

| Operation | 值 | 方向 |
| --- | --- | --- |
| OP_HEARTBEAT | 2 | 客户端发，30s 一次，body 空 |
| OP_HEARTBEAT_REPLY | 3 | 服务端回 |
| OP_SEND_SMS_REPLY | 5 | 服务端推消息 |
| OP_AUTH | 7 | 客户端发的第一个包，body = auth_body |
| OP_AUTH_REPLY | 8 | 服务端回 |

`Version=2` → body 是 zlib 压缩，解压后**可能包含多个完整包**（递归解析）。
HTTP 心跳 #45（`client_id` + `conn_id`）/ 批量 #46 是替代方案。示例见 `examples/live_ws.py`。

### 10.4 一键开播（#48–#53）

走 `/liveopen/` 前缀，流程：`grantUrl` 拿授权 → 用户授权 → 回调 → `startLive` → `endLive`。

### 10.5 消息推送 / Webhook（#121–#168，41 个事件）

- 在管理中心配置回调地址，保存时平台会发一次校验请求：
  ```json
  { "event": "verify_webhooks", "content": { "data": 1371848576 }, "timestamp": "2021-01-01 12:01:01" }
  ```
  必须原样回 `{"data": 1371848576}`。
- 统一结构：`{ "event": "", "content": {}, "timestamp": "" }`。
- **来源验证**：`x-bilibili-signature` 头 = `SHA1(app_secret + request body)`。
  校验时**收到消息的字段顺序必须与文档发送格式一致**，否则签名对不上 —— 建议用原始 body 字节而不是重新序列化。
- 送达判定：返回 2xx 即视为成功；5s 超时、最多重试 3 次 → 业务侧必须**幂等去重**。

事件清单（部分）：

| 分组 | event |
| --- | --- |
| 基础授权 | `用户授权`(#122) · `解除授权`(#123) |
| 订单 | `CREATE_ORDER` `PAY_ORDER` `CANCEL_ORDER` `CONFIRM_ORDER` `MODIFY_FEE_ORDER` `REMARK_ORDER` `CONFIRM_DELIVERED` `APPLY_MODIFY_ADDR_ORDER` `STAGE_RECEIVED_ORDER` |
| 售后 | `AFTER_SALE-CREATED` `AFTER_SALE-CANCEL` `REFUND-SUCCESS` `RETURN-APPLY-REFUSED` `REFUND-REFUSED` `ARBITRATE-CREATED` `ARBITRATE-AUDITED` `ARBITRATE-CANCELED` `BUYER_RETURNED` `AFTER_SALE_AGREE` `MERCHANT_SHIPPED` `ARBITRATE_MERCHANT_COMMIT_EVIDENCE` `ARBITRATE_PLATFORM_INTERVENTION` |
| 商品 | `create_items` `update_items` `delete_items` `onsale_items` `offsale_items` `ban_items` `unban_items` `undelete_items` `submit_items_audit` `approve_items_audit` `reject_items_audit` `revoke_items_audit` |
| 票务 | `TICKET_CREATE_DONE` `TICKET_REFUND_DONE` `TICKET_CHECK_DONE` |
| 客服 | `用户进入对话`(#163) `SEND_MSG`(#164) `CLOSE_MSG`(#165) `留资结果`(#166) |
| 视频稿件 | `video_open`(#167) `video_fail`(#168) |

### 10.6 电商订单敏感信息

`#82 order_batch_decrypt` / `#108 market_ticket_decrypt` 专门解密收件人等敏感字段，
拿到的是密文 id，必须调解密接口换明文，**不要尝试本地解密**。

---

## 11. 沙盒 / 白名单 / 未列出的能力

- **沙盒（#169）**：`member.bilibili.com/mock/...`，返回 MOCK 数据，不影响正式环境。
  用同一套 OAuth2 流程拿到的 access_token 即可调；但**应用仍须已申请对应 scope**，否则返回权限错误。
  注意 mock 路径与正式路径**不总是一致**（例：正式 `/arcopen/fn/archive/video/init`，mock `/mock/video/part/init`），以 #169 表格为准。
- **白名单（#3）**：某接口配置白名单后只有列表内 uid 能调，报 `127305 白名单限制`；默认关闭。
- **未列出的功能（#170）**：文档只放已有商务合作的能力；有别的需求走邮件 `openplatform-feedback@bilibili.com`，需写明合作内容、量化收益、公司信息、对接人。
  但「文档没写」不等于「调不到」—— 主站 Web 上那一大片（举报 / 拉黑 / 动态 / 评论 / 收藏 / 历史 / 消息 / 直播 / 创作中心）
  走的是浏览器 Cookie，不走 2.0 签名，已收进 `data/web.json`：**112 条 / 17 组**。
  读法：`bili_endpoints {source:"web"}` 过滤，resource `bili://web` 整块读，`bili_web_call` 直接调。

---

## 12. 分页与字段约定

文档里的分页字段**不统一**，按接口看，别套用：

| 字段 | 含义 |
| --- | --- |
| `pn` / `page_no` / `page` | 页码（`page` 从 0 开始，`pn` 默认 1） |
| `ps` / `page_size` / `pageSize` / `size` | 每页数量（上限 50 / 100 / 200 不等） |
| `nextPageIndex` | 下一页索引，第一页传 0 |

其他约定：

- 所有 URL 参数需 **URL encode**，中文用 UTF-8。
- 时间字段多为 **秒级 unix 时间戳**（`expires_in` 例外，是绝对时间戳但同样是秒）。
- 金额字段注意单位（分 / 元）与 `spec_prices` 这类 sku 数组结构，必须与规格组合数一致。

---

## 13. 代码生成模板

**Python（用 `examples/bili_open.py`，不要另写一套）**

```python
import sys; sys.path.insert(0, "examples")
from bili_open import call, MEMBER_HOST

r = call("GET", MEMBER_HOST + "/arcopen/fn/user/account/info")
if r.get("code") != 0:
    raise RuntimeError(r)          # 注意: HTTP 200 也可能是业务错误
print(r["data"]["openid"])
```

**Node（用 `examples/node_client.mjs`）**

```js
import { callApi } from "./examples/node_client.mjs";
const r = await callApi({ method: "GET", url: "https://member.bilibili.com/arcopen/fn/user/account/info" });
if (r.json.code !== 0) throw new Error(JSON.stringify(r));
```

**生成代码时必须覆盖的点**

1. 先取 scope，确认应用已申请（否则 127007）。
2. `code != 0` 要处理，别只看 HTTP 状态。
3. 分页字段按该接口文档取，不要统一写成 `page/page_size`。
4. token 刷新用返回的新 `refresh_token`（一次性的）。
5. 上传类接口不加签名头。
6. 参数在 `bodyParams` 但方法是 GET 时，按 query 拼到 URL（见 6.5）。
7. `subSchemas` 里的字段是嵌套结构的字段，别平铺成顶层参数。

---

## 14. 交付前自检清单

数据侧（改过 `scripts/` 或文档后必跑）：

```bash
npm run build     # 重新解析 170 篇文档
npm run audit     # 11 类一致性检查，必须 AUDIT PASSED
npm run selftest  # 起 MCP 服务逐个调工具，必须 ALL SELFTEST PASSED
```

代码侧（写对接代码时）：

- [ ] 用 `bili_api_spec` 核对过字段名（不是从摘要里猜的）
- [ ] 签名自检：secret=`test_secret`、nonce=`1730185575446751000`、ts=`1730185575`、空 body
      → 期望 `93daf316cf499f313e6e7c487857fe3b1c8e9b6a262123e36ddf867bd97e5e1f`
- [ ] 空 body 用 `d41d8cd98f00b204e9800998ecf8427e`，非空 body 用实际发送字节的 md5
- [ ] `code != 0` 分支有处理（错误信息取自 `message`，必要时 `bili_error_lookup`）
- [ ] GET + `bodyParams` 的接口按 query 传
- [ ] 上传：`part_number` 从 1 连续、除末片等大、裸二进制、不加签名头
- [ ] Webhook：`verify_webhooks` 回 `{"data": <原值>}`，来源用 SHA1(secret + 原始 body) 校验，做幂等
- [ ] 没有编造文档里不存在的接口或字段

---

## 15. 不要做的事

- ❌ 不要凭记忆写 `/x/v2/...` 这种主站接口 —— 本目录只覆盖开放平台 `/arcopen/fn/`、`/liveopen/fn/` 系。
- ❌ 没有凭据时不要编造 access_token，也不要把占位签名当作可用请求。
- ❌ 不要把 `app_secret` 写进请求体或 URL，它只用于本地计算的 HMAC。
- ❌ 不要在 GET 请求上带 body 并据此算 md5。
- ❌ 不要假设 mock 路径与正式路径一致。
- ❌ 不要把 `responseParams` 当成完整 schema —— 省略号、嵌套对象都以原文为准，必要时 `bili_docs_get` 读全文。
- ❌ 不要忽略 `hints` / `signVersion` / `subSchemas` —— 它们是从原文里挖出来的差异点。
- ❌ 不要为了「补齐」而给缺失的 `required` 编一个值：文档没写就是没写。

---

## 16. 维护

文档更新后：

```bash
npm run build      # 重跑 scripts/build-spec.mjs，刷新 data/{index.json,llms.txt,status-codes.json}
npm run audit      # 11 类一致性检查（清单/类型分布/URL/参数卫生/scope/漏解析/错误码/AGENTS/llms/工具清单）
npm run selftest   # 工具 + 资源 + 提示，含生成代码的真实编译检查
```

`build-spec.mjs` 以父目录的 `_INDEX.md` 作为层级与 id 来源，目录结构调整后会自动跟上。
`audit.mjs` 会在数据与 `AGENTS.md` 的索引表不一致时报错 —— 改完索引表记得重跑。

调试单篇解析：

```bash
set BILI_DEBUG_DOC=78 && node scripts/build-spec.mjs ..     # 打印该篇的块划分与表头
```

数据源可复现：

```
GET https://open.bilibili.com/arcopen/user/open-doc/view?id=4
```

`data.online_doc` 是整棵目录树 JSON，每个 Article 节点带 `md_url`（原始 Markdown）与 `html_url`（渲染后 HTML）。
