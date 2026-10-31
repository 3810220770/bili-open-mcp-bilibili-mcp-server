#!/usr/bin/env node
/**
 * build-spec.mjs — 把 bilibili-open-docs 下的 Markdown 文档解析成
 * AI 友好的结构化清单 data/index.json。
 *
 * 用法: node scripts/build-spec.mjs [docsRoot]
 * 默认 docsRoot = 仓库上一级目录 (..)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] ?? path.join(HERE, "..", ".."));
const OUT = path.join(HERE, "..", "data");
const INDEX_MD = path.join(ROOT, "_INDEX.md");

// ---------- 1. 解析 _INDEX.md 得到层级 / id / 文件名 ----------
const idxRaw = fs.readFileSync(INDEX_MD, "utf8");
const docs = [];
const folderStack = []; // {level, name}

for (const line of idxRaw.split(/\r?\n/)) {
  const fm = /^(\s*)- \*\*(.+?)\*\*\s*$/.exec(line);
  if (fm) {
    const level = Math.floor(fm[1].length / 2);
    folderStack.length = level;
    folderStack[level] = fm[2].trim();
    continue;
  }
  const am = /^(\s*)- (.+?)\s+->\s+`([^`]+)`\s+\(id:\s*([^)]+)\)\s*$/.exec(line);
  if (am) {
    const level = Math.floor(am[1].length / 2);
    const folders = folderStack.slice(0, level).filter(Boolean);
    docs.push({
      num: Number((/^(\d+)_/.exec(am[3]) || [])[1] ?? 0),
      title: am[2].trim(),
      file: am[3].trim(),
      id: am[4].trim(),
      path: [...folders, am[2].trim()],
    });
  }
}

// ---------- 2. Markdown 辅助 ----------
function sections(md) {
  const out = [];
  let cur = { title: "", level: 0, body: [] };
  let fence = null;
  for (const ln of md.split(/\r?\n/)) {
    const fm = /^\s*(```+|~~~+)/.exec(ln);
    if (fm) {
      if (fence === null) fence = fm[1][0];
      else if (fm[1][0] === fence) fence = null;
      cur.body.push(ln);
      continue;
    }
    if (fence !== null) {
      cur.body.push(ln);
      continue;
    }
    // 兼容 `##请求URL` 这种标题后无空格的写法
    const m = /^(#{1,6})[ \t]*(.+?)\s*$/.exec(ln);
    if (m && m[2] && !/^#+$/.test(m[2])) {
      out.push(cur);
      cur = { title: m[2].trim(), level: m[1].length, body: [] };
    } else {
      cur.body.push(ln);
    }
  }
  out.push(cur);
  return out;
}

const norm = (s) => s.replace(/^[\s\-*•]+/, "").trim();
/** 从文本取第一个 http(s) URL，先展开 markdown 链接 [x](url) */
function firstUrl(s) {
  const norm = String(s).replace(/\[[^\]]*\]\(([^)\s]+)\)/g, (_m, u) => " " + u + " ");
  const m = /(https?:\/\/[^\s`'"<>)\]]+)/.exec(norm);
  return m ? m[1] : "";
}
const stripM = (l) => l.replace(/[`*]/g, "").replace(/^[\s\-*•]+/, "").trim();

function findSection(secs, re, { after = 0 } = {}) {
  for (let i = after; i < secs.length; i++) if (re.test(secs[i].title)) return secs[i];
  return null;
}

function tablesIn(lines) {
  const raw = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l));
  const isSep = (l) => /^\s*\|[\s:|\-]+\|\s*$/.test(l);
  const splitRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  const parsed = [];
  let cur = null;
  let sawSep = false;
  for (let i = 0; i < raw.length; i++) {
    if (isSep(raw[i]) && i > 0) {
      // 分隔行上一行就是表头：这也是一张新表的开始（相邻两张表之间没有空行的情况）
      // 注意把这行从上一张表的行里去掉，否则会稀释类型/必传列的判定比例
      if (cur && cur.rows.length && cur.rows[cur.rows.length - 1] === raw[i - 1]) cur.rows.pop();
      cur = { header: raw[i - 1], rows: [] };
      parsed.push(cur);
      sawSep = true;
      continue;
    }
    if (!cur) continue;
    if (isSep(raw[i])) continue;
    cur.rows.push(raw[i]);
  }
  if (!sawSep) {
    // 没有分隔行 → 退回「首行即表头」
    if (!raw.length) return [];
    const rows = raw.map(splitRow);
    return rows.length > 1 && rows[0].length > 1 ? [rows] : [];
  }
  return parsed
    .map((t) => [t.header, ...t.rows].map(splitRow))
    .filter((r) => r.length > 1 && r[0].length > 1);
}

function toParams(rows) {
  if (!rows || rows.length < 2) return [];
  const head = rows[0];
  const body = rows.slice(1);
  const n = head.length;

  const TYPE_RE = /^(any|string|str|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float|double|long|short|byte|bytes|binary|number|bool|boolean|object|array|list|map|set|dict|tuple|file|json|uuid|null|struct|decimal|datetime|timestamp|char|varchar|text|bigint|enum)$/i;
  const REQ_RE = /^(true|false|是|否|y|n|yes|no|必填|必传|可选|-|—|\/)$/i;
  /** 类型列判定：纯 ASCII 的类型写法（struct / []int32 / int32[] / array<struct> / map<string,int>） */
  const isTypeish = (s) => {
    const v = String(s).trim();
    if (!v || v.length > 30) return false;
    if (/[\u4e00-\u9fa5，。；：！？、]/.test(v)) return false;
    if (!/[A-Za-z]/.test(v)) return false;
    return TYPE_RE.test(v) || /^(\[\])?[A-Za-z_][A-Za-z0-9_\[\]<>,.\s|]*$/.test(v);
  };
  const clean = (s) =>
    String(s ?? "")
      .replace(/[\\`*]/g, "")
      .replace(/[\u2500-\u257F]/g, " ")
      .replace(/^[\s│|]+/, "")
      .replace(/\s+/g, " ")
      .trim();

  const iName = (() => {
    const i = head.findIndex((h) => /参数名|字段名|字段|名称|参数/.test(h));
    return i >= 0 ? i : 0;
  })();
  const iReqH = head.findIndex((h) => /必传|必填|是否必填|是否必须/.test(h));
  const iTypeH = head.findIndex((h) => /类型/.test(h));
  const iDescH = head.findIndex((h) => /备注|描述|说明|含义/.test(h));

  // 逐列按内容打分，避免表头命名不统一（如「说明」列其实是类型）
  const cols = [];
  for (let c = 0; c < n; c++) {
    if (c === iName) continue;
    let t = 0, r = 0, p = 0, ne = 0;
    for (const row of body) {
      const v = String(row[c] ?? "").trim();
      if (!v) continue;
      ne++;
      const vv = v.replace(/[\\`*]/g, "");
      if (REQ_RE.test(vv)) r++;
      else if (isTypeish(vv)) t++;
      else p++;
    }
    cols.push({ c, ne, t: ne ? t / ne : 0, r: ne ? r / ne : 0, p: ne ? p / ne : 0 });
  }
  const pickReq = () => {
    if (iReqH >= 0 && cols.find((x) => x.c === iReqH)?.r >= 0.6) return iReqH;
    const best = cols.filter((x) => x.r >= 0.7).sort((a, b) => b.r - a.r)[0];
    return best ? best.c : -1;
  };
  const iReq = pickReq();
  const pickType = () => {
    const colH = iTypeH >= 0 ? cols.find((x) => x.c === iTypeH) : null;
    if (colH && colH.t >= 0.6) return iTypeH;
    // 表头写「说明」但内容是类型的情况
    const byHeader = cols.find((x) => x.c === iDescH && x.t >= 0.6 && x.p < 0.4);
    if (byHeader) return byHeader.c;
    const best = cols.filter((x) => x.c !== iReq && x.t >= 0.6).sort((a, b) => b.t - a.t)[0];
    return best ? best.c : -1;
  };
  const iType = pickType();
  const iDesc = (() => {
    const rest = cols.filter((x) => x.c !== iReq && x.c !== iType);
    if (!rest.length) return -1;
    const pref = rest.find((x) => x.c === iDescH);
    if (pref) return pref.c;
    return rest.sort((a, b) => b.p - a.p)[0].c;
  })();

  const out = [];
  for (const row of body) {
    const rawName = String(row[iName] ?? "");
    const name = clean(rawName);
    if (!name || name === "无" || name === "-") continue;
    if (/^(参数名|名称|字段|字段名)$/.test(name)) continue;
    const item = { name };
    const depth = (rawName.match(/│/g) || []).length + (/[├└]/.test(rawName) ? 1 : 0);
    if (depth > 0) item.depth = depth;
    if (iType >= 0 && row[iType] !== undefined) {
      const t = clean(row[iType]);
      if (t) item.type = t;
    }
    if (iReq >= 0 && row[iReq] !== undefined) {
      const v = clean(row[iReq]);
      if (/^(true|是|y|yes|必填|必传)$/i.test(v)) item.required = true;
      else if (/^(false|否|n|no|可选)$/i.test(v)) item.required = false;
    }
    if (iDesc >= 0 && row[iDesc] !== undefined) {
      const d = clean(row[iDesc]);
      if (d) item.desc = d;
    }
    out.push(item);
  }
  return out;
}

function fenced(lines) {
  const out = [];
  let buf = null;
  let lang = "";
  for (const ln of lines) {
    const m = /^\s*```(\w*)\s*$/.exec(ln);
    if (m && buf === null) {
      buf = [];
      lang = m[1] || "";
      continue;
    }
    if (m && buf !== null) {
      out.push({ lang, text: buf.join("\n").trim() });
      buf = null;
      continue;
    }
    if (buf !== null) buf.push(ln);
  }
  return out;
}

/** 按列表项标记切块：已知的归到固定 key，其余保留标签名（可能是一段子结构说明） */
const KNOWN_MARKERS = {
  url参数: "url",
  path参数: "url",
  query参数: "url",
  body参数: "body",
  body参: "body",
  form参数: "body",
  请求参数: "req",
  参数: "req",
  请求样例: "reqExample",
  请求示例: "reqExample",
  请求例子: "reqExample",
  请求信息: "reqExample",
  响应样例: "respExample",
  响应示例: "respExample",
  响应例子: "respExample",
  响应信息: "respExample",
  返回样例: "respExample",
  返回示例: "respExample",
  返回信息: "respExample",
  响应参数: "resp",
  返回参数: "resp",
};

/** 把一行列表标签判成已知小节；判不出来返回 null（说明是正文，留在当前块） */
function markerKey(raw) {
  const norm = raw.replace(/[\s:：]/g, "");
  if (KNOWN_MARKERS[norm]) return KNOWN_MARKERS[norm];
  if (/^url/i.test(norm) || /^路径参数/.test(norm) || /^query/i.test(norm) || /^param参数/i.test(norm)) return "url";
  if (/^body/i.test(norm) || /^form/i.test(norm)) return "body";
  if (/^(请求|入参|出参)?参数$/.test(norm)) return "req";
  if (/(请求|入参)(样例|示例|例子|信息)/.test(norm)) return "reqExample";
  if (/(响应|返回|出参|应答)/.test(norm)) return /参数/.test(norm) ? "resp" : "respExample";
  return null;
}

/** 只按已知小节切块；其余行（含散文与子结构小标题）留在当前块 */
function splitMarkers(lines) {
  const buckets = new Map();
  let key = "_intro";
  buckets.set(key, []);
  for (const ln of lines) {
    const m = /^\s*[-*●•·]\s*([^|]{2,40}?)\s*$/.exec(ln);
    if (m) {
      const k = markerKey(m[1]);
      if (k) {
        key = k;
        if (!buckets.has(key)) buckets.set(key, []);
        continue;
      }
    }
    buckets.get(key).push(ln);
  }
  return buckets;
}

/** 一段文本里的小标题（会引出子结构）：只看「参考字段/结构/示例」这类词 */
const SUBTITLE_RE = /(参考字段|字段说明|字段定义|字段表|结构体|结构|示例|例子|枚举|可选值|参数说明|明细)/;

/** 把一个块拆成 [{title, rows}]，title 为最近的小标题，没有则为 "" */
function extractTables(lines) {
  const out = [];
  let buf = [];
  let title = "";
  const flush = () => {
    if (!buf.length) return;
    for (const rows of tablesIn(buf)) out.push({ title, rows });
    buf = [];
  };
  for (const ln of lines) {
    const m = /^\s*[-*●•·]\s*(.+?)\s*$/.exec(ln);
    // 已经出过表之后，任何短列表项都视为下一张表的标题；否则要求像小标题的词
    const haveTable = buf.length > 0 && tablesIn(buf).length > 0;
    if (m && m[1].length <= 60 && (haveTable || SUBTITLE_RE.test(m[1]))) {
      flush();
      title = m[1].trim();
      continue;
    }
    buf.push(ln);
  }
  flush();
  return out;
}

/** 表头长得像「参数表」而不是「状态码表」 */
function looksLikeParamTable(rows) {
  if (!rows || rows.length < 2) return false;
  const h = rows[0].join("|");
  return /参数名|字段名|字段|名称|参数/.test(h) && /类型|说明|备注|必传|必填|描述|描述/.test(h);
}

// ---------- 3. 逐篇解析 ----------
function classify(doc, url, method, fullText, endpointCount = 0) {
  if (endpointCount > 1) return "multi-api";
  if (url && method) return "api";
  if (/消息推送/.test(doc.path.join("/")) && /(event|消息)/.test(doc.title)) return "event";
  if (/websocket|协议|长连/i.test(doc.title + fullText.slice(0, 400))) return "protocol";
  return "guide";
}

function clean(s) {  return String(s || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!--|-->/g, " ")
    .replace(/<font[^>]*>/gi, "")
    .replace(/<\/font>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(secs) {
  const s = findSection(secs, /^接口说明|^简介|^概述|^服务说明|^业务说明|^用前须知|^接入指引/);
  if (!s) return "";
  const bullets = s.body.map(norm).filter((x) => x && !x.startsWith("|"));
  const text = clean(bullets.join(" "));
  if (text) return text.slice(0, 220);
  const para = s.body.map((l) => l.trim()).filter((l) => l && !l.startsWith("!") && !l.startsWith("|"));
  return clean(para.join(" ")).slice(0, 220);
}

const result = [];

for (const doc of docs) {
  const abs = path.join(ROOT, doc.file);
  let md = "";
  try {
    md = fs.readFileSync(abs, "utf8");
  } catch {
    result.push({ ...doc, type: "missing" });
    continue;
  }
  const secs = sections(md);
  const h1 = secs.find((s) => s.level === 1)?.title || doc.title;

  const scopes = [...md.matchAll(/\*{0,2}\s*Scope\s*\*{0,2}\s*[:：]?\s*\\?`\s*([^`\\]+?)\s*\\?`/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);

  // 少数接口标注签名版本为 1.0（目前仅 #16）
  const svm = /签名\s*(?:为|版本为|版本)?\s*[:：]?\s*\\?`?\s*(1\.0|2\.0)\b/.exec(md);
  const signVersion = svm ? svm[1] : "2.0";

  const urlSec = findSection(secs, /请求\s*URL|请求地址|接口地址|请求方式.*URL/i);
  let url = "";
  if (urlSec) {
    const u1 = firstUrl(urlSec.body.join("\n"));
    if (u1) url = u1;
  }

  const methSec = findSection(secs, /^请求\s*方式|^请求方法|^HTTP\s*请求方式/i);
  // 方式 1: 独立「请求方式」小节；方式 2: 正文里内联 `请求方式：POST`
  let method = methSec
    ? (/^(GET|POST|PUT|DELETE|PATCH)\b/i.exec(methSec.body.map(stripM).filter(Boolean).join(" ")) || [])[1]?.toUpperCase() || ""
    : "";
  if (!method) {
    const gm = /请求方式\s*[:：]?\s*`?\s*(GET|POST|PUT|DELETE|PATCH)/i.exec(md);
    if (gm) method = gm[1].toUpperCase();
  }

  // 多接口文档（如 账号授权）把所有 请求URL + 请求方式 抓出来
  const endpoints = [];
  for (let i = 0; i < secs.length; i++) {
    if (!/请求\s*URL|请求地址|接口地址|请求方式.*URL/i.test(secs[i].title)) continue;
    const uu = firstUrl(secs[i].body.join("\n"));
    if (!uu) continue;
    let m2 = "";
    for (let k = i + 1; k < Math.min(i + 4, secs.length); k++) {
      if (!/请求方式|请求方法/i.test(secs[k].title)) continue;
      m2 = (/^(GET|POST|PUT|DELETE|PATCH)\b/i.exec(secs[k].body.map(stripM).filter(Boolean).join(" ")) || [])[1]?.toUpperCase() || "";
      break;
    }
    endpoints.push({ url: uu, method: m2 || method });
  }

  const paramSec = findSection(secs, /^请求参数/);
  let urlParams = [];
  let bodyParams = [];
  let requestExample = "";
  let responseParams = [];
  let responseExample = "";
  const subSchemas = [];

  if (paramSec) {
    const buckets = splitMarkers(paramSec.body);
    if (process.env.BILI_DEBUG_DOC === String(doc.num)) {
      console.error("--- DEBUG #" + doc.num + " method=" + method + " ---");
      for (const [k, v] of buckets) console.error(`  bucket ${k}: ${v.filter((l) => /\|/.test(l)).length} table-ish lines`);
      const probe = extractTables(buckets.get("body") || buckets.get("req") || buckets.get("_intro") || []);
      console.error("  tables:", JSON.stringify(probe.map((t) => ({ t: t.title, rows: t.rows.length, head: t.rows[0] })), null, 1));
      for (const t of probe) console.error("  parsed:", JSON.stringify(toParams(t.rows).slice(0, 3)));
    }
    const asParams = (rows, sink) => {
      const p = toParams(rows);
      if (p.length && looksLikeParamTable(rows)) sink.push(...p);
      return p;
    };
    // url 参数
    for (const { title, rows } of extractTables(buckets.get("url") || [])) {
      if (title) subSchemas.push({ title, params: toParams(rows) });
      else asParams(rows, urlParams);
    }
    // body 参数
    for (const { title, rows } of extractTables(buckets.get("body") || [])) {
      if (title) subSchemas.push({ title, params: toParams(rows) });
      else asParams(rows, bodyParams);
    }
    // 通用「请求参数」/ 正文直接给表：POST/PUT 归 body，GET/DELETE 归 url
    const sink = /^(GET|DELETE)$/.test(method) ? urlParams : bodyParams;
    for (const k of ["req", "_intro"]) {
      for (const { title, rows } of extractTables(buckets.get(k) || [])) {
        if (title) subSchemas.push({ title, params: toParams(rows) });
        else asParams(rows, sink);
      }
    }
    requestExample = fenced(buckets.get("reqExample") || []).map((f) => f.text).join("\n");
  }

  // 响应参数可能在 ## 响应参数 或 请求参数 块的 "- 响应参数" 里
  const respSec = findSection(secs, /^响应参数/);
  if (respSec) {
    const buckets = splitMarkers(respSec.body);
    if (process.env.BILI_DEBUG_DOC === String(doc.num)) {
      console.error("--- DEBUG RESP #" + doc.num + " ---");
      for (const [k, v] of buckets) {
        const ex = extractTables(v);
        if (!ex.length) continue;
        console.error(`  bucket ${k}: tables=${ex.length}`);
        for (const t of ex) {
          const p0 = toParams(t.rows)[0];
          console.error("    head=" + JSON.stringify(t.rows[0]) + " rows=" + t.rows.length + " firstParsed=" + JSON.stringify(p0));
          if (p0 && !p0.type && t.rows.length < 6) console.error("      ALL=" + JSON.stringify(t.rows));
        }
      }
    }
    for (const k of ["_intro", "resp", "body", "req"]) {
      for (const { title, rows } of extractTables(buckets.get(k) || [])) {
        if (!looksLikeParamTable(rows)) continue;
        const p = toParams(rows);
        if (!p.length) continue;
        if (title) subSchemas.push({ title, params: p });
        else responseParams.push(...p);
      }
    }
  }
  if (paramSec) {
    const buckets = splitMarkers(paramSec.body);
    for (const { title, rows } of extractTables(buckets.get("resp") || [])) {
      if (!looksLikeParamTable(rows)) continue;
      const p = toParams(rows);
      if (!p.length) continue;
      if (title) subSchemas.push({ title, params: p });
      else responseParams.push(...p);
    }
  }

  // 变体格式：用 `### URL参数` / `### Body参数` / `### 请求样例` / `### 响应样例` 作小标题
  {
    let mode = "";
    for (const s of secs) {
      const tt = s.title.trim();
      if (/^请求参数/.test(tt)) { mode = "req"; continue; }
      if (/^响应参数/.test(tt)) { mode = "resp"; continue; }
      if (/^URL\s*参数$/i.test(tt)) { for (const t of tablesIn(s.body)) urlParams.push(...toParams(t)); continue; }
      if (/^Body\s*参数$/i.test(tt)) {
        const target = mode === "resp" ? responseParams : bodyParams;
        for (const t of tablesIn(s.body)) target.push(...toParams(t));
        continue;
      }
      if (/^请求样例$/.test(tt) && !requestExample) requestExample = fenced(s.body).map((f) => f.text).join("\n");
      if (/^(响应样例|响应信息|返回样例)$/.test(tt) && !responseExample) responseExample = fenced(s.body).map((f) => f.text).join("\n");
    }
  }

  for (const s of secs) {
    if (/^响应样例|^返回样例|^响应信息/.test(s.title) && !responseExample) {
      responseExample = fenced(s.body).map((f) => f.text).join("\n");
    }
  }
  if (!responseExample && paramSec) {
    const buckets = splitMarkers(paramSec.body);
    responseExample = fenced(buckets.get("respExample") || []).map((f) => f.text).join("\n");
  }
  if (!requestExample) {
    const ced = fenced(md.split(/\r?\n/)).find((f) => /curl\s/.test(f.text));
    if (ced) requestExample = ced.text;
  }
  // 去重（同名同类型同说明才算真重复；跨层级同名保留）
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((p) => {
      const k = `${p.depth || 0}|${p.name}|${p.type || ""}|${p.desc || ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  urlParams = dedupe(urlParams);
  bodyParams = dedupe(bodyParams);
  responseParams = dedupe(responseParams);

  const firstPara = secs
    .filter((s) => s.level === 1)
    .flatMap((s) => s.body)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("!") && !l.startsWith("|") && !l.startsWith("#"));

  const pathSegs = doc.path;
  const hints = [];
  if (/^(GET|DELETE)$/.test(method) && bodyParams.length) {
    hints.push("文档把参数列在 body 参数下，但方法是 " + method + "：实际按 query 传（见请求样例）");
  }
  if (signVersion !== "2.0") {
    hints.push(`文档标注该接口签名版本为 ${signVersion}，与主流 2.0 不同，接入前需确认算法细节`);
  }
  const entry = {
    num: doc.num,
    id: doc.id,
    title: doc.title,
    ...(h1 && h1 !== doc.title ? { h1 } : {}),
    file: doc.file,
    folder: pathSegs.slice(0, -1).join(" / "),
    path: pathSegs.join(" / "),
    type: classify(doc, url, method, md, endpoints.length),
    ...(scopes.length ? { scopes } : {}),
    ...(signVersion !== "2.0" ? { signVersion } : {}),
    ...(url ? { url } : {}),
    ...(method ? { method } : {}),
    ...(endpoints.length > 1 ? { endpoints } : {}),
    ...(subSchemas.length ? { subSchemas } : {}),
    ...(hints.length ? { hints } : {}),
    summary: summarize(secs) || clean(firstPara).slice(0, 220),
    ...(urlParams.length ? { urlParams } : {}),
    ...(bodyParams.length ? { bodyParams } : {}),
    ...(responseParams.length ? { responseParams } : {}),
    ...(requestExample ? { requestExample: requestExample.slice(0, 4000) } : {}),
    ...(responseExample ? { responseExample: responseExample.slice(0, 4000) } : {}),
    bytes: Buffer.byteLength(md),
    lines: md.split(/\r?\n/).length,
  };
  result.push(entry);
}

// ---------- 4. 输出 ----------
fs.mkdirSync(OUT, { recursive: true });

const byFolder = {};
for (const d of result) (byFolder[d.folder] ||= []).push(d.num);

const payload = {
  generatedAt: new Date().toISOString(),
  source: "https://open.bilibili.com/doc/4",
  docRoot: ROOT,
  totals: {
    docs: result.length,
    api: result.filter((d) => d.type === "api").length,
    withBodyParams: result.filter((d) => d.bodyParams?.length).length,
    withResponseParams: result.filter((d) => d.responseParams?.length).length,
  },
  docs: result,
};
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(payload, null, 1), "utf8");

// 状态码表：从 002 抽出来
const st = result.find((d) => d.num === 2 || /接口签名/.test(d.title));
const statusMap = {};
if (st) {
  const raw = fs.readFileSync(path.join(ROOT, st.file), "utf8");
  for (const m of raw.matchAll(/^\|\s*(\d{4,6})\s*\|\s*([^|]+?)\s*\|/gm)) {
    statusMap[m[1]] = m[2].replace(/\s+/g, " ").trim();
  }
}
fs.writeFileSync(path.join(OUT, "status-codes.json"), JSON.stringify(statusMap, null, 1), "utf8");

// llms.txt — 供 AI 一次性消化的紧凑接口清单
const ll = [];
ll.push("# bilibili Open Platform · Open Capabilities");
ll.push("# source: https://open.bilibili.com/doc/4  |  generated: " + new Date().toISOString());
ll.push("# format: [#num] type title | METHOD url | scope | folder | params");
ll.push("");
for (const d of result) {
  const head = `[#${d.num}] ${d.type} ${d.title} | ${d.method ? d.method + " " + d.url : d.url || "-"} | scope=${(d.scopes || ["-"]).join(",")} | ${d.folder}`;
  ll.push(head);
  if (d.summary) ll.push("  desc: " + d.summary);
  const ps = [];
  if (d.urlParams?.length) ps.push("url: " + d.urlParams.map((p) => p.name + ":" + (p.type || "any") + (p.required ? "*" : "")).join(", "));
  if (d.bodyParams?.length) ps.push("body: " + d.bodyParams.map((p) => p.name + ":" + (p.type || "any") + (p.required ? "*" : "")).join(", "));
  if (d.responseParams?.length) ps.push("resp: " + d.responseParams.map((p) => p.name + ":" + (p.type || "any")).join(", "));
  if (d.subSchemas?.length) for (const s of d.subSchemas) ps.push(`sub(${s.title}): ` + s.params.map((p) => p.name + ":" + (p.type || "any") + (p.required ? "*" : "")).join(", "));
  if (d.signVersion) ps.push("signVersion=" + d.signVersion);
  if (d.endpoints?.length > 1) ps.push("endpoints: " + d.endpoints.map((e) => (e.method || "?") + " " + e.url).join(" | "));
  if (ps.length) ll.push("  " + ps.join("  ;  "));
}
fs.writeFileSync(path.join(OUT, "llms.txt"), ll.join("\n"), "utf8");

// 沙盒 mock 映射：从 #169 的「功能 | mock接口」表里抽
const mockEntries = [];
const sandbox = result.find((d) => d.num === 169);
if (sandbox) {
  const raw = fs.readFileSync(path.join(ROOT, sandbox.file), "utf8");
  const secs = sections(raw);
  for (const s of secs) {
    if (s.level !== 3) continue;
    const group = s.title.trim();
    for (const rows of tablesIn(s.body)) {
      const head = rows[0].join("|");
      if (!/功能|接口/.test(head)) continue;
      for (const r of rows.slice(1)) {
        const feature = (r[0] || "").replace(/[`*]/g, "").trim();
        const url = firstUrl(r[1] || "") || (r[1] || "").trim();
        if (!feature || !/^https?:\/\//.test(url)) continue;
        mockEntries.push({ group, feature, url });
      }
    }
  }
}
fs.writeFileSync(
  path.join(OUT, "mock.json"),
  JSON.stringify({ source: "#169 沙盒环境", host: "https://member.bilibili.com/mock", entries: mockEntries }, null, 1),
  "utf8"
);

console.log(
  JSON.stringify(
    {
      docs: payload.totals,
      statusCodes: Object.keys(statusMap).length,
      apiEndpoints: result.filter((d) => d.type === "api").map((d) => `${d.method} ${d.url.replace(/^https?:\/\/[^/]+/, "")}`).length,
      out: OUT,
    },
    null,
    2
  )
);