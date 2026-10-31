#!/usr/bin/env node
/**
 * bili-open-mcp — 哔哩哔哩开放平台 API 的 MCP 服务
 *
 * 面向 AI 的使用顺序（见 instructions）：
 *   bili_quickstart → bili_docs_search / bili_docs_list → bili_api_spec
 *   → bili_api_sign（dry-run 看请求）→ bili_api_call（带凭据真调）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { signHeaders, toCurl, md5, EMPTY_MD5 } from "./signer.mjs";
import { callApi, resolveCreds } from "./client.mjs";
import { QUICKSTART, OAUTH_HELP, WS_PROTOCOL, WEBHOOK_NOTES } from "./knowledge.mjs";
import { GENERATORS, LANGS, effectiveParams, sampleValue, genWebhookVerifier, genWsClient } from "./codegen.mjs";
import { loadJar, saveJar, parseCookies, cookieHeader, jarStatus, mask } from "./cookies.mjs";
import { credStatus, saveCredFile, loadCredFile } from "./credentials.mjs";
import { getWbiKeys, encWbi, needsWbi } from "./wbi.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "..", "data");

const INDEX = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "index.json"), "utf8"));
const STATUS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "status-codes.json"), "utf8"));
let MOCK = { entries: [] };
try {
  MOCK = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "mock.json"), "utf8"));
} catch {
  /* 未生成时降级为空 */
}
const DOC_ROOT = INDEX.docRoot;
const DOCS = INDEX.docs;

// 主站 Web 隐藏能力目录（data/web.json）—— 开放平台文档里没有的那些接口
let WEB = { groups: [], statusLegend: [] };
try {
  WEB = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "web.json"), "utf8"));
} catch {
  /* 未生成时降级为空 */
}
const WEB_ITEMS = (WEB.groups || []).flatMap((g) =>
  g.items.map((it) => Object.assign({}, it, { groupId: g.id, groupName: g.name }))
);
const WEB_STATUS = (k) => (WEB.statusLegend || []).find((s) => s.k === k) || { k, label: k, desc: "" };

// ---------------------------------------------------------------- helpers
const fileCache = new Map();
function readDocBody(d) {
  if (fileCache.has(d.file)) return fileCache.get(d.file);
  let t = "";
  try {
    t = fs.readFileSync(path.join(DOC_ROOT, d.file), "utf8");
  } catch {
    t = "";
  }
  fileCache.set(d.file, t);
  return t;
}

function resolveRef(ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) return null;
  const asNum = raw.replace(/^#/, "").replace(/^0+(?=\d)/, "");
  return (
    DOCS.find((d) => String(d.num) === asNum) ||
    DOCS.find((d) => d.id === raw) ||
    DOCS.find((d) => d.file === raw) ||
    DOCS.find((d) => d.title === raw) ||
    DOCS.find((d) => d.url === raw) ||
    DOCS.find((d) => d.title.includes(raw)) ||
    DOCS.find((d) => d.path.includes(raw)) ||
    null
  );
}

function resolveEndpoint(ref) {
  const d = resolveRef(ref);
  if (!d) return null;
  if (d.url && d.method) return { doc: d, method: d.method, url: d.url };
  if (d.endpoints?.length === 1) return { doc: d, method: d.endpoints[0].method, url: d.endpoints[0].url };
  return { doc: d, method: d.method || "", url: d.url || "" };
}

const shortPath = (u) => String(u || "").replace(/^https?:\/\/[^/]+/, "");
const req = (p) => (p === true ? "必填" : p === false ? "可选" : "");
const paramLine = (p) => {
  const indent = p.depth ? "  ".repeat(p.depth) : "";
  return `${indent}- ${p.name} (${p.type || "any"}${p.required !== undefined ? ", " + req(p.required) : ""})${p.desc ? ": " + p.desc : ""}`;
};

function summaryLine(d) {
  const bits = [`#${d.num}`, `[${d.type}]`, d.title];
  const s = bits.join(" ");
  const tail = [d.method && shortPath(d.url) ? `${d.method} ${shortPath(d.url)}` : "", d.folder].filter(Boolean).join("  ·  ");
  return tail ? `${s}\n    ${tail}` : s;
}

function snippet(text, q, span = 90) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return "";
  const a = Math.max(0, i - span);
  const b = Math.min(text.length, i + q.length + span);
  return (a > 0 ? "…" : "") + text.slice(a, b).replace(/\s+/g, " ").trim() + (b < text.length ? "…" : "");
}

function specText(d) {
  const L = [];
  L.push(`# ${d.title}  [${d.type}]`);
  L.push(`doc: #${d.num}  id: ${d.id}  file: ${d.file}`);
  L.push(`folder: ${d.folder}`);
  if (d.scopes?.length) L.push(`scope: ${d.scopes.join(", ")}`);
  if (d.signVersion) L.push(`⚠ signVersion: ${d.signVersion}（非 2.0）`);
  if (d.url) L.push(`${d.method || "?"} ${d.url}`);
  if (d.endpoints?.length > 1) {
    L.push(`endpoints:`);
    for (const e of d.endpoints) L.push(`  - ${e.method || "?"} ${e.url}`);
  }
  if (d.summary) L.push("", d.summary);
  if (d.hints?.length) L.push("", "## 注意", ...d.hints.map((h) => "- " + h));
  if (d.urlParams?.length) L.push("", "## url 参数", ...d.urlParams.map(paramLine));
  if (d.bodyParams?.length) L.push("", "## body 参数", ...d.bodyParams.map(paramLine));
  if (d.responseParams?.length) L.push("", "## 响应", ...d.responseParams.map(paramLine));
  if (d.subSchemas?.length) {
    for (const s of d.subSchemas) L.push("", `## 子结构：${s.title}`, ...s.params.map(paramLine));
  }
  if (d.requestExample) L.push("", "## 请求样例", "```", d.requestExample.slice(0, 1800), "```");
  if (d.responseExample) L.push("", "## 响应样例", "```", d.responseExample.slice(0, 1200), "```");
  if (d.type === "api") {
    L.push("", "## 调用方式", `bili_api_call { "ref": ${JSON.stringify(String(d.num))}, "query": {...}, "body": {...} }`);
  }
  return L.join("\n");
}

// ---------------------------------------------------------------- server
const INSTRUCTIONS = `哔哩哔哩开放平台 (open.bilibili.com/doc/4) API 助手。100 个 HTTP 端点 + 41 个推送事件 + 长连协议。详细契约见包内 AGENTS.md。

工作流:
1) 不确定接口名 → bili_docs_search {query} / bili_endpoints 过滤 / bili_docs_list 浏览
2) 拿到 ref(#num) → bili_api_spec {ref} 看参数/必填/响应/子结构
3) 要写代码 → bili_codegen {ref, lang} 出可运行骨架（自己拼签名容易错）
4) 参数不确定 → bili_api_prepare {ref, body} 做类型转换与必填校验
5) 要发请求 → bili_api_call {ref, query, body}；没凭据就 bili_api_sign 出 curl
6) 沙盒联调 → bili_mock {action:"map"|"call", ref}
7) 报错码 → bili_error_lookup {code}

专题: bili_oauth(OAuth2) · bili_webhook(推送验签/事件) · bili_ws_protocol(直播长连) · bili_upload_plan(投稿分片计划) · bili_scopes(权限点)

主站 (www.bilibili.com) 是另一套体系，用浏览器 Cookie 而不是签名:
- bili_cookie {action:"status"|"whoami"|"import"|"set"|"export"}  管理 secrets/cookies.json
- bili_web_call {path:"x/web-interface/nav"}  带 Cookie 调主站 Web 接口（POST 自动补 csrf）
- Cookie 文件路径可用 BILI_COOKIE_FILE 覆盖；SESSDATA 是账号凭证，默认脱敏输出

凭据文件在哪: secrets/cookies.json 与 secrets/open-platform.json 的查找顺序是
显式参数 → 环境变量(BILI_COOKIE_FILE / BILI_CRED_FILE) → 包目录 → 启动方 cwd。
放在包目录下 secrets/ 里最稳，不受客户端用什么 cwd 拉起服务的影响。

硬性约定:
- 主机: 业务 https://member.bilibili.com，OAuth https://api.bilibili.com，上传 https://openupos.bilivideo.com
- 所有业务接口走 2.0 签名 (HMAC-SHA256)，签名串是 6 个 x-bili-* 头按字典序 k:v 用 \\n 连接，末尾无换行
- x-bili-content-md5 = md5(body)；GET/空 body 用 md5("") = ${EMPTY_MD5}
- access-token 头 = OAuth2 换来的 access_token
- 返回 {code, message, data, request_id}，code=0 成功；HTTP 200 也可能是业务错误
- 凭据从环境变量读：BILI_CLIENT_ID / BILI_APP_SECRET / BILI_ACCESS_TOKEN
凭证缺失时不要臆造 token，直接输出签名样例让用户填。`;

const server = new McpServer(
  { name: "bili-open-mcp", version: "2.0.0" },
  { instructions: INSTRUCTIONS }
);

const text = (t) => ({ content: [{ type: "text", text: t }] });
const json = (o) => text(JSON.stringify(o, null, 1));

// 1. quickstart
server.registerTool(
  "bili_quickstart",
  {
    title: "开放平台速查",
    description:
      "返回哔哩哔哩开放平台的核心约定：主机、OAuth2 换 token/刷新、2.0 签名算法、通用返回结构、错误码分段、视频投稿技术限制。第一次使用或需要写对接代码前先调它。",
    inputSchema: {},
  },
  async () => text(QUICKSTART)
);

// 2. list
server.registerTool(
  "bili_docs_list",
  {
    title: "列出文档/接口",
    description:
      "按目录或类型列出开放平台文档。folder 支持包含匹配（如 \"视频稿件\"、\"直播\"、\"消息推送\"）；type 可选 api / guide / event / protocol / multi-api。返回每条含 ref(#num)、标题、METHOD 路径、所在目录。",
    inputSchema: {
      folder: z.string().optional().describe("目录名包含匹配，例如 视频稿件管理 / 交易电商 / 消息推送"),
      type: z.enum(["api", "guide", "event", "protocol", "multi-api"]).optional(),
      limit: z.number().int().min(1).max(200).optional().describe("默认 60"),
    },
  },
  async ({ folder, type, limit = 60 }) => {
    let list = DOCS;
    if (folder) list = list.filter((d) => d.path.includes(folder) || d.folder.includes(folder));
    if (type) list = list.filter((d) => d.type === type);
    const total = list.length;
    const shown = list.slice(0, limit);
    const head = `共 ${total} 条${total > shown.length ? `，显示前 ${shown.length}` : ""}`;
    return text([head, "", ...shown.map(summaryLine)].join("\n"));
  }
);

// 3. search
server.registerTool(
  "bili_docs_search",
  {
    title: "全文搜索文档",
    description:
      "在 170 篇开放平台文档里搜索接口名、字段名、错误信息、协议细节。先按标题/目录/摘要命中，再回退全文。返回 ref(#num) 可用于 bili_api_spec / bili_docs_get。",
    inputSchema: {
      query: z.string().min(1).describe("关键词，支持中文，如 投稿 / upload_token / 弹幕 / refresh_token"),
      limit: z.number().int().min(1).max(30).optional().describe("默认 8"),
    },
  },
  async ({ query, limit = 8 }) => {
    const q = query.toLowerCase();
    const scored = [];
    for (const d of DOCS) {
      let score = 0;
      let why = "";
      if (d.title.toLowerCase().includes(q)) (score += 100), (why = "title");
      if (d.path.toLowerCase().includes(q)) (score += 30), (why ||= "path");
      if ((d.summary || "").toLowerCase().includes(q)) (score += 20), (why ||= "summary");
      if ((d.url || "").toLowerCase().includes(q)) (score += 40), (why ||= "url");
      if (d.scopes?.some((s) => s.toLowerCase().includes(q))) (score += 25), (why ||= "scope");
      let snip = "";
      if (score < 100) {
        const body = readDocBody(d);
        const idx = body.toLowerCase().indexOf(q);
        if (idx >= 0) {
          score += 5;
          snip = snippet(body, query);
          why ||= "body";
        }
      }
      if (score > 0) scored.push({ d, score, why, snip });
    }
    scored.sort((a, b) => b.score - a.score || a.d.num - b.d.num);
    const top = scored.slice(0, limit);
    if (!top.length) {
      return text(`未找到 "${query}"。试试更短的关键词，或 bili_docs_list {folder:"开放能力"}。`);
    }
    const out = [`命中 ${scored.length} 条，显示 ${top.length}:`];
    for (const { d, why, snip } of top) {
      out.push("", `#${d.num} [${d.type}] ${d.title}  (${why})`);
      const tail = [d.method && d.url ? `${d.method} ${shortPath(d.url)}` : "", d.folder].filter(Boolean).join("  ·  ");
      if (tail) out.push(`    ${tail}`);
      if (snip) out.push(`    「${snip}」`);
    }
    out.push("", "用 bili_api_spec {ref:\"#num\"} 看参数。");
    return text(out.join("\n"));
  }
);

// 4. get doc
server.registerTool(
  "bili_docs_get",
  {
    title: "读取文档正文",
    description:
      "按 ref（#num / id / 标题 / 文件名 / 接口URL）返回文档完整 Markdown。协议、长连、Webhook 等非接口文档用它。maxChars 默认 40000。",
    inputSchema: {
      ref: z.string().describe("#12 / uuid / 标题含字 / 012_视频稿件提交.md"),
      maxChars: z.number().int().min(500).max(200000).optional(),
    },
  },
  async ({ ref, maxChars = 40000 }) => {
    const d = resolveRef(ref);
    if (!d) return text(`未找到文档: ${ref}。用 bili_docs_search 或 bili_docs_list 定位。`);
    const body = readDocBody(d);
    const meta = `doc: #${d.num}  id: ${d.id}  type: ${d.type}  folder: ${d.folder}  bytes: ${d.bytes}`;
    if (body.length > maxChars) {
      return text(`${meta}\n(截断到 ${maxChars}/${body.length} 字符，需要更多请提高 maxChars)\n\n---\n\n${body.slice(0, maxChars)}`);
    }
    return text(`${meta}\n\n---\n\n${body}`);
  }
);

// 5. api spec
server.registerTool(
  "bili_api_spec",
  {
    title: "接口结构化规格",
    description:
      "返回某个接口的方法、完整 URL、scope、url/body 参数（类型+是否必填+说明）、响应字段、请求与响应样例。这是写调用代码前该看的工具。",
    inputSchema: {
      ref: z.string().optional().describe("#12 / 标题 / URL"),
      url: z.string().optional().describe("直接按接口 URL 定位"),
    },
  },
  async ({ ref, url }) => {
    const key = ref || url;
    if (!key) return text("需要 ref 或 url。");
    const hit = resolveEndpoint(key);
    if (!hit) return text(`未找到接口: ${key}。用 bili_docs_search 找。`);
    return text(specText(hit.doc));
  }
);

// 6. sign
server.registerTool(
  "bili_api_sign",
  {
    title: "生成 2.0 签名头",
    description:
      "按开放平台规则生成 Authorization 与 x-bili-* 头，并输出可直接粘贴的 curl。凭据可用参数传入，否则读环境变量 BILI_CLIENT_ID / BILI_APP_SECRET / BILI_ACCESS_TOKEN。body 传对象会自动 JSON 序列化（GET 请忽略）。",
    inputSchema: {
      method: z.string().optional().describe("默认 GET"),
      url: z.string().describe("完整接口 URL"),
      query: z.record(z.any()).optional().describe("url 参数"),
      body: z.any().optional().describe("body 参数对象（GET 不需要）"),
      clientId: z.string().optional(),
      appSecret: z.string().optional(),
      accessToken: z.string().optional(),
    },
  },
  async ({ method = "GET", url, query, body, clientId, appSecret, accessToken }) => {
    try {
      let u = new URL(url);
      if (query) for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
      const m = method.toUpperCase();
      const bodyStr = m === "GET" || body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
      const c = resolveCreds({ clientId, appSecret, accessToken });
      const demo = !c.clientId || !c.appSecret;
      const eff = {
        clientId: c.clientId || "YOUR_CLIENT_ID",
        appSecret: c.appSecret || "YOUR_APP_SECRET",
        accessToken: c.accessToken || "YOUR_ACCESS_TOKEN",
      };
      const s = signHeaders({ ...eff, body: bodyStr });
      const curl = toCurl({ method: m, url: u.toString(), headers: s.headers, body: bodyStr });
      return text(
        [
          "## 待签名串",
          s.signingString,
          "",
          "## 请求头",
          ...Object.entries(s.headers).map(([k, v]) => `${k}: ${v}`),
          "",
          "## curl",
          curl,
          "",
          `content_md5=${s.contentMd5}  (body ${bodyStr ? "非空" : "为空，用 md5(\"\")"})`,
          demo ? "⚠ 未提供 clientId/appSecret，签名使用占位值 YOUR_CLIENT_ID / YOUR_APP_SECRET，仅演示结构；真实调用请设置环境变量。" : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (e) {
      return text(`签名失败: ${e.message}`);
    }
  }
);

// 7. call
server.registerTool(
  "bili_api_call",
  {
    title: "调用开放平台接口",
    description:
      "给 ref（#num/标题/URL）或直接 url，自动签名并发起真实请求。query/body 传对象。dryRun=true 时只返回将要发出的请求与 curl，不发送。凭据读 BILI_CLIENT_ID / BILI_APP_SECRET / BILI_ACCESS_TOKEN。",
    inputSchema: {
      ref: z.string().optional().describe("#12 / 标题 / 接口URL"),
      method: z.string().optional(),
      url: z.string().optional(),
      query: z.record(z.any()).optional(),
      body: z.any().optional(),
      dryRun: z.boolean().optional().describe("true=只签名不发送，默认 false"),
    },
  },
  async ({ ref, method, url, query, body, dryRun = false }) => {
    let m = method;
    let u = url;
    if ((!m || !u) && ref) {
      const hit = resolveEndpoint(ref);
      if (!hit) return text(`未找到接口: ${ref}`);
      m ||= hit.method;
      u ||= hit.url;
      if (!hit.url) return text(`#${hit.doc.num} 不是可直接调用的接口（type=${hit.doc.type}）。换一个接口或看 bili_docs_get。`);
    }
    if (!u) return text("需要 ref 或 url。");
    try {
      const r = await callApi({ method: m || "GET", url: u, query, body, dryRun });
      if (dryRun) {
        return text(
          [
            "## dryRun — 未发送",
            "```",
            r.curl,
            "```",
            "",
            "## 待签名串",
            r.signingString,
            r.demoCredentials ? "\n⚠ 无凭据，使用占位值 YOUR_CLIENT_ID / YOUR_APP_SECRET。" : "",
          ].join("\n")
        );
      }
      return json(r);
    } catch (e) {
      return text(`请求失败: ${e.message}\n提示: 确认 BILI_CLIENT_ID / BILI_APP_SECRET / BILI_ACCESS_TOKEN 已设置。`);
    }
  }
);

// 8. error lookup
server.registerTool(
  "bili_error_lookup",
  {
    title: "错误码查询",
    description: "查开放平台错误码含义。支持 4002 / 127007 这种完整码，也支持 4 位前缀模糊（如 1230 列出所有视频稿件码）。",
    inputSchema: {
      code: z.string().describe("错误码，如 4002"),
      fuzzy: z.boolean().optional().describe("true=按前缀列出，默认 false"),
    },
  },
  async ({ code, fuzzy = false }) => {
    const c = String(code).trim();
    if (!fuzzy && STATUS[c]) return text(`${c}: ${STATUS[c]}`);
    const keys = Object.keys(STATUS).filter((k) => k.startsWith(c));
    if (!keys.length) return text(`未收录错误码 ${c}。共收录 ${Object.keys(STATUS).length} 条。`);
    return text([`匹配 ${keys.length} 条:`, ...keys.map((k) => `- ${k}: ${STATUS[k]}`)].join("\n"));
  }
);

// ---------------------------------------------------------------- 新增工具组
const allEndpoints = () => DOCS.filter((d) => d.url && d.method);

// 9. endpoints
server.registerTool(
  "bili_endpoints",
  {
    title: "接口清单过滤",
    description:
      "按 method / scope / host / 路径关键词过滤端点，返回 #ref、METHOD、PATH、scope。适合「所有需要 SHOP_ORDER_INFO 的 POST 接口」这类问题，比全文搜索更准。默认最多 40 条。" +
      "source:\"web\" 时改列开放平台文档里没有的「隐藏能力」（主站 Web，如举报 / 拉黑 / 动态 / 评论 / 直播），source:\"all\" 两边一起列。默认最多 40 条。",
    inputSchema: {
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
      scope: z.string().optional().describe("权限点，如 ARC_BASE"),
      host: z.string().optional().describe("member.bilibili.com / openupos.bilivideo.com / api.bilibili.com"),
      pathContains: z.string().optional().describe("路径或标题关键词"),
      source: z.enum(["open", "web", "all"]).optional().describe("open=开放平台（默认），web=主站隐藏能力，all=两边都列"),
      limit: z.number().int().min(1).max(120).optional(),
    },
  },
  async ({ method, scope, host, pathContains, source = "open", limit = 40 }) => {
    const openPart = () => {
      let list = allEndpoints().filter((d) => d.type === "api");
      if (method) list = list.filter((d) => d.method === method.toUpperCase());
      if (scope) list = list.filter((d) => (d.scopes || []).includes(scope.toUpperCase()));
      if (host) list = list.filter((d) => new URL(d.url).host === host);
      if (pathContains) {
        const q = pathContains.toLowerCase();
        list = list.filter((d) => (d.url + d.title + d.path).toLowerCase().includes(q));
      }
      list.sort((a, b) => a.num - b.num);
      return list.map((d) => ({ kind: "open", d }));
    };
    const webPart = () => {
      let list = WEB_ITEMS.slice();
      if (method) list = list.filter((w) => String(w.method).toUpperCase() === method.toUpperCase());
      if (host) list = list.filter((w) => String(w.url).includes(host));
      if (pathContains) {
        const q = pathContains.toLowerCase();
        list = list.filter((w) => (w.name + w.url + w.groupName + (w.notes || []).join(" ")).toLowerCase().includes(q));
      }
      if (scope) list = [];
      return list.map((w) => ({ kind: "web", w }));
    };

    let rows = [];
    if (source === "open") rows = openPart();
    else if (source === "web") rows = webPart();
    else rows = openPart().concat(webPart());

    if (!rows.length) return text("没有匹配的端点。去掉一些过滤条件再试，或用 bili_docs_search。");
    const shown = rows.slice(0, limit);
    const line = (r) =>
      r.kind === "open"
        ? `#${r.d.num} ${r.d.method} ${shortPath(r.d.url)} ⟨${new URL(r.d.url).host}⟩  [${(r.d.scopes || ["—"]).join(",")}]  ${r.d.title}`
        : `web:${r.w.id} ${r.w.method} ${shortPath(r.w.url)} ⟨${new URL(r.w.url).host}⟩  [${WEB_STATUS(r.w.status).label}]  ${r.w.name}`;
    return text(
      [
        `命中 ${rows.length} 条${rows.length > shown.length ? `，显示前 ${shown.length}` : ""}${source === "all" ? "（开放平台 + 主站隐藏能力）" : ""}`,
        "",
        ...shown.map(line),
        source === "open" && WEB_ITEMS.length ? `\n另有 ${WEB_ITEMS.length} 个主站隐藏能力：bili_endpoints { source: "web" }` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
);

// 10. scopes
server.registerTool(
  "bili_scopes",
  {
    title: "权限点（scope）查询",
    description:
      "不带参数：列出全部 scope 及覆盖的端点数。带 scope：列出该 scope 下所有端点。带 ref：返回该接口需要的 scope 及每个 scope 下的其它接口。用于确认应用该申请哪些权限。",
    inputSchema: {
      scope: z.string().optional(),
      ref: z.string().optional(),
    },
  },
  async ({ scope, ref }) => {
    const eps = allEndpoints();
    const index = new Map();
    for (const d of eps) for (const s of d.scopes || []) {
      if (!index.has(s)) index.set(s, []);
      index.get(s).push(d);
    }
    if (ref) {
      const d = resolveRef(ref);
      if (!d) return text(`未找到: ${ref}`);
      const out = [`#${d.num} ${d.title}`, `scope: ${(d.scopes || []).join(", ") || "(文档未标注)"}`, ""];
      for (const s of d.scopes || []) {
        const list = index.get(s) || [];
        out.push(`## ${s}（${list.length} 个端点）`);
        for (const x of list) out.push(`- #${x.num} ${x.method} ${shortPath(x.url)}  ${x.title}`);
        out.push("");
      }
      return text(out.join("\n"));
    }
    if (scope) {
      const list = (index.get(scope.toUpperCase()) || []).sort((a, b) => a.num - b.num);
      if (!list.length) return text(`没有端点使用 scope ${scope}。用 bili_scopes 不带参数看全部。`);
      return text(
        [`scope ${scope.toUpperCase()} 共 ${list.length} 个端点:`, "", ...list.map((d) => `- #${d.num} ${d.method} ${shortPath(d.url)}  ${d.title}`)].join("\n")
      );
    }
    const rows = [...index.entries()].sort((a, b) => b[1].length - a[1].length);
    return text(
      [
        `共 ${rows.length} 个 scope，${eps.filter((d) => d.scopes?.length).length} 个端点带标注:`,
        "",
        ...rows.map(([s, list]) => `- ${s}: ${list.length} 个端点  (例: #${list[0].num} ${list[0].title})`),
        "",
        '用 bili_scopes {scope:"ARC_BASE"} 看明细。',
      ].join("\n")
    );
  }
);

// 11. api_prepare
server.registerTool(
  "bili_api_prepare",
  {
    title: "参数校验与类型转换",
    description:
      "把 query/body 按文档类型做转换（int→数字、bool→布尔、[]x→数组），检查必填是否缺失、是否多传了文档没有的字段，并给出最终 URL/body 与签发 curl 的下一步。写代码前用它避免类型错误。",
    inputSchema: {
      ref: z.string(),
      query: z.record(z.any()).optional(),
      body: z.record(z.any()).optional(),
    },
  },
  async ({ ref, query = {}, body = {} }) => {
    const d = resolveRef(ref);
    if (!d) return text(`未找到接口: ${ref}`);
    if (!d.url) return text(`#${d.num} 不是可直接调用的接口（type=${d.type}）。`);
    const { query: qSpec, body: bSpec, getLike } = effectiveParams(d);

    const coerce = (v, t) => {
      const ty = String(t || "").toLowerCase();
      if (/^\[\]|\[\]$|^array|^list/.test(ty)) {
        if (Array.isArray(v)) return v.map((x) => coerce(x, "string"));
        if (typeof v === "string") return v.split(",").map((x) => x.trim());
        return [v];
      }
      if (/bool/.test(ty) && typeof v === "string") return /^(true|1|yes|是)$/i.test(v);
      if (/int|long|float|double|number|uint/.test(ty) && typeof v === "string" && v !== "" && !isNaN(Number(v)))
        return Number(v);
      return v;
    };

    const check = (spec, values, label) => {
      const out = {};
      const missing = [];
      const unknown = Object.keys(values).filter((k) => !spec.some((p) => p.name === k));
      const notes = [];
      for (const p of spec) {
        const has = Object.prototype.hasOwnProperty.call(values, p.name);
        if (!has) {
          if (p.required) missing.push(`${p.name} (${p.type}) ${p.desc || ""}`.trim());
          continue;
        }
        const coerced = coerce(values[p.name], p.type);
        out[p.name] = coerced;
        const orig = values[p.name];
        if (typeof orig !== typeof coerced && !(Array.isArray(orig) && Array.isArray(coerced)))
          notes.push(`${p.name}: ${JSON.stringify(orig)} → ${JSON.stringify(coerced)} (${p.type})`);
      }
      return { out, missing, unknown, notes, label };
    };

    const qc = check(qSpec, query, "query");
    const bc = check(bSpec, body, "body");

    const url = new URL(d.url);
    for (const [k, v] of Object.entries(qc.out))
      if (v !== undefined && v !== null) url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));

    const bodyStr = d.method === "GET" && !bc.out ? "" : JSON.stringify(bc.out);
    const c = resolveCreds({});
    const demo = !c.clientId || !c.appSecret;
    const headers = signHeaders({
      clientId: c.clientId || "YOUR_CLIENT_ID",
      appSecret: c.appSecret || "YOUR_APP_SECRET",
      accessToken: c.accessToken || "YOUR_ACCESS_TOKEN",
      body: bodyStr,
    }).headers;

    const out = [`# ${d.title}  (#${d.num})`, `${d.method} ${url.toString()}`, ""];
    if (getLike && (d.bodyParams?.length || 0) > 0)
      out.push("⚠ 文档把参数列在 body 参数下，但方法是 " + d.method + "：已按 query 归位。", "");
    if (qc.missing.length) out.push("## query 缺必填", ...qc.missing.map((m) => "- " + m), "");
    if (bc.missing.length) out.push("## body 缺必填", ...bc.missing.map((m) => "- " + m), "");
    if (qc.unknown.length) out.push("## query 多传（文档未列出，会被忽略或报错）", ...qc.unknown.map((m) => "- " + m), "");
    if (bc.unknown.length) out.push("## body 多传（文档未列出）", ...bc.unknown.map((m) => "- " + m), "");
    if (qc.notes.length || bc.notes.length)
      out.push("## 类型已转换", ...[...qc.notes, ...bc.notes].map((m) => "- " + m), "");
    out.push("## 最终 query", "```json", JSON.stringify(qc.out, null, 2), "```");
    out.push("", "## 最终 body", "```json", bodyStr || "(空)", "```");
    out.push(
      "",
      "## 下一步",
      `- 真调: bili_api_call { "ref": ${JSON.stringify(String(d.num))}, "query": ..., "body": ... }`,
      `- 看签名: bili_api_sign { "url": ${JSON.stringify(d.url)}, "body": ... }`,
      demo ? "\n(未配置凭据，上面的签名头是占位示例)" : ""
    );
    return text(out.filter(Boolean).join("\n"));
  }
);

// 12. codegen
server.registerTool(
  "bili_codegen",
  {
    title: "生成接口调用代码",
    description:
      "按接口规格生成可运行代码骨架，含完整 2.0 签名实现、该接口的全部参数（必填直接写入、可选注释掉）、返回码处理。lang 支持 python / node / curl / java / php / go。比手写签名可靠。",
    inputSchema: {
      ref: z.string(),
      lang: z.enum(["python", "node", "curl", "java", "php", "go"]).optional().describe("默认 python"),
    },
  },
  async ({ ref, lang = "python" }) => {
    const d = resolveRef(ref);
    if (!d) return text(`未找到接口: ${ref}。`);
    if (!d.url || !d.method) return text(`#${d.num} 不是 HTTP 接口（type=${d.type}）。用 bili_docs_get {ref:"${d.num}"} 读正文。`);
    const gen = GENERATORS[lang];
    if (!gen) return text(`不支持的语言: ${lang}。可选: ${LANGS.join(", ")}`);
    const code = gen(d);
    const fence = lang === "curl" ? "bash" : lang;
    return text(
      [
        `# ${d.title}  (#${d.num})  →  ${lang}`,
        `支持的语言: ${LANGS.join(", ")}`,
        "",
        "```" + fence,
        code,
        "```",
        "",
        "TODO 处需填真实值；返回码判断已写好（code != 0 即失败）。",
      ].join("\n")
    );
  }
);

// 13. upload_plan
server.registerTool(
  "bili_upload_plan",
  {
    title: "视频投稿分片计划",
    description:
      "给文件大小，算出该用单文件还是分片、分几片、每片范围、part_number 起止，并输出完整调用顺序（init → upload → complete → 提交）与可直接粘的 curl。",
    inputSchema: {
      fileSizeBytes: z.number().optional(),
      fileSizeMB: z.number().optional().describe("与 fileSizeBytes 二选一"),
      chunkMB: z.number().optional().describe("默认 10MB"),
      filename: z.string().optional(),
    },
  },
  async ({ fileSizeBytes, fileSizeMB, chunkMB = 10, filename = "video.mp4" }) => {
    const bytes = fileSizeBytes ?? (fileSizeMB != null ? Math.round(fileSizeMB * 1024 * 1024) : null);
    if (bytes == null) return text("需要 fileSizeBytes 或 fileSizeMB。");
    const CH = Math.max(1, chunkMB) * 1024 * 1024;
    const single = bytes <= 100 * 1024 * 1024;
    const parts = Math.ceil(bytes / CH);
    const rows = [];
    for (let n = 1; n <= parts; n++) {
      const start = (n - 1) * CH;
      const end = Math.min(bytes, n * CH) - 1;
      rows.push(`| ${n} | ${start} | ${end} | ${end - start + 1} |`);
    }
    return text(
      [
        `# 投稿上传计划`,
        `文件: ${filename}  ${(bytes / 1024 / 1024).toFixed(1)} MB`,
        `模式: ${single ? "单文件（≤100MB，utype=1）" : `分片（${chunkMB}MB/片，utype=0）`}`,
        single ? `请求数: 3（init → upload → 提交）` : `分片数: ${parts}，请求数: ${parts + 3}`,
        "",
        "## 调用顺序",
        `1. POST /arcopen/fn/archive/video/init          body {"name":"${filename}","utype":"${single ? "1" : "0"}"}  → upload_token`,
        single
          ? `2. POST https://openupos.bilivideo.com/video/v2/upload?upload_token=<token>   body=裸文件字节`
          : `2. POST https://openupos.bilivideo.com/video/v2/part/upload?upload_token=<token>&part_number=N   body=裸分片字节  ×${parts}`,
        ...(single ? [] : [`3. POST /arcopen/fn/archive/video/complete        url upload_token=<token>`]),
        `${single ? 3 : 4}. POST /arcopen/fn/archive/add-by-utoken   url upload_token=<token>   body 见 #12`,
        "",
        ...(single
          ? []
          : ["## 分片表", "| part_number | 起始 offset | 结束 offset | 字节数 |", "| --- | --- | --- | --- |", ...rows, ""]),
        "## 要点",
        "- 分片 body 是**裸二进制**，不要 multipart/form-data，否则转码失败",
        "- part_number **从 1 开始连续递增**（不是 0），除最后一片外必须等大",
        "- 上传接口**不带任何 X-Bili-* 签名头**，凭 url 上的 upload_token 鉴权",
        "- 可以直接按 offset/length 读原文件，不必物理切片",
        "",
        "## 生成脚本",
        `- bili_codegen { "ref": "8", "lang": "python" }  → 预处理`,
        `- 完整流程示例: examples/video_upload.py`,
        `- 无需真调验证: bili_api_call { "ref": "8", "dryRun": true }`,
      ].join("\n")
    );
  }
);

// 14. oauth
server.registerTool(
  "bili_oauth",
  {
    title: "OAuth2 授权链路 / 换 token / 续期 / 状态",
    description:
      "action=help 讲清整条链路；authorize-url 拼出授权页链接；status 看 clientId/secret/token 各自有没有、从哪来；exchange 用 code 换 access_token；refresh 续期（refresh_token 只能用一次）。换到的 token 会自动写入 secrets/open-platform.json。凭据取自参数、BILI_CLIENT_ID/BILI_APP_SECRET 或该文件。",
    inputSchema: {
      action: z.enum(["help", "status", "authorize-url", "exchange", "refresh"]).optional().describe("默认 help"),
      code: z.string().optional(),
      refreshToken: z.string().optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      gourl: z.string().optional().describe("authorize-url 用：授权回调地址，须与应用「授权回调域」一致"),
      state: z.string().optional().describe("authorize-url 用：随机串，默认自动生成"),
    },
  },
  async ({ action = "help", code, refreshToken, clientId, clientSecret, gourl, state }) => {
    if (action === "help") return text(OAUTH_HELP);

    if (action === "status") {
      const s = credStatus({ clientId, appSecret: clientSecret });
      const line = (name, v) => `- ${v.set ? "✅" : "❌"} ${name.padEnd(14)} ${v.set ? "来自 " + v.from : "未配置"}`;
      return text(
        [
          "# 开放平台凭据状态",
          "",
          line("clientId", s.clientId),
          line("appSecret", s.appSecret),
          line("accessToken", s.accessToken),
          line("refreshToken", s.refreshToken),
          "",
          `凭据文件: ${s.file}${s.fileExists ? "" : "（不存在）"}`,
          s.fileError ? `文件解析失败: ${s.fileError}` : "",
          s.expiresIn ? `access_token 到期(UTC): ${new Date(s.expiresIn * 1000).toISOString()}` : "",
          s.scopes?.length ? `已授权 scopes: ${s.scopes.join(", ")}` : "",
          "",
          s.clientId.set && s.appSecret.set
            ? "→ 下一步: bili_oauth {action:\"authorize-url\", gourl:\"<回调地址>\"} 拿授权链接"
            : "→ 先去 https://open.bilibili.com 控制台创建应用，拿到 Client ID 与 Secret（或 npm run login 按提示填）",
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (action === "authorize-url") {
      const c = resolveCreds({ clientId, appSecret: clientSecret });
      if (!c.clientId) return text("缺少 clientId：去开放平台应用详情页拿 Client ID，或在 secrets/open-platform.json 里填。");
      if (!gourl) return text("需要 gourl（授权回调地址），必须与应用配置的「授权回调域」一致。");
      const st = state || Math.random().toString(36).slice(2) + Date.now().toString(36);
      const u =
        "https://account.bilibili.com/pc/account-pc/auth/oauth" +
        `?client_id=${encodeURIComponent(c.clientId)}&gourl=${encodeURIComponent(gourl)}&state=${encodeURIComponent(st)}`;
      return text(
        [
          "# 授权页链接（PC）",
          "```",
          u,
          "```",
          `gourl (URL encoded): ${encodeURIComponent(gourl)}`,
          `state: ${st}`,
          "",
          "授权成功后 B 站会 302 到:  " + gourl + "?code=<code>&state=" + st,
          "拿到 code 后立刻:  bili_oauth {action:\"exchange\", code:\"<code>\"}",
          "",
          "注意:",
          "- gourl 与应用的「授权回调域」不一致 → 授权页报「不合法的授权请求」",
          "- code 一次性、短时效",
          "- 想自动跑完整个回环: npm run login",
        ].join("\n")
      );
    }

    const c = resolveCreds({ clientId, appSecret: clientSecret });
    if (!c.clientId || !c.appSecret) return text("缺少 clientId / appSecret（可用参数传，或设置 BILI_CLIENT_ID / BILI_APP_SECRET）。");
    const form = new URLSearchParams();
    form.set("client_id", c.clientId);
    form.set("client_secret", c.appSecret);
    if (action === "exchange") {
      if (!code) return text("exchange 需要 code。");
      form.set("grant_type", "authorization_code");
      form.set("code", code);
    } else {
      if (!refreshToken) return text("refresh 需要 refreshToken。");
      form.set("grant_type", "refresh_token");
      form.set("refresh_token", refreshToken);
    }
    const url =
      "https://api.bilibili.com/x/account-oauth2/v1/" + (action === "exchange" ? "token" : "refresh_token");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const json = await res.json().catch(() => null);
      const expanded = json?.data?.expires_in
        ? new Date(json.data.expires_in * 1000).toISOString()
        : null;
      let saved = null;
      if (json?.code === 0 && json?.data?.access_token) {
        const patch = { clientId: c.clientId, appSecret: c.appSecret, accessToken: json.data.access_token };
        if (json.data.refresh_token) patch.refreshToken = json.data.refresh_token;
        if (json.data.expires_in) patch.expires_in = json.data.expires_in;
        if (Array.isArray(json.data.scopes)) patch.scopes = json.data.scopes;
        saved = saveCredFile(patch);
      }
      const masked = json
        ? {
            ...json,
            data: json.data
              ? {
                  ...json.data,
                  access_token: json.data.access_token ? mask(json.data.access_token) : undefined,
                  refresh_token: json.data.refresh_token ? mask(json.data.refresh_token) : undefined,
                }
              : json.data,
          }
        : "(非 JSON 响应)";
      return text(
        [
          `POST ${url}  →  HTTP ${res.status}`,
          "```json",
          JSON.stringify(masked, null, 2),
          "```",
          expanded ? `\nexpires_in=${json.data.expires_in} → ${expanded}（UTC 绝对时间）` : "",
          saved ? `\n✅ 已写入 ${saved.file}（access_token / refresh_token 都存了，下次直接可用）` : "",
          action === "refresh" && json?.data?.refresh_token
            ? "\n⚠ refresh_token 是一次性的：旧的已失效，新的已存进文件。"
            : "",
          "\n（不要把 client_secret / access_token 写进日志或前端。）",
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (e) {
      return text(`请求失败: ${e.message}`);
    }
  }
);

// 15. webhook
server.registerTool(
  "bili_webhook",
  {
    title: "消息推送（Webhook）",
    description:
      "action=list 列出 41 个推送事件（按模块分组）；action=detail 看某个事件的内容字段；action=verify-code 生成验签 + verify_webhooks 应答代码（python/node）。验签用 SHA1(secret + 原始 body)，必须用原始字节。",
    inputSchema: {
      action: z.enum(["list", "detail", "verify-code", "notes"]).optional().describe("默认 list"),
      ref: z.string().optional().describe("detail 用，#num 或事件名"),
      lang: z.enum(["python", "node"]).optional().describe("verify-code 用，默认 python"),
    },
  },
  async ({ action = "list", ref, lang = "python" }) => {
    if (action === "notes") return text(WEBHOOK_NOTES);
    if (action === "verify-code") {
      return text(
        [
          "## Webhook 验签与地址校验代码",
          "",
          "```" + (lang === "node" ? "javascript" : "python"),
          genWebhookVerifier(lang),
          "```",
          "",
          "要点：`x-bilibili-signature = SHA1(app_secret + 原始 body)`；收到 `verify_webhooks` 要原样回 `{\"data\": <原值>}`；最多重试 3 次，务必幂等。",
        ].join("\n")
      );
    }
    const events = DOCS.filter((d) => d.type === "event").sort((a, b) => a.num - b.num);
    if (action === "detail") {
      const d = resolveRef(ref) || events.find((x) => x.title.toLowerCase() === String(ref || "").toLowerCase());
      if (!d) return text(`未找到事件: ${ref}。用 bili_webhook {action:"list"} 看全部。`);
      return text(`${specText(d)}\n\n---\n\n${readDocBody(d).slice(0, 6000)}`);
    }
    const groups = new Map();
    for (const e of events) {
      const g = e.folder.split(" / ").slice(3).join(" / ") || e.folder;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(e);
    }
    return text(
      [
        `# 推送事件 ${events.length} 个`,
        "",
        WEBHOOK_NOTES,
        "",
        ...[...groups.entries()].flatMap(([g, list]) => [`## ${g}（${list.length}）`, ...list.map((e) => `- #${e.num} ${e.title}`), ""]),
        '用 bili_webhook {action:"detail", ref:"164"} 看字段；bili_webhook {action:"verify-code", lang:"python"} 生成本仓库认可的验签代码。',
      ].join("\n")
    );
  }
);

// 16. ws_protocol
server.registerTool(
  "bili_ws_protocol",
  {
    title: "直播间长连协议",
    description:
      "返回直播间 WebSocket 长连协议（建连流程、16 字节包头、Operation 表、zlib 多包解析），可选生成内联 Python 客户端。对应文档 #43–#46。",
    inputSchema: {
      code: z.enum(["none", "python"]).optional().describe("默认 none"),
    },
  },
  async ({ code = "none" }) => {
    const parts = [WS_PROTOCOL];
    if (code === "python") parts.push("", "```python", genWsClient(), "```");
    return text(parts.join("\n"));
  }
);

// 17. mock
server.registerTool(
  "bili_mock",
  {
    title: "沙盒（Mock）环境",
    description:
      "action=list 列出 43 个 mock 接口（按模块）；action=map 把正式接口换算成 mock 地址（两者路径不总一致）；action=call 真实调用 mock（同样走 2.0 签名，凭据不足时用 dryRun）。",
    inputSchema: {
      action: z.enum(["list", "map", "call"]).optional().describe("默认 list"),
      ref: z.string().optional().describe("map 用：正式接口的 #num / 标题"),
      mockUrl: z.string().optional().describe("call 用：mock 完整地址"),
      query: z.record(z.any()).optional(),
      body: z.any().optional(),
      dryRun: z.boolean().optional(),
    },
  },
  async ({ action = "list", ref, mockUrl, query, body, dryRun = false }) => {
    const entries = MOCK.entries || [];
    if (!entries.length) return text("data/mock.json 为空：先跑 npm run build。");
    if (action === "list") {
      const groups = new Map();
      for (const e of entries) {
        if (!groups.has(e.group)) groups.set(e.group, []);
        groups.get(e.group).push(e);
      }
      return text(
        [
          `# 沙盒 Mock 接口 ${entries.length} 个`,
          "",
          "用同一套 OAuth2 access_token 即可调；**应用仍须已申请对应 scope**，否则返回权限错误。",
          "mock 路径与正式路径不总一致，用 bili_mock {action:\"map\", ref:\"12\"} 换算。",
          "",
          ...[...groups.entries()].flatMap(([g, list]) => [
            `## ${g}（${list.length}）`,
            ...list.map((e) => `- ${e.feature}\n  ${e.url}`),
            "",
          ]),
        ].join("\n")
      );
    }
    if (action === "map") {
      const d = resolveRef(ref);
      if (!d) return text(`未找到正式接口: ${ref}`);
      const key = d.title.replace(/(接口说明书?|说明|接口)$/g, "").trim();
      let hits = entries.filter((e) => e.feature && (key.includes(e.feature) || e.feature.includes(key)));
      if (!hits.length) {
        const pathTail = new URL(d.url).pathname.split("/").filter(Boolean).pop() || "";
        hits = entries.filter((e) => pathTail && e.url.includes(pathTail));
      }
      if (!hits.length) {
        const out = [
          `未找到 #${d.num} ${d.title} 对应的 mock 接口。`,
          `正式: ${d.method} ${d.url}`,
          "",
          "可能该接口没有 mock（沙盒只覆盖 43 个），或名称差异较大。用 bili_mock {action:\"list\"} 人工核对。",
        ];
        return text(out.join("\n"));
      }
      return text(
        [
          `#${d.num} ${d.title}`,
          `正式: ${d.method} ${d.url}`,
          `scope: ${(d.scopes || ["—"]).join(",")}`,
          "",
          ...hits.map((h) => `mock(${h.group} / ${h.feature}): ${h.url}`),
          "",
          "注意 mock 与正式的路径/参数可能不同，调用前用 bili_docs_get {ref:\"169\"} 核对原文表格。",
        ].join("\n")
      );
    }
    // call
    if (!mockUrl) return text("call 需要 mockUrl（或用 action=map 先换算）。");
    if (!/^https:\/\/member\.bilibili\.com\/mock\//.test(mockUrl))
      return text("安全限制：只能调用 https://member.bilibili.com/mock/ 下的地址。");
    const d = DOCS.find((x) => x.url === mockUrl) || null;
    const method = d?.method || "POST";
    try {
      const r = await callApi({ method, url: mockUrl, query, body, dryRun });
      if (dryRun) return text(["## dryRun — 未发送", "```", r.curl, "```", "", "## 待签名串", r.signingString].join("\n"));
      return text(JSON.stringify(r, null, 1));
    } catch (e) {
      return text(`请求失败: ${e.message}`);
    }
  }
);

// ---------------------------------------------------------------- 主站 Cookie / Web 接口
const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// 18. cookie
server.registerTool(
  "bili_cookie",
  {
    title: "主站 Cookie / 登录态",
    description:
      "管理主站 www.bilibili.com 的浏览器 Cookie（与开放平台 client_id/secret 是两套体系）。action=status 列关键 cookie 与过期时间；whoami 验证登录态；import 收下 EditThisCookie 数组 / {name:value} / \"k=v; k=v\"；set / clear / export。默认脱敏，reveal:true 才显示原值。",
    inputSchema: {
      action: z.enum(["status", "whoami", "import", "set", "clear", "export"]).optional().describe("默认 status"),
      jar: z.union([z.string(), z.array(z.any()), z.record(z.any())]).optional().describe("import 的 cookie 内容"),
      name: z.string().optional().describe("set 用"),
      value: z.string().optional().describe("set 用"),
      reveal: z.boolean().optional().describe("显示完整值（默认脱敏）"),
      file: z.string().optional().describe("指定 jar 文件；默认按 参数 → BILI_COOKIE_FILE → 包目录 secrets/cookies.json → 启动方 cwd 的顺序解析"),
    },
  },
  async ({ action = "status", jar, name, value, reveal = false, file }) => {
    const cur = loadJar(file);
    if (action === "import") {
      if (jar == null) return text("import 需要 jar（数组 / 对象 / 字符串）。");
      let parsed;
      try {
        parsed = parseCookies(jar);
      } catch (e) {
        return text("解析失败: " + e.message);
      }
      if (!parsed.entries.length) return text("没有解析出任何 cookie。");
      // 合并：同名覆盖，其余保留
      const merged = new Map(cur.entries.map((e) => [e.name, e]));
      for (const e of parsed.entries) merged.set(e.name, e);
      const saved = saveJar([...merged.values()], file);
      return text(
        [
          `已写入 ${saved.file}`,
          `导入 ${parsed.entries.length} 个，合并后共 ${saved.count} 个。`,
          "",
          jarStatus(loadJar(file), reveal),
        ].join("\n")
      );
    }
    if (action === "set") {
      if (!name) return text("set 需要 name（和 value）。");
      const merged = new Map(cur.entries.map((e) => [e.name, e]));
      if (value == null) merged.delete(name);
      else merged.set(name, { name, value: String(value), domain: ".bilibili.com", path: "/" });
      const saved = saveJar([...merged.values()], file);
      return text(`已更新 ${name} → ${saved.file}（共 ${saved.count} 个）`);
    }
    if (action === "clear") {
      const saved = saveJar([], file);
      return text(`已清空 ${saved.file}`);
    }
    if (action === "export") {
      return text(
        [
          `# ${cur.file}  (${cur.entries.length} 个)`,
          reveal ? "（reveal=true，含完整凭证，注意泄露风险）" : "（默认脱敏，加 reveal:true 看原值）",
          "",
          JSON.stringify(cur.entries.map((e) => ({ ...e, value: mask(e.value, reveal) })), null, 1),
        ].join("\n")
      );
    }
    if (action === "whoami") {
      const cookie = cookieHeader(cur, "https://www.bilibili.com/");
      if (!cookie) return text(`jar 为空（${cur.file}）。先用 bili_cookie {action:"import", jar:[...]} 导入。`);
      try {
        const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
          headers: {
            Cookie: cookie,
            "User-Agent": WEB_UA,
            Referer: "https://www.bilibili.com/",
            Accept: "application/json, text/plain, */*",
          },
        });
        const j = await res.json().catch(() => null);
        if (!j) return text(`HTTP ${res.status}，响应不是 JSON。`);
        if (j.code !== 0) {
          return text(
            [
              `HTTP ${res.status}  code=${j.code}  message=${j.message}`,
              "",
              j.code === -101
                ? "→ 账号未登录：SESSDATA 已失效或没带上。重新导出 cookie 再 import。"
                : "→ 见 message。",
            ].join("\n")
          );
        }
        const d = j.data || {};
        return text(
          [
            `✅ 登录态有效   uid=${d.mid}  uname=${d.uname}`,
            `等级 Lv${d.level_info?.current_level}  硬币 ${d.money}  B币 ${d.wallet?.bcoin_balance ?? "-"}`,
            `大会员 ${d.vipStatus === 1 ? "是" : "否"}（类型 ${d.vipType}）  粉丝数 ${d.follower ?? "-"}`,
            `CSRF(bili_jct) ${cur.map.bili_jct ? "存在，POST 会自动带上" : "缺失，写操作会失败"}`,
            "",
            `jar: ${cur.file}  (${cur.entries.length} 个 cookie)`,
          ].join("\n")
        );
      } catch (e) {
        return text(`请求失败: ${e.message}`);
      }
    }
    return text(
      [
        `# Cookie 罐  ${cur.file}${cur.exists ? "" : "（文件不存在，jar 为空）"}`,
        "",
        jarStatus(cur, reveal),
        "",
        "下一步:",
        '- 验证登录态: bili_cookie {action:"whoami"}',
        '- 导入: bili_cookie {action:"import", jar:[{name:"SESSDATA", value:"…"}, …]}',
        '- 调用主站接口: bili_web_call {path:"x/web-interface/nav"}',
      ].join("\n")
    );
  }
);

// 19. web_call
server.registerTool(
  "bili_web_call",
  {
    title: "主站 Web 接口调用（带 Cookie）",
    description:
      "用 Cookie 罐调主站/主 API 的 Web 接口（不是开放平台的那套签名接口）。自动带 Cookie、UA、Referer；POST 若给 form 则按 x-www-form-urlencoded 并自动补 csrf=bili_jct。路径含 /wbi/、/polymer/ 等会自动做 wbi 签名（w_rid+wts），可显式 wbi:true/false 覆盖。dryRun 只看请求。",
    inputSchema: {
      path: z.string().optional().describe("如 x/web-interface/nav，默认拼到 https://www.bilibili.com"),
      url: z.string().optional().describe("完整 URL，给了就忽略 path"),
      method: z.enum(["GET", "POST"]).optional().describe("默认 GET（有 form 则 POST）"),
      query: z.record(z.any()).optional(),
      form: z.record(z.any()).optional().describe("表单参数，自动带 csrf"),
      body: z.any().optional().describe("JSON body"),
      headers: z.record(z.string()).optional(),
      wbi: z.boolean().optional().describe("强制开关 wbi 签名；留空则按路径自动判断（/wbi/、/polymer/ 等）"),
      dryRun: z.boolean().optional(),
      maxBytes: z.number().int().min(200).max(400000).optional().describe("响应截断，默认 60000"),
    },
  },
  async ({ path: p, url, method, query = {}, form, body, headers = {}, wbi, dryRun = false, maxBytes = 60000 }) => {
    const jar = loadJar();
    let target = url;
    if (!target) {
      if (!p) return text("需要 path 或 url。");
      target = /^https?:\/\//.test(p)
        ? p
        : "https://www.bilibili.com/" + p.replace(/^\//, "");
    }
    let u;
    try {
      u = new URL(target);
    } catch {
      return text("URL 不合法: " + target);
    }
    if (!/(^|\.)bilibili\.com$/.test(u.host) && !/(^|\.)hdslb\.com$/.test(u.host)) {
      return text(`安全限制：只允许 *.bilibili.com / *.hdslb.com，收到 ${u.host}`);
    }
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));

    // wbi 签名（默认按路径自动判断，可用 wbi:false 关掉）
    const useWbi = wbi === undefined ? needsWbi(u.pathname) : wbi;
    let wbiNote = "";
    if (useWbi) {
      try {
        const { imgKey, subKey } = await getWbiKeys(jar);
        const src = Object.fromEntries(u.searchParams.entries());
        const { query: signed, mixinKey } = encWbi(src, imgKey, subKey);
        u.search = "?" + signed;
        const sp = new URLSearchParams(signed);
        wbiNote = `wbi: 已签名  wts=${sp.get("wts")}  w_rid=${sp.get("w_rid")}  mixin_key=${mixinKey.slice(0, 8)}…`;
      } catch (e) {
        return text(`wbi 签名失败: ${e.message}`);
      }
    }

    const cookie = cookieHeader(jar, u.toString());
    const m = (method || (form ? "POST" : "GET")).toUpperCase();
    let payload;
    const h = { ...headers, "User-Agent": WEB_UA, Referer: "https://www.bilibili.com/", Accept: "application/json, text/plain, */*" };
    if (cookie) h.Cookie = cookie;
    if (form) {
      const f = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) f.set(k, String(v));
      if (jar.map.bili_jct && !f.has("csrf")) f.set("csrf", jar.map.bili_jct);
      else if (!f.has("csrf")) return text("POST 表单需要 csrf，但 jar 里没有 bili_jct。先 bili_cookie {action:\"import\"}。");
      payload = f.toString();
      h["Content-Type"] = "application/x-www-form-urlencoded";
      h.Origin = u.origin;
    } else if (body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      h["Content-Type"] = "application/json";
      h.Origin = u.origin;
    }

    const reqLine = [`${m} ${u.toString()}`, "", "请求头:", ...Object.entries(h).map(([k, v]) => `  ${k}: ${k === "Cookie" ? mask(v) : v}`)];
    if (wbiNote) reqLine.push("", wbiNote);
    if (payload) reqLine.push("", "body:", payload.length > 800 ? payload.slice(0, 800) + "…" : payload);
    if (dryRun) return text(["## dryRun — 未发送", "```", ...reqLine, "```", "", `jar: ${jar.file}（${jar.entries.length} 个 cookie）`].join("\n"));

    try {
      const res = await fetch(u, { method: m, headers: h, body: payload, redirect: "follow" });
      const buf = Buffer.from(await res.arrayBuffer());
      const raw = buf.subarray(0, maxBytes).toString("utf8");
      let rendered = raw;
      try {
        rendered = JSON.stringify(JSON.parse(raw), null, 1);
      } catch {
        /* 非 JSON 原样输出 */
      }
      return text(
        [
          `HTTP ${res.status} ${res.statusText}  (${buf.length} 字节${buf.length > maxBytes ? `，截断到 ${maxBytes}` : ""})`,
          "",
          "```",
          rendered.slice(0, maxBytes),
          "```",
        ].join("\n")
      );
    } catch (e) {
      return text(`请求失败: ${e.message}`);
    }
  }
);

// ---------------------------------------------------------------- 资源与提示
function webCatalogText() {
  return [
    `# 主站 Web 隐藏能力（${WEB_ITEMS.length} 个 / ${(WEB.groups || []).length} 组）`,
    "",
    "开放平台（open.bilibili.com）只放已商务合作的能力；其余在主站 www/api.bilibili.com 与 api.live.bilibili.com 上，走浏览器 Cookie，不走 2.0 签名。",
    WEB.authNote || "",
    "",
    ...(WEB.groups || []).flatMap((g) => [
      `## ${g.name}（${g.items.length}）`,
      g.desc || "",
      "",
      ...g.items.map((it) => {
        const bits = [`- \`${it.method} ${shortPath(it.url)}\` **${it.name}** — ${WEB_STATUS(it.status).label}`];
        if (it.params && it.params.length)
          bits.push(`  参数: ${it.params.map((p) => p.name + (p.required ? "*" : "")).join(", ")}`);
        if (it.notes && it.notes.length) bits.push(`  注意: ${it.notes[0]}`);
        bits.push(`  实测: ${it.probe || "—"}`);
        return bits.join("\n");
      }),
      "",
    ]),
  ].join("\n");
}

try {
  server.registerResource(
    "catalog",
    "bili://catalog",
    {
      title: "开放平台接口总目录（llms.txt）",
      description: "170 篇文档压成的一页纸清单：端点、参数名、子结构、签名版本。",
      mimeType: "text/plain; charset=utf-8",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain; charset=utf-8", text: fs.readFileSync(path.join(DATA_DIR, "llms.txt"), "utf8") }],
    })
  );

  server.registerResource(
    "web",
    "bili://web",
    {
      title: "主站 Web 隐藏能力目录",
      description: `${WEB_ITEMS.length} 个开放平台文档里没有的接口（举报 / 拉黑 / 动态 / 评论 / 收藏 / 历史 / 消息 / 直播 / 创作中心），含参数、返回码与无 Cookie 实测状态。`,
      mimeType: "text/markdown; charset=utf-8",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown; charset=utf-8", text: webCatalogText() }],
    })
  );

  server.registerResource(
    "doc",
    new ResourceTemplate("bili://doc/{ref}", { list: undefined }),
    { title: "开放平台文档", description: "按 ref 读取单篇文档原文（#12 / uuid / 文件名均可）", mimeType: "text/markdown; charset=utf-8" },
    async (uri, { ref }) => {
      const d = resolveRef(decodeURIComponent(String(ref)));
      if (!d) return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `未找到文档: ${ref}` }] };
      return { contents: [{ uri: uri.href, mimeType: "text/markdown; charset=utf-8", text: readDocBody(d) }] };
    }
  );
} catch (e) {
  console.error("[warn] 注册资源失败:", e.message);
}

try {
  server.registerPrompt(
    "integrate-bili-api",
    {
      title: "接入一个开放平台接口",
      description: "按开放平台规范生成接入该接口的完整任务说明",
      argsSchema: { ref: z.string().describe("#num / 标题 / 接口URL") },
    },
    ({ ref }) => {
      const d = resolveRef(ref);
      const spec = d ? specText(d).slice(0, 3000) : `未找到 ${ref}`;
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `请把哔哩哔哩开放平台接口「${d ? d.title : ref}」接入现有项目。`,
                "",
                "要求：",
                "1. 签名按 2.0（HMAC-SHA256，6 个 x-bili-* 头字典序拼 \\n，末尾无换行）",
                "2. access-token 从配置读，不要硬编码；secret 只在本地参与 HMAC，不发出去",
                "3. 判断 `code != 0` 视为失败，带 message 与 request_id",
                "4. 参数按文档类型转换，必填项缺失时立即报错",
                "5. 不要编造文档里没有的字段或接口",
                "",
                "## 接口规格",
                "```",
                spec,
                "```",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );
} catch (e) {
  console.error("[warn] 注册提示失败:", e.message);
}

// ---------------------------------------------------------------- boot
const transport = new StdioServerTransport();
await server.connect(transport);