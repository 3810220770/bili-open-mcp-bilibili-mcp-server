# bili-open-mcp

哔哩哔哩开放平台（<https://open.bilibili.com/doc/4>）的 **MCP 服务 + 结构化接口库 + 可运行示例**。
把 170 篇文档变成 AI 能直接检索、直接调用、直接生成签名的东西。

> [!IMPORTANT]
> **本项目调用的所有接口均为哔哩哔哩官方公开提供的接口**（开放平台文档 / 开放平台域名 /
> 主站 Web 接口 / 官方直播间长连协议），不含私有接口或绕过鉴权的实现。详见
> [DISCLAIMER.md](DISCLAIMER.md)。
>
> **凭据需自备，且缺失时功能受限**：没有 `BILI_COOKIE_FILE`（→ `secrets/cookies.json`）和
> `BILI_CRED_FILE`（→ `secrets/open-platform.json`），则开放平台接口与主站 Web 接口**全部不可用**，
> 只剩文档检索、错误码查询、代码生成、沙盒 mock、签名演示这些纯本地能力。
> 本项目不内置任何凭据，两个文件所在目录已在 `.gitignore` 中排除。
>
> 第三方项目，与哔哩哔哩无隶属或背书关系。请遵守官方协议并自行控制频率。

```
bili-open-mcp/
├─ src/
│  ├─ server.mjs        MCP 服务（stdio，19 个工具 + 2 资源 + 1 提示）
│  ├─ signer.mjs        2.0 签名（HMAC-SHA256）
│  ├─ client.mjs        带签名的 HTTP 调用
│  ├─ codegen.mjs       6 种语言的调用代码生成
│  ├─ cookies.mjs       主站 Cookie 罐（EditThisCookie 导入 / 域匹配 / 脱敏）
│  ├─ credentials.mjs   开放平台凭据（参数 → 环境变量 → 文件）
│  └─ knowledge.mjs     速查 / OAuth / 长连协议 / Webhook 知识块
├─ secrets/             整个目录提交时排除（.gitignore）
│  ├─ cookies.json      主站 Cookie        ← BILI_COOKIE_FILE
│  └─ open-platform.json 开放平台凭据      ← BILI_CRED_FILE
├─ scripts/
│  ├─ build-spec.mjs    Markdown → data/*.json / llms.txt
│  ├─ audit.mjs         数据与文档一致性检查
│  ├─ selftest.mjs      工具 / 资源 / 提示 + 生成代码编译自检
│  ├─ check-project-config.mjs  按 opencode 项目配置实际拉起服务验证
│  └─ oauth-login.mjs   本机一键跑完 OAuth2 授权回环（npm run login）
├─ data/
│  ├─ index.json        170 篇文档的结构化规格（100 个端点）
│  ├─ llms.txt          紧凑清单，给 AI 一次性读
│  ├─ status-codes.json 118 个错误码
│  └─ mock.json         43 个沙盒 mock 接口
└─ examples/
   ├─ bili_open.py      零依赖 Python 客户端（签名/请求/OAuth2/上传）
   ├─ video_upload.py   视频投稿全流程
   ├─ live_ws.py        直播间长连（WebSocket + 自定义二进制协议）
   ├─ node_client.mjs   Node 客户端
   ├─ sign_curl.sh      bash + openssl 签名
   └─ mcp-config.md     Claude / Cursor / Codex / OpenCode 接入配置
```

## 快速开始

```bash
cd D:/Documents/bilibili-open-docs/bili-open-mcp
npm install
npm run build        # 重新解析 170 篇文档
npm run audit        # 11 类一致性检查 → AUDIT PASSED
npm run selftest     # 工具 + 资源 + 提示 + 生成代码编译 → ALL SELFTEST PASSED
npm run check-config # 用 opencode 项目配置里的命令实际拉起服务
```

接入客户端见 [`examples/mcp-config.md`](examples/mcp-config.md)。

## 工具一览（19 个）

### 开放平台（签名 / OAuth2）

| 工具 | 作用 | 典型输入 |
| --- | --- | --- |
| `bili_quickstart` | 主机 / OAuth2 / 签名 / 错误码分段 / 沙盒 一次讲清 | `{}` |
| `bili_docs_search` | 170 篇全文检索 | `{"query":"投稿"}` |
| `bili_docs_list` | 按目录或类型列文档 | `{"folder":"直播能力"}` |
| `bili_docs_get` | 读某篇完整 Markdown | `{"ref":"44"}` |
| `bili_endpoints` | 按 method/scope/host/关键词过滤端点 | `{"scope":"SHOP_ORDER_INFO","method":"POST"}` |
| `bili_scopes` | 权限点 ↔ 端点映射 | `{"scope":"ARC_BASE"}` |
| `bili_api_spec` | 结构化接口规格（参数/必填/响应/子结构） | `{"ref":"12"}` |
| `bili_api_prepare` | 参数类型转换 + 必填校验 + 多余字段检查 | `{"ref":"12","body":{...}}` |
| `bili_codegen` | 生成调用代码（python/node/curl/java/php/go） | `{"ref":"12","lang":"python"}` |
| `bili_api_sign` | 生成签名头 + 可粘贴 curl | `{"url":"...","body":{...}}` |
| `bili_api_call` | 真调接口（或 `dryRun:true` 只看请求） | `{"ref":"5"}` |
| `bili_oauth` | 授权链接 / code 换 token / refresh 续期 / 凭据体检 | `{"action":"authorize-url","gourl":"..."}` |
| `bili_upload_plan` | 投稿分片计划（片数、offset、调用顺序） | `{"fileSizeMB":250}` |
| `bili_webhook` | 41 个推送事件 + 验签代码 | `{"action":"verify-code","lang":"python"}` |
| `bili_ws_protocol` | 直播长连协议 + 客户端骨架 | `{"code":"python"}` |
| `bili_mock` | 沙盒 mock 换算与调用 | `{"action":"map","ref":"12"}` |
| `bili_error_lookup` | 错误码含义 / 前缀批量 | `{"code":"1270","fuzzy":true}` |

### 主站 Web（浏览器 Cookie）

主站走 Cookie，不走 2.0 签名，两套体系互不通用。

| 工具 | 作用 | 典型输入 |
| --- | --- | --- |
| `bili_cookie` | Cookie 罐：状态 / 登录态体检 / 导入 / 设置 / 导出 | `{"action":"whoami"}` |
| `bili_web_call` | 带 Cookie 调 `*.bilibili.com` Web 接口，POST 自动补 csrf，`/wbi/` 自动签名 | `{"path":"x/web-interface/nav"}` |

### wbi 签名

2023 起 `/x/space/wbi/*`、`/x/polymer/*`、`/x/v2/reply/wbi/*` 这些要 wbi 签名。
`bili_web_call` 按路径自动判断（`wbi:true/false` 可强制），做的是：

1. 从 `/x/web-interface/nav` 的 `data.wbi_img` 取 `img_key` / `sub_key`
2. 按固定重排表拼出 32 位 `mixin_key`
3. 参数按字典序 → 去掉 `!'()*` → urlencode → 末尾接 `mixin_key` → md5 = `w_rid`
4. 请求带上 `wts` + `w_rid`

实测：`/x/space/wbi/acc/info?mid=<uid>` 带签名 `code:0`，`wbi:false` 则 `-403 访问权限不足`。

顺带一个坑：`/x/space/wbi/arc/search`（投稿列表）现在直接 `-403`，补 `dm_img_list`/`dm_img_str`/`dm_img_inter`
三件套也没用；**旧路径 `/x/space/arc/search` 仍然 `code:0` 可用**。

### 举报

两个入口，别混：

| 报什么 | 接口 | 关键参数 |
| --- | --- | --- |
| **用户**（资料/稿件/评论/动态/私信/专栏） | `POST /x/space/report` | `mid` + `reason` + `scene` + `tag_version` |
| 单条评论 | `POST /x/v2/reply/report` | `type` + `oid` + `rpid` + `reason` |

**`/x/space/report`** —— 按 `mid` 举报，body 是 urlencoded，csrf 自动带：

```json
{ "mid": 3546657551551003, "reason": 5, "scene": 1, "tag_version": 1 }
```

`scene` 与 `reason` 的合法组合由 `GET /x/space/report/options` 决定（**以它返回的为准，别写死**）：

| reason | 含义 | 可用 scene |
| --- | --- | --- |
| 5 | 传播色情/赌博/垃圾广告资源、诱导交易 | 1,2,3,4,5,6,7 |
| 1 | 色情低俗 | 1,2,3,4,5,6,7 |
| 4 | 引战、人身攻击 | 1,2,3,4,5,6,7 |
| 3 | 违法违禁行为 | 1 |
| 2 | 虚假不实信息 | 1 |

| scene | 含义 |
| --- | --- |
| 1 | 用户资料（头像、签名、昵称） |
| 2 | 稿件 |
| 3 | 评论 |
| 4 | 动态 |
| 5 | 私信 |
| 6 | 专栏 |
| 7 | 其他（收藏夹、播单等） |

`tag_version` 也取自 `/options`（当前为 `1`）。

前端（`space.bilibili.com` 的 `index-*.js`）里就是这么调的：

```js
IC = ({mid, scene, reason, specific_reason, specific_reason_v2, tag_version}) =>
  Re.request({ url: "/x/space/report", method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    data: {mid, reason, scene, specific_reason, specific_reason_v2, tag_version} })
```

`specific_reason` / `specific_reason_v2` 没值时 axios 会丢掉，所以最小 body 是
`mid=<uid>&reason=<一位数>&scene=<一位数>&csrf=<32>` —— 实测 75 字节。

**`/x/v2/reply/report`** —— 报单条评论，需要 `oid`（稿件 aid）+ `rpid`：

```
reason: 0其他 1垃圾广告 2色情 3刷屏 4引战 5剧透 6政治 7人身攻击 8内容不相关 9违法违规
        10低俗 11非法网站 12赌博诈骗 13传播不实信息 14怂恿教唆 15侵犯隐私 16抢楼 17青少年不良
```

返回 `12008` 已举报过 / `12019` 举报过于频繁 / `-509` 请求过于频繁 / `-111` csrf 失败。
注意这个接口风控更紧，静默调用常见 `-352`。

拿 `oid`/`rpid` 的路子（都已实测）：

| 要什么 | 调用 |
| --- | --- |
| 某人的动态列表 | `/x/polymer/web-dynamic/v1/feed/space?host_mid=<uid>`（wbi）→ `id_str` |
| 动态正文 | `/x/polymer/web-dynamic/v1/detail?id=<id_str>`（wbi） |
| 某人的投稿 | `/x/space/arc/search?mid=<uid>&ps=20&pn=1`（旧路径，可用）→ `aid`/`bvid` |
| 稿件评论区 | `/x/v2/reply/wbi/main?oid=<aid>&type=1&mode=3`（wbi）→ `rpid` |

Cookie 存在 `secrets/cookies.json`（已在 `.gitignore` 里），路径可用 `BILI_COOKIE_FILE` 覆盖；
也可以直接 `BILI_COOKIE="SESSDATA=…; bili_jct=…"` 用环境变量注入。
`SESSDATA` 是账号凭证，工具默认脱敏输出，`reveal:true` 才显示原值。

---

## 两套凭据，别混

| | 开放平台 | 主站 Web |
| --- | --- | --- |
| 用什么 | `client_id` + `app_secret` + `access_token` | 浏览器 `Cookie`（`SESSDATA`/`bili_jct`） |
| 从哪来 | [open.bilibili.com](https://open.bilibili.com) 控制台 → 应用管理（需实名 + 开发者入驻） | 浏览器里登录 bilibili.com 后导出 cookie |
| 认证方式 | HMAC-SHA256 签名（`x-bili-*` 头） | 直接带 `Cookie` 头 |
| 存哪 | `secrets/open-platform.json`（`BILI_CRED_FILE`） | `secrets/cookies.json`（`BILI_COOKIE_FILE`） |
| 工具 | `bili_api_*` / `bili_oauth` / `bili_upload_plan` … | `bili_cookie` / `bili_web_call` |

**Cookie 里没有 `client_id` / `app_secret` / `access_token`** —— 这三个不是 cookie，任何 cookie 导出都拿不到。
反过来，`SESSDATA` 也换不来开放平台的 access_token。两边不能互填。

### 补上开放平台凭据

```bash
# 1. 去 open.bilibili.com 登录 → 实名认证 → 开发者入驻 → 应用管理 → 创建「网页应用」
#    授权回调域 填 http://127.0.0.1:8848/callback
# 2. 一键跑完授权回环（自动抓 code、换 token、写入 secrets/open-platform.json）
cd D:/Documents/bilibili-open-docs/bili-open-mcp
npm run login -- --client-id <ClientID> --secret <Secret>
```

跑完 `bili_api_call {ref:"#5"}` 就能发真实请求了。

凭据解析顺序：**显式参数 → 环境变量 → `secrets/open-platform.json`**。
用 `bili_oauth {action:"status"}` 可以看清每一格到底有没有、从哪来。

授权页 URL 格式（来自「接入指引 / 网页应用接入」，2025-03 新版页面）：

```
https://account.bilibili.com/pc/account-pc/auth/oauth?client_id=<ClientID>&gourl=<urlencoded 回调地址>&state=<随机串>
```

`gourl` 与应用里配的「授权回调域」不一致会报「不合法的授权请求」。
`bili_oauth {action:"authorize-url", gourl:"…"}` 会自动拼好并编码。

`ref` 接受 `#12`、`12`、`012`、文档 uuid、标题片段、接口 URL。

### 资源与提示

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| resource | `bili://catalog` | 170 篇压成的一页纸清单（llms.txt） |
| resource | `bili://doc/{ref}` | 单篇文档原文 Markdown |
| prompt | `integrate-bili-api` | 按开放平台规范生成接入任务说明（参数 `ref`） |

## 凭据

| 环境变量 | 说明 |
| --- | --- |
| `BILI_CLIENT_ID` | client_id（= `x-bili-accesskeyid`） |
| `BILI_APP_SECRET` | app_secret |
| `BILI_ACCESS_TOKEN` | OAuth2 access_token |

无凭据时文档类工具照常工作，`bili_api_sign` 会用占位值演示签名结构。

## 数据从哪来

`data/` 由 `scripts/build-spec.mjs` 从同级目录（`D:\Documents\bilibili-open-docs`）的 Markdown 生成。
文档本身来自开放平台的目录接口：

```
GET https://open.bilibili.com/arcopen/user/open-doc/view?id=4
```

`data.online_doc` 是整棵目录树，每个 Article 节点带 `md_url`。文档更新后重跑：

```bash
npm run build
```

## 统计

- 文档 170 篇：95 篇单接口 + 2 篇多接口（共 **100 个端点**）、41 个推送事件、30 篇指南、2 篇协议说明
- 1243 个参数对象，**100% 带类型**；359/364 个请求参数带「必传」标记
- 20 个 scope、118 个错误码

面向 AI 的完整使用契约见 [`AGENTS.md`](AGENTS.md)。数据一致性由 `npm run audit` 把关（11 类检查）。

## 注意

- 所有业务接口在 `https://member.bilibili.com`，OAuth 在 `https://api.bilibili.com`。
- 上传分片走 `https://openupos.bilivideo.com`，**裸二进制、不带签名头**，凭 url 上的 `upload_token` 鉴权。
- 稿件删除不可逆。