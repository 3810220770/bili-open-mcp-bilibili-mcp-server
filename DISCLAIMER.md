# 免责声明 / Disclaimer

## 1. 接口来源：全部为哔哩哔哩官方提供

本项目调用的**所有接口均为哔哩哔哩官方提供并公开的接口**，不存在私有接口、破解接口或绕过鉴权的接口。具体来源：

| 来源 | 地址 | 本项目用它做什么 |
| --- | --- | --- |
| 哔哩哔哩开放平台文档 | <https://open.bilibili.com/doc/4>、<https://openhome.bilibili.com/doc/4/> | `data/*.json` 里的 170 篇文档 / 100 个端点规格，全部由 `scripts/build-spec.mjs` 从官方文档抓取生成 |
| 开放平台业务域名 | `member.bilibili.com` | 带 2.0 签名（HMAC-SHA256）的开放平台业务调用 |
| 开放平台 OAuth2 | `api.bilibili.com/x/account-oauth2/v1/*` | code 换 token、refresh_token 续期 |
| 开放平台上传域名 | `openupos.bilivideo.com` | 视频分片上传 |
| 主站 Web 接口 | `*.bilibili.com`（`api.bilibili.com`、`www.bilibili.com` 等） | 以使用者自己的浏览器 Cookie 身份调用官方 Web 接口 |
| 直播长连 | 官方直播间 WebSocket 协议 | `bili_ws_protocol` / `examples/live_ws.py` |

`data/status-codes.json`（118 个错误码）、`data/mock.json`（43 个沙盒 mock 接口）同样来自官方发布内容。

本项目**只做"按官方规则把请求拼好、把响应读回来"**这件事，不实现任何未公开的加密、不伪造凭证、不绕过多余的风控。请求头、签名算法、参数表都来自上面这些公开文档与官方前端代码。

## 2. 与哔哩哔哩无关

本项目是第三方工具，**与哔哩哔哩（上海幻电信息科技有限公司 / 上海宽娱数码科技有限公司）没有隶属、赞助或背书关系**。哔哩哔哩、bilibili、小电视等是其权利人的商标。

## 3. 凭据由使用者自备，缺失时功能受限

本项目**不内置、不收集、不上传任何凭据**。两套凭据都由使用者自己放进本地文件：

| 凭据 | 文件 | 覆盖变量 | 没有它 → 用不了 |
| --- | --- | --- | --- |
| 开放平台 `client_id` / `app_secret` / `access_token` | `secrets/open-platform.json` | `BILI_CRED_FILE` | 全部开放平台接口：`bili_api_sign` / `bili_api_call` / `bili_upload_plan` / `bili_scopes` / `bili_oauth`（除 `help`、`status`）|
| 主站 Cookie（`SESSDATA` / `bili_jct` 等） | `secrets/cookies.json` | `BILI_COOKIE_FILE` | `bili_cookie` / `bili_web_call`：登录态体检、导航栏、关系、黑名单、举报、投稿查询等一切主站 Web 调用 |

**没有 `BILI_COOKIE_FILE` 和 `BILI_CRED_FILE`，上述功能一律不可用。** 此时仍然可用的只有纯本地的部分：

- `bili_docs_search` / `bili_docs_list` / `bili_docs_get` —— 检索本地已有的 170 篇文档规格
- `bili_quickstart` / `bili_error_lookup` / `bili_status_codes` / `bili_ws_protocol` / `bili_webhook` / `bili_scopes` —— 本地知识查询
- `bili_codegen` —— 生成调用代码（不发送请求）
- `bili_mock` —— 打官方沙盒 mock（不需要任何凭据）
- `bili_oauth {action:"help"|"status"}` —— 只看说明与凭据体检
- `bili_api_sign` / `bili_api_call {dryRun:true}` —— 只演示签名结构与将要发出的请求

拿凭据的方式：

- 开放平台：登录 <https://open.bilibili.com> → 实名认证 + 开发者入驻 → 应用管理 → 创建应用 → 拿 `Client ID` / `Secret`，再跑 `npm run login` 换 `access_token`
- 主站 Cookie：浏览器登录 bilibili.com 后，用导出插件导出后 `bili_cookie {action:"import"}`

两个文件所在目录已在 `.gitignore` 中排除，**不要把 `secrets/` 提交到任何仓库**。

## 4. 使用者责任

- 使用者应遵守[哔哩哔哩用户协议](https://www.bilibili.com/protocal/licence.html)、[社区公约](https://www.bilibili.com/blackboard/help.html)、[开放平台开发者协议](https://open.bilibili.com/) 及当地法律法规。
- 请自行控制请求频率。官方明确将"短时间内大量操作 API"列为滥用行为，滥用会导致**调用者自己的账号被封停或限流**（常见返回 `-352` / `-509` / `12019`）。
- 本项目提供的接口调用能力可用于读取你自己的数据、管理你自己的账号、以你的身份提交内容。**用这些接口做什么，责任在使用者**，与作者无关。
- `SESSDATA` 等同于账号登录凭证。泄露它等于交出账号。请勿在日志、截图、Issue、对话中暴露，本项目默认对所有凭据做脱敏输出，`reveal:true` 才会显示原值。

## 5. 无担保

本项目按"现状"提供，不附带任何明示或暗示的担保。官方接口随时可能变更，本项目不做保证，也不对因使用本项目造成的任何直接或间接损失承担责任。

## 6. 如需下架

如果你是权利人，认为本仓库内容侵犯了你的权益，请开 Issue 或联系仓库所有者，会尽快处理。
