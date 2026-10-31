#!/usr/bin/env node
/**
 * build-site.mjs — 生成 docs/ 静态站点（GitHub Pages 用）
 *
 * 零第三方依赖。数据全部来自本仓库已有文件：
 *   data/index.json        170 篇文档规格（100 端点 / 41 事件 / 30 指南 / 2 协议）
 *   data/status-codes.json 118 个错误码
 *   data/mock.json         43 个沙盒接口
 *   README.md / USAGE.md / AGENTS.md / DISCLAIMER.md   渲染成正文页
 *   正在运行的 src/server.mjs                           实取 19 个工具的真实入参（tools/list）
 *
 * 输出：docs/  →  GitHub Pages 直接发布（source: main /docs）
 *
 * 用法：node scripts/build-site.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const OUT = path.join(PKG, "docs");
const SITE_SRC = path.join(PKG, "site");
const DATA = path.join(PKG, "data");

const REPO = "https://github.com/3810220770/bili-open-mcp-bilibili-mcp-server";
const SITE_URL = "https://3810220770.github.io/bili-open-mcp-bilibili-mcp-server";

const read = (p) => fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
const readJson = (p) => JSON.parse(read(p));
const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/* 仓库里的 Markdown 之间用 README.md / USAGE.md 这种相对路径互链。
   站上是渲染后的 HTML 页，路径对不上，这里统一改写；仓库内其它文件指回 GitHub。 */
const PAGE_OF = {
  "README.md": "readme.html",
  "USAGE.md": "usage.html",
  "AGENTS.md": "agents.html",
  "DISCLAIMER.md": "disclaimer.html",
};
const REPO_DIR = /^(?:\.\/)?(?:examples|scripts|src|data|site|secrets|docs)\//;
function fixRepoLinks(html, root) {
  return String(html).replace(/(href|src)="([^"]+)"/g, (whole, name, url) => {
    if (/^(?:[a-z]+:|\/\/|#|\/)/i.test(url)) return whole;
    const [p, hash] = url.split("#");
    let out = null;
    if (PAGE_OF[p]) out = root + PAGE_OF[p];
    else if (REPO_DIR.test(p) || /^(?:LICENSE|package\.json|package-lock\.json)$/.test(p))
      out = REPO + "/blob/main/" + p.replace(/^\.\//, "");
    if (!out) return whole;
    return name + '="' + attr(out + (hash ? "#" + hash : "")) + '"';
  });
}

/* ==========================================================================
   1. 语法高亮（在已转义文本上做，只包裹、不删改字符）
   ========================================================================== */
const KEYWORDS = {
  python: "def class return import from as if elif else for while with try except finally raise lambda yield global nonlocal pass break continue and or not in is None True False async await self print",
  javascript: "const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof this null undefined true false of in delete void yield static get set",
  bash: "if then else elif fi for while do done case esac function return export local readonly source cd echo set unset exit trap in",
  json: "true false null",
  toml: "true false",
  java: "public private protected class interface extends implements return if else for while do switch case break continue new import package static final void int long double float boolean char String true false null this super try catch finally throw throws abstract synchronized volatile transient enum record",
  go: "package import func return if else for range switch case break continue var const type struct interface map chan go defer select true false nil",
  php: "function class public private protected return if else elseif foreach for while do switch case break continue new echo require include namespace use try catch finally throw true false null this static const",
  yaml: "true false null",
};

function highlight(code, lang) {
  const l = String(lang || "").toLowerCase();
  const key = KEYWORDS[l];
  if (!key) return esc(code);

  const K = key.trim().split(/\s+/).filter(Boolean).join("|");
  // 顺序有意义：字符串优先，其次注释、关键字、数字
  const re = new RegExp(
    [
      '("(?:\\\\.|[^"\\\\])*")', // 双引号串
      "('(?:\\\\.|[^'\\\\])*')", // 单引号串
      "(`(?:\\\\.|[^`\\\\])*`)", // 模板串
      "(#[^\\n]*)", // python / bash / toml 注释
      "(//[^\\n]*)", // js / go / php 注释
      "(/\\*[\\s\\S]*?\\*/)", // 块注释
      "([A-Za-z_$][\\w$]*)(?=\\s*\\()", // 函数名
      "\\b(" + K + ")\\b", // 关键字
      "(-?\\b\\d+(?:\\.\\d+)?\\b)", // 数字
    ].join("|"),
    "g"
  );

  return esc(code).replace(re, (m, str1, str2, str3, com1, com2, com3, fn, kw, num) => {
    if (str1 || str2 || str3) return '<span class="tok-str">' + m + "</span>";
    if (com1 || com2 || com3) return '<span class="tok-com">' + m + "</span>";
    if (fn) return '<span class="tok-fn">' + m + "</span>";
    if (kw) return '<span class="tok-key">' + m + "</span>";
    if (num) return '<span class="tok-num">' + m + "</span>";
    return m;
  });
}

/* ==========================================================================
   2. 极简 Markdown 渲染器
   覆盖本仓库文档实际用到的语法：ATX 标题、围栏代码（含 4 反引号）、表格、
   引用块 / GitHub Alert、有序无序列表（含嵌套与续行）、hr、行内代码 / 粗体 /
   斜体 / 删除线 / 链接 / 图片、白名单内的原始 HTML。
   ========================================================================== */
const RAW_TAG =
  /<\/?(?:div|sub|sup|span|a|br|hr|img|strong|em|b|i|code|pre|kbd|details|summary|table|thead|tbody|tr|th|td|ul|ol|li|p|h[1-6]|blockquote|figure|figcaption|video|source|small|s|del|mark|abbr|time|center)\b[^<>]*>/gi;

function slug(text, used) {
  let s = String(text)
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  if (!s) s = "section";
  let out = s;
  let n = 2;
  while (used.has(out)) out = s + "-" + n++;
  used.add(out);
  return out;
}

function inline(text) {
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return "\u0000" + (stash.length - 1) + "\u0000";
  };

  // 行内代码与白名单 HTML 先占位，避免被转义 / 被后续规则误伤
  let t = String(text)
    .replace(/`([^`]+)`/g, (m, c) => keep("<code>" + esc(c) + "</code>"))
    .replace(RAW_TAG, (m) => keep(m));

  t = esc(t);

  t = t
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
      (m, alt, src) => '<img src="' + src + '" alt="' + alt + '" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
      (m, txt, href) => '<a href="' + href + '">' + txt + "</a>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1">$1</a>');

  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
}

const stripInline = (s) => String(s).replace(/[`*_~]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

function codeBlock(code, lang) {
  const l = (lang || "").trim();
  return (
    '<div class="code"><div class="code-head"><span class="code-lang">' +
    esc(l || "text") +
    '</span><button class="code-copy" type="button">复制</button></div><pre><code>' +
    highlight(code, l) +
    "</code></pre></div>"
  );
}

function splitRow(row) {
  let s = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { cells.push(cur); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

const CALLOUT = {
  note: { ico: "ℹ️", title: "说明" },
  tip: { ico: "💡", title: "提示" },
  important: { ico: "❗", title: "重要" },
  warning: { ico: "⚠️", title: "注意" },
  caution: { ico: "🛑", title: "当心" },
};

function md(src, opts) {
  opts = opts || {};
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  const used = new Set();
  const toc = [];
  let i = 0;

  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  function listBlock(start, indent, ordered) {
    const items = [];
    let idx = start;
    let cur = null;

    while (idx < lines.length) {
      const line = lines[idx];
      const m = line.match(LIST_RE);

      if (m) {
        const ind = m[1].length;
        const isOrdered = /^\d/.test(m[2]);
        if (ind < indent || (ind === indent && items.length && isOrdered !== ordered)) break;
        if (ind > indent) {
          const sub = listBlock(idx, ind, isOrdered);
          if (cur) cur.sub.push(sub.html);
          idx = sub.next;
          continue;
        }
        cur = { text: m[3], sub: [] };
        items.push(cur);
        idx++;
        continue;
      }

      if (!line.trim()) {
        let j = idx + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length) break;
        const nm = lines[j].match(LIST_RE);
        if (nm && nm[1].length >= indent) { idx = j; continue; }
        if (cur && /^\s{2,}\S/.test(lines[j])) { idx = j; continue; }
        break;
      }

      if (cur && /^\s{2,}\S/.test(line) && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        cur.text += "\n" + line.trim();
        idx++;
        continue;
      }
      break;
    }

    const tag = ordered ? "ol" : "ul";
    const html =
      "<" + tag + ">" +
      items
        .map((it) => "<li>" + inline(it.text) + (it.sub.length ? it.sub.join("") : "") + "</li>")
        .join("") +
      "</" + tag + ">";
    return { html, next: idx };
  }

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // 围栏代码（支持 3+ 反引号 / 波浪线）
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/);
    if (fence) {
      const ch = fence[1][0];
      const len = fence[1].length;
      const lang = fence[2] || "";
      const buf = [];
      i++;
      while (i < lines.length) {
        const cm = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (cm && cm[1][0] === ch && cm[1].length >= len) { i++; break; }
        buf.push(lines[i]);
        i++;
      }
      out.push(codeBlock(buf.join("\n"), lang));
      continue;
    }

    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const lv = h[1].length;
      const text = h[2];
      const id = slug(stripInline(text), used);
      if (lv >= 2 && !opts.noToc) toc.push({ lv, text: stripInline(text), id });
      out.push(
        "<h" + lv + ' id="' + id + '">' + inline(text) +
        '<a class="anchor" href="#' + id + '" aria-label="永久链接">#</a></h' + lv + ">"
      );
      i++;
      continue;
    }

    // 表格
    if (line.indexOf("|") !== -1 && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf("-") !== -1) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) =>
        /^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : "left"
      );
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(
        '<div class="prose-table"><table><thead><tr>' +
        head.map((c, k) => '<th style="text-align:' + (aligns[k] || "left") + '">' + inline(c) + "</th>").join("") +
        "</tr></thead><tbody>" +
        rows.map((r) =>
          "<tr>" + head.map((_, k) => "<td>" + inline(r[k] == null ? "" : r[k]) + "</td>").join("") + "</tr>"
        ).join("") +
        "</tbody></table></div>"
      );
      continue;
    }

    // 引用块 / GitHub Alert
    if (/^ {0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        buf.push(lines[i].replace(/^ {0,3}>\s?/, ""));
        i++;
      }
      const a = buf[0] && buf[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i);
      const body = md(a ? buf.slice(1).join("\n") : buf.join("\n"), { noToc: true }).html;
      if (a) {
        const kind = a[1].toLowerCase();
        const c = CALLOUT[kind];
        out.push(
          '<div class="callout callout-' + kind + '"><span class="callout-ico">' + c.ico +
          '</span><div><div class="callout-title">' + c.title + "</div>" + body + "</div></div>"
        );
      } else {
        out.push("<blockquote>" + body + "</blockquote>");
      }
      continue;
    }

    // 列表
    const lm = line.match(LIST_RE);
    if (lm) {
      const r = listBlock(i, lm[1].length, /^\d/.test(lm[2]));
      out.push(r.html);
      i = r.next;
      continue;
    }

    // 原始 HTML 块
    if (/^ {0,3}</.test(line) && RAW_TAG.test(line)) {
      RAW_TAG.lastIndex = 0;
      out.push(line.trim());
      i++;
      continue;
    }

    // 段落
    const para = [line];
    i++;
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^ {0,3}(`{3,}|~{3,})/.test(lines[i]) &&
      !/^ {0,3}>/.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !(lines[i].indexOf("|") !== -1 && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push("<p>" + inline(para.join("\n")) + "</p>");
  }

  return { html: out.join("\n"), toc };
}

/* ==========================================================================
   3. 从正在运行的 MCP 服务实取工具清单（不写死）
   ========================================================================== */
function mcpIntrospect() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(PKG, "src", "server.mjs")], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    const got = {};
    const done = (v) => { try { p.kill(); } catch (e) {} resolve(v); };
    const timer = setTimeout(() => done({ tools: [], resources: [], prompts: [] }), 20000);

    p.stdout.on("data", (d) => {
      buf += d.toString();
      let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, k);
        buf = buf.slice(k + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch (e) { continue; }
        const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
        if (m.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
          send({ jsonrpc: "2.0", id: 3, method: "resources/list" });
          send({ jsonrpc: "2.0", id: 4, method: "prompts/list" });
        }
        if (m.id === 2) got.tools = (m.result && m.result.tools) || [];
        if (m.id === 3) got.resources = (m.result && m.result.resources) || [];
        if (m.id === 4) got.prompts = (m.result && m.result.prompts) || [];
        if (got.tools && got.resources && got.prompts) {
          clearTimeout(timer);
          done(got);
        }
      }
    });
    p.stderr.on("data", () => {});
    p.on("error", () => { clearTimeout(timer); done({ tools: [], resources: [], prompts: [] }); });
    p.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "build-site", version: "1" } },
    }) + "\n");
  });
}

/* ==========================================================================
   4. 页面骨架
   ========================================================================== */
const NAV = [
  { href: "", label: "首页" },
  { href: "tools.html", label: "工具" },
  { href: "endpoints.html", label: "接口" },
  { href: "guides.html", label: "指南" },
  { href: "webhooks.html", label: "推送" },
  { href: "errors.html", label: "错误码" },
  { href: "mock.html", label: "沙盒" },
  { href: "usage.html", label: "使用" },
];

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect width="32" height="32" rx="7" fill="#fb7299"/>' +
    '<path d="M9 12h14v9a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2z" fill="#fff"/>' +
    '<path d="M12 7l2.5 3M20 7l-2.5 3" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/>' +
    "</svg>"
  );

function layout(o) {
  const root = o.root || "";
  const title = o.title ? o.title + " · bili-open-mcp" : "bili-open-mcp · 哔哩哔哩 / B站 MCP Server";
  const desc = o.desc || "哔哩哔哩（B站）开放平台 MCP Server：170 篇官方文档、100 个端点、2.0 签名、OAuth2、直播长连、Webhook 与主站 Cookie 调用。";

  const nav = NAV.map((n) => {
    const href = root + n.href;
    const on = o.current === n.href;
    return '<a href="' + attr(href) + '"' + (on ? ' aria-current="page"' : "") + ">" + esc(n.label) + "</a>";
  }).join("");

  const sidebar = o.sidebar || "";

  const body = [
    '<div class="progress" id="progress"></div>',
    '<header class="topbar">',
    '<button class="icon-btn menu-btn" type="button" aria-label="打开目录">☰</button>',
    '<a class="brand" href="' + attr(root) + '"><span class="brand-mark">B</span>bili-open-mcp<small>MCP</small></a>',
    '<nav class="topnav">' + nav + "</nav>",
    '<div class="topbar-spacer"></div>',
    '<div class="topbar-actions">',
    '<button class="search-trigger" type="button"><span>🔍</span><span class="label">搜索文档 / 接口 / 工具</span><kbd>Ctrl K</kbd></button>',
    '<button class="icon-btn theme-toggle" type="button" aria-label="切换主题">☾</button>',
    '<a class="icon-btn" href="' + REPO + '" target="_blank" rel="noopener" aria-label="GitHub 仓库" title="GitHub">★</a>',
    "</div></header>",
    o.hero || "",
    o.plain
      ? o.main
      : '<div class="layout' + (o.toc === false ? " layout--no-toc" : "") + '">' +
        (sidebar || '<aside class="sidebar"></aside>') +
        '<main class="main">' + o.main + "</main>" +
        (o.toc === false ? "" : '<aside class="toc">' + (o.tocHtml || "") + "</aside>") +
        "</div>",
    footer(root),
    '<button class="to-top" type="button" aria-label="回到顶部">↑</button>',
    '<div class="modal" hidden><div class="modal-box">' +
      '<input class="modal-input" type="search" placeholder="搜索文档、接口、工具、错误码…" aria-label="站内搜索">' +
      '<div class="modal-results"></div>' +
      '<div class="modal-foot"><span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span><span>Ctrl/⌘ + K 唤起</span></div>' +
    "</div></div>",
    '<script src="' + attr(root) + 'assets/app.js" defer></script>',
  ].join("\n");

  return (
    "<!doctype html>\n<html lang=\"zh-CN\" data-theme=\"dark\">\n<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>" + esc(title) + "</title>\n" +
    '<meta name="description" content="' + attr(desc) + '">\n' +
    '<meta name="keywords" content="哔哩哔哩 MCP,B站 MCP,bilibili MCP,bilibili mcp server,哔哩哔哩开放平台,MCP Server,Model Context Protocol,开放平台 API,B站接口">\n' +
    '<link rel="canonical" href="' + attr(SITE_URL + "/" + (o.path || "")) + '">\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:title" content="' + attr(title) + '">\n' +
    '<meta property="og:description" content="' + attr(desc) + '">\n' +
    '<meta property="og:url" content="' + attr(SITE_URL + "/" + (o.path || "")) + '">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<link rel="icon" href="' + FAVICON + '">\n' +
    "<script>try{var t=localStorage.getItem('bili-theme')||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>\n" +
    "<script>window.__ROOT__=" + JSON.stringify(root) + ";</script>\n" +
    '<link rel="stylesheet" href="' + attr(root) + 'assets/style.css">\n' +
    "</head>\n<body>\n" + body + "\n</body>\n</html>\n"
  );
}

function footer(root) {
  return (
    '<footer class="footer"><div class="wrap"><div class="footer-grid">' +
    "<div><h4>bili-open-mcp</h4>" +
    '<p style="margin:0 0 10px;max-width:38ch">哔哩哔哩 / B站 MCP Server。把开放平台的 170 篇文档变成 AI 能直接检索、直接调用、直接生成签名的东西。</p>' +
    '<span class="badge badge-warn">第三方 · 与哔哩哔哩无隶属关系</span></div>' +
    "<div><h4>文档</h4>" +
    '<a href="' + root + 'usage.html">使用方法</a>' +
    '<a href="' + root + 'readme.html">README</a>' +
    '<a href="' + root + 'agents.html">AI 契约</a>' +
    '<a href="' + root + 'disclaimer.html">免责声明</a></div>' +
    "<div><h4>参考</h4>" +
    '<a href="' + root + 'tools.html">19 个工具</a>' +
    '<a href="' + root + 'endpoints.html">100 个端点</a>' +
    '<a href="' + root + 'guides.html">指南与协议</a>' +
    '<a href="' + root + 'webhooks.html">41 个推送事件</a>' +
    '<a href="' + root + 'errors.html">118 个错误码</a>' +
    '<a href="' + root + 'mock.html">43 个沙盒接口</a></div>' +
    "<div><h4>相关</h4>" +
    '<a href="' + REPO + '" target="_blank" rel="noopener">GitHub 仓库</a>' +
    '<a href="' + REPO + '/issues" target="_blank" rel="noopener">问题反馈</a>' +
    '<a href="https://open.bilibili.com/doc/4" target="_blank" rel="noopener">开放平台文档</a>' +
    '<a href="https://modelcontextprotocol.io" target="_blank" rel="noopener">MCP 规范</a></div>' +
    "</div>" +
    '<div class="footer-note">' +
    "本页所有接口均为哔哩哔哩官方提供并公开的接口，不含私有接口、破解接口或绕过鉴权的实现。" +
    "本站为静态文档站，不含任何凭据，也不会发起任何接口请求。" +
    "哔哩哔哩、bilibili、小电视是相应权利人的商标；本项目与哔哩哔哩无隶属、赞助或背书关系。" +
    "内容按「现状」提供，不构成任何担保 —— 详见 <a href=\"" + root + "disclaimer.html\">免责声明</a>。" +
    '<span style="display:block;margin-top:8px">© ' + new Date().getFullYear() +
    ' bili-open-mcp contributors · MIT License · 构建于 ' + new Date().toISOString().slice(0, 10) + "</span>" +
    "</div></div></footer>"
  );
}

function tocHtml(toc, title) {
  if (!toc || !toc.length) return "";
  return (
    '<div class="toc-title">' + esc(title || "本页目录") + "</div>" +
    toc.map((t) => '<a class="lvl-' + t.lv + '" href="#' + t.id + '">' + esc(t.text) + "</a>").join("")
  );
}

/* ==========================================================================
   5. 生成
   ========================================================================== */
const OUT_FILES = [];
function write(rel, content) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  OUT_FILES.push(rel.replace(/\\/g, "/"));
}

const htmlEscapeTitle = (s) => esc(s);

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const index = readJson(path.join(DATA, "index.json"));
  const codes = readJson(path.join(DATA, "status-codes.json"));
  const mock = readJson(path.join(DATA, "mock.json"));
  const mcp = await mcpIntrospect();

  const docs = index.docs.slice().sort((a, b) => a.num - b.num);
  const apis = docs.filter((d) => d.type === "api" || d.type === "multi-api");
  const events = docs.filter((d) => d.type === "event");
  const guides = docs.filter((d) => d.type === "guide" || d.type === "protocol");
  const scopes = new Set();
  docs.forEach((d) => (d.scopes || []).forEach((s) => scopes.add(s)));
  const endpointCount = apis.reduce((n, d) => n + Math.max(1, (d.endpoints || []).length || 1), 0);

  const groupOf = (d) => {
    const parts = String(d.folder || "").split(" / ").filter(Boolean);
    return parts[1] || parts[0] || "其他";
  };
  const moduleGroups = [...new Set(apis.map(groupOf))];

  const pad = (n) => String(n).padStart(3, "0");
  const apiHref = (d) => "api/" + pad(d.num) + ".html";
  const docRoot = index.docRoot || "";
  // 170 篇文档各有独立详情页：接口 / 指南与协议 / 推送事件 分目录存放
  const docHref = (d) =>
    d.type === "event"
      ? "event/" + pad(d.num) + ".html"
      : d.type === "api" || d.type === "multi-api"
        ? "api/" + pad(d.num) + ".html"
        : "guide/" + pad(d.num) + ".html";
  const docDir = (d) => docHref(d).split("/")[0];

  /* ---------- 静态资源 ---------- */
  for (const f of ["style.css", "app.js"]) {
    const p = path.join(SITE_SRC, "assets", f);
    if (!fs.existsSync(p)) throw new Error("缺少 site/assets/" + f);
    write("assets/" + f, read(p));
  }
  write(".nojekyll", "");

  /* ---------- 侧边栏 ---------- */
  const apiSidebar = (current) =>
    '<aside class="sidebar">' +
    '<div class="sidebar-group"><div class="sidebar-title">文档站</div>' +
    [
      ["", "首页"],
      ["tools.html", "19 个工具"],
      ["endpoints.html", "接口总览"],
      ["guides.html", "指南与协议"],
      ["webhooks.html", "推送事件"],
      ["errors.html", "错误码"],
      ["mock.html", "沙盒环境"],
      ["usage.html", "使用方法"],
      ["readme.html", "README"],
      ["agents.html", "AI 契约"],
      ["disclaimer.html", "免责声明"],
    ].map(([h, l]) =>
      '<a href="' + (current && current.root ? current.root : "") + h + '"' +
      (current && current.href === h ? ' class="is-active"' : "") + ">" + esc(l) + "</a>"
    ).join("") +
    "</div>" +
    '<div class="sidebar-group"><div class="sidebar-title">开放能力 · ' + apis.length + " 个接口</div>" +
    moduleGroups.map((g) => {
      const items = apis.filter((d) => groupOf(d) === g);
      return (
        '<a href="' + (current && current.root ? current.root : "") + "endpoints.html#" + encodeURIComponent(g) + '">' +
        esc(g) + '<span class="count">' + items.length + "</span></a>"
      );
    }).join("") +
    "</div>" +
    '<div class="sidebar-group"><div class="sidebar-title">指南与协议 · ' + guides.length + " 篇</div>" +
    guides.slice(0, 40).map((d) =>
      '<a href="' + (current && current.root ? current.root : "") + docHref(d) + '">' + esc(d.title) + "</a>"
    ).join("") +
    "</div></aside>";

  /* ======================= 首页 ======================= */
  const installCmd = "git clone " + REPO + ".git";
  const envCmd = "cd bili-open-mcp-bilibili-mcp-server && npm ci";

  const clientConfigs = [
    ["Claude Desktop", "json", '{\n  "mcpServers": {\n    "bili-open": {\n      "command": "node",\n      "args": ["C:/path/to/bili-open-mcp/src/server.mjs"],\n      "env": {\n        "BILI_CLIENT_ID": "your_client_id",\n        "BILI_APP_SECRET": "your_app_secret",\n        "BILI_ACCESS_TOKEN": "your_access_token"\n      }\n    }\n  }\n}'],
    ["Claude Code", "bash", 'claude mcp add bili-open -- node "C:/path/to/bili-open-mcp/src/server.mjs"'],
    ["Cursor", "json", '{\n  "mcpServers": {\n    "bili-open": {\n      "command": "node",\n      "args": ["C:/path/to/bili-open-mcp/src/server.mjs"]\n    }\n  }\n}'],
    ["Codex", "toml", '[mcp_servers.bili-open]\ncommand = "node"\nargs = ["C:/path/to/bili-open-mcp/src/server.mjs"]\nenv = { BILI_CLIENT_ID = "", BILI_APP_SECRET = "", BILI_ACCESS_TOKEN = "" }'],
    ["OpenCode", "json", '{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "bili-open": {\n      "type": "local",\n      "command": ["node", "C:/path/to/bili-open-mcp/src/server.mjs"],\n      "enabled": true,\n      "timeout": 60000\n    }\n  }\n}'],
  ];

  const toolCard = (t, withParams) => {
    const props = (t.inputSchema && t.inputSchema.properties) || {};
    const required = new Set((t.inputSchema && t.inputSchema.required) || []);
    const rows = Object.keys(props);
    let table = "";
    if (withParams && rows.length) {
      table =
        '<table class="param-table"><thead><tr><th>参数</th><th>类型</th><th>说明</th></tr></thead><tbody>' +
        rows.map((k) => {
          const v = props[k] || {};
          const ty = v.enum ? "enum" : v.type || "any";
          const req = required.has(k) ? ' <span class="req" title="必填">*</span>' : "";
          return (
            "<tr><td>" + esc(k) + req + "</td><td>" + esc(ty) + "</td><td>" +
            esc((v.description || "").split("\n")[0]) + "</td></tr>"
          );
        }).join("") +
        "</tbody></table>";
    } else if (withParams) {
      table = '<p class="desc" style="color:var(--muted-2)">无参数</p>';
    }
    return (
      '<article class="tool-card" id="' + attr(t.name) + '"><h3>' + esc(t.name) + "</h3>" +
      '<p class="desc">' + esc((t.description || "").split("\n")[0]) + "</p>" + table + "</article>"
    );
  };

  const hero =
    '<section class="hero"><div class="hero-inner">' +
    '<span class="pill"><span class="dot"></span>第三方项目 · 与哔哩哔哩无隶属关系 · ' +
    apis.length + " 个接口 · " + mcp.tools.length + " 个 MCP 工具</span>" +
    '<h1>把<span class="grad">哔哩哔哩开放平台</span><br>变成 AI 能直接调用的工具</h1>' +
    '<p class="hero-sub">' + esc(docs.length) + " 篇官方文档、<strong>" + endpointCount + "</strong> 个端点、" +
    events.length + " 个推送事件、<strong>" + mcp.tools.length + "</strong> 个 MCP 工具。" +
    "文档检索、结构化规格、2.0 签名、OAuth2、直播长连、Webhook 验签、主站 Cookie 调用 —— 一次接好。" +
    "所有接口均为官方公开提供，凭据自备、只在本机。</p>" +
    '<div class="hero-actions">' +
    '<a class="btn btn-primary" href="usage.html">开始使用 →</a>' +
    '<a class="btn btn-ghost" href="endpoints.html">浏览 ' + endpointCount + " 个接口</a>" +
    '<a class="btn btn-ghost" href="' + REPO + '" target="_blank" rel="noopener">★ GitHub</a>' +
    "</div>" +
    '<div class="cmd"><span class="prompt">$</span><code>' + esc(installCmd) + "</code>" +
    '<button class="code-copy" type="button" data-copy="' + attr(installCmd) + '">复制</button></div>' +
    '<p style="margin:14px 0 0;font-size:13px;color:var(--muted-2)">然后 <code>' + esc(envCmd) + "</code>，把 <code>src/server.mjs</code> 填进客户端的 MCP 配置即可。</p>" +
    "</div></section>";

  const stats =
    '<div class="stats">' +
    [
      [docs.length, "篇官方文档"],
      [endpointCount, "个 HTTP 端点"],
      [events.length, "个推送事件"],
      [Object.keys(codes).length, "个错误码"],
      [mcp.tools.length, "个 MCP 工具"],
      [mock.entries.length, "个沙盒接口"],
    ].map(([n, l]) => '<div class="stat"><b>' + n + "</b><span>" + esc(l) + "</span></div>").join("") +
    "</div>";

  const features =
    '<div class="grid grid-3">' +
    [
      ["📚", "文档即数据", "170 篇官方文档解析成结构化规格：参数名、类型、必填、响应字段、子结构全都带，AI 检索命中率远高于喂原始 Markdown。"],
      ["🔐", "签名不用手拼", "2.0 签名（HMAC-SHA256）已实现：六个 x-bili-* 头按字典序拼串、body md5、nonce、时间戳，一步生成可直接粘贴的 curl。"],
      ["🔑", "OAuth2 一条龙", "授权链接拼装 → code 换 token → refresh 续期 → 凭据体检。换到的 token 自动落盘，还能看清每一格凭据到底从哪来。"],
      ["📡", "直播长连协议", "官方直播间 WebSocket 协议：16 字节包头、Operation 表、zlib 多包拆解，附可运行的 Python 客户端。"],
      ["🔔", "Webhook 验签", "41 个推送事件的内容字段，以及 SHA1(secret + 原始 body) 的验签代码 —— 这是最容易错的一步，必须用原始字节。"],
      ["🍪", "主站 Cookie 调用", "另一套体系：用你自己的浏览器 Cookie 调主站 Web 接口，POST 自动补 csrf，/wbi/ 路径自动算 w_rid。"],
    ].map(([i, t, d]) =>
      '<div class="card"><h3><span class="ico">' + i + "</span>" + esc(t) + "</h3><p>" + esc(d) + "</p></div>"
    ).join("") +
    "</div>";

  const toolGrid =
    '<div class="grid grid-2">' + mcp.tools.map((t) => toolCard(t, false)).join("") + "</div>" +
    '<p style="margin-top:20px"><a class="btn btn-ghost" href="tools.html">查看每个工具的完整入参 →</a></p>';

  const clientTabs =
    '<div class="tabs"><div class="tablist" role="tablist">' +
    clientConfigs.map(([n], i) =>
      '<button class="tab" role="tab" type="button" aria-selected="' + (i === 0) + '" aria-controls="cfg-' + i + '" tabindex="' + (i ? -1 : 0) + '">' + esc(n) + "</button>"
    ).join("") +
    "</div>" +
    clientConfigs.map(([, lang, cfg], i) =>
      '<div class="tabpanel" id="cfg-' + i + '" role="tabpanel"' + (i ? " hidden" : "") + ">" + codeBlock(cfg, lang) + "</div>"
    ).join("") +
    "</div>" +
    '<p style="color:var(--muted)">完整 6 类客户端的配置、凭据获取步骤与排错表见 <a href="usage.html">使用方法</a>。</p>';

  const steps =
    '<div class="grid grid-3">' +
    [
      ["1", "克隆并安装", "需要 Node.js ≥ 18。跑 <code>npm ci</code>，再用 <code>npm run selftest</code> 确认 19 个工具都能起来。"],
      ["2", "配好凭据", "开放平台凭据放 <code>secrets/open-platform.json</code>；主站 Cookie 放 <code>secrets/cookies.json</code>。没有凭据也能用文档类工具。"],
      ["3", "接进客户端", "把 <code>src/server.mjs</code> 填进任意支持 stdio 的 MCP 客户端，让 AI 调一次 <code>bili_quickstart</code> 就算通了。"],
    ].map(([n, t, d]) =>
      '<div class="card"><h3><span class="ico">' + n + "</span>" + esc(t) + "</h3><p>" + d + "</p></div>"
    ).join("") +
    "</div>";

  const homeMain =
    stats +
    '<div class="wrap"><section class="section"><div class="section-head"><h2>它能做什么</h2>' +
    "<p>不是把文档搬过来，是把文档变成可以直接调用的能力。</p></div>" + features + "</section>" +
    '<section class="section"><div class="section-head"><h2>' + mcp.tools.length + " 个 MCP 工具</h2>" +
    "<p>找文档 → 看懂接口 → 生成签名 → 发请求 → 排错，一条链路走完。</p></div>" + toolGrid + "</section>" +
    '<section class="section"><div class="section-head"><h2>接进你的客户端</h2>' +
    "<p>任意支持 MCP stdio 的客户端，本质就是启动 <code>node src/server.mjs</code> 再收发 JSON-RPC。</p></div>" +
    clientTabs + "</section>" +
    '<section class="section"><div class="section-head"><h2>三步跑起来</h2></div>' + steps + "</section>" +
    '<section class="section"><div class="section-head"><h2>凭据决定能力边界</h2>' +
    "<p>两个凭据都不配，仍然能用文档检索、错误码、代码生成、沙盒与签名演示。</p></div>" +
    '<div class="prose-table"><table><thead><tr><th>你想做的事</th><th>需要什么</th><th>用哪些工具</th></tr></thead><tbody>' +
    [
      ["查文档、看参数、生成调用代码", "不需要凭据", "bili_docs_* · bili_api_spec · bili_codegen"],
      ["查错误码、看长连 / 推送协议", "不需要凭据", "bili_error_lookup · bili_ws_protocol · bili_webhook"],
      ["打官方沙盒", "不需要凭据", "bili_mock"],
      ["真调开放平台接口、投稿、上传", "secrets/open-platform.json", "bili_api_call · bili_upload_plan · bili_oauth"],
      ["以你的登录身份调主站 Web 接口", "secrets/cookies.json", "bili_cookie · bili_web_call"],
    ].map((r) => "<tr><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) + "</td><td><code>" + esc(r[2]) + "</code></td></tr>").join("") +
    "</tbody></table></div></section></div>";

  write("index.html", layout({ path: "", current: "", hero: hero, main: homeMain, plain: true, desc: "哔哩哔哩 / B站（bilibili）MCP Server：170 篇官方文档、" + endpointCount + " 个端点、2.0 签名、OAuth2、直播长连、Webhook 与主站 Cookie 调用。" }));

  /* ======================= 工具页 ======================= */
  const toolGroups = { 开放平台: [], 专题: [], 主站: [] };
  mcp.tools.forEach((t) => {
    if (/^bili_(cookie|web_call)$/.test(t.name)) toolGroups["主站"].push(t);
    else if (/^bili_(oauth|webhook|ws_protocol|mock|upload_plan)$/.test(t.name)) toolGroups["专题"].push(t);
    else toolGroups["开放平台"].push(t);
  });

  const toolsMain =
    '<h1 class="page-title">' + mcp.tools.length + " 个 MCP 工具</h1>" +
    '<p class="page-lede">下面是服务实际注册的工具 —— 入参直接取自运行中的 <code>src/server.mjs</code>（tools/list），不是手抄的。' +
    "带 <span class=\"req\">*</span> 的是必填。</p>" +
    '<div data-filter-scope><div class="toolbar">' +
    '<input class="input" data-filter-input type="search" placeholder="按名称或说明筛选工具…" aria-label="筛选工具">' +
    '<div class="chips">' +
    '<button class="chip" data-filter-chip="all" aria-pressed="true">全部<span class="n">' + mcp.tools.length + "</span></button>" +
    Object.keys(toolGroups).map((g) =>
      '<button class="chip" data-filter-chip="' + attr(g) + '" aria-pressed="false">' + esc(g) +
      '<span class="n">' + toolGroups[g].length + "</span></button>"
    ).join("") +
    "</div>" +
    '<span class="result-count" data-filter-count></span></div>' +
    Object.keys(toolGroups).map((g) =>
      '<section class="section" style="padding-top:8px"><div class="section-head"><h2>' + esc(g) + "</h2></div>" +
      '<div class="grid grid-2">' +
      toolGroups[g].map((t) =>
        '<div data-item data-group="' + attr(g) + '" data-search="' + attr(t.name + " " + (t.description || "")) + '" style="display:contents">' +
        toolCard(t, true) + "</div>"
      ).join("") +
      "</div></section>"
    ).join("") +
    '<div class="empty" data-filter-empty hidden>没有匹配的工具</div></div>';

  write("tools.html", layout({
    path: "tools.html", current: "tools.html",
    title: mcp.tools.length + " 个 MCP 工具",
    desc: "bili-open-mcp 注册的全部 MCP 工具及其入参：文档检索、接口规格、签名、OAuth2、直播长连、Webhook、主站 Cookie。",
    sidebar: apiSidebar({ root: "", href: "tools.html" }),
    main: toolsMain,
    toc: false,
  }));

  /* ======================= 接口总览 ======================= */
  const epRow = (d) =>
    '<a class="ep" href="' + apiHref(d) + '" data-item data-select="' + attr(d.method || "N/A") +
    '" data-group="' + attr(groupOf(d)) + '"' +
    ' data-search="' + attr([d.title, d.url || "", d.folder || "", (d.scopes || []).join(" ")].join(" ")) + '">' +
    '<span class="badge badge-method badge-' + attr((d.method || "get").toUpperCase()) + '">' + esc(d.method || "—") + "</span>" +
    "<div><div class=\"ep-title\">" + esc(d.title) + "</div>" +
    (d.url ? '<div class="ep-path">' + esc(d.url.replace(/^https?:\/\/[^/]+/, "")) + "</div>" : "") +
    '<div class="ep-folder">' + esc(d.folder || "") + "</div></div>" +
    '<div class="ep-scopes">' + (d.scopes || []).map((s) => '<span class="badge badge-scope">' + esc(s) + "</span>").join("") + "</div>" +
    "</a>";

  const epMain =
    '<h1 class="page-title">接口总览</h1>' +
    '<p class="page-lede">' + apis.length + " 个接口，共 <strong>" + endpointCount + "</strong> 个 HTTP 端点；另有 " +
    guides.length + " 篇指南与协议。点任意一条进详情页看参数与示例。</p>" +
    '<div data-filter-scope><div class="toolbar">' +
    '<input class="input" data-filter-input type="search" placeholder="搜接口名、路径、scope…" aria-label="筛选接口">' +
    '<select class="input" data-filter-select aria-label="按方法筛选">' +
    "<option value=\"\">全部方法</option>" +
    ["GET", "POST", "PUT", "DELETE"].map((m) => '<option value="' + m + '">' + m + "</option>").join("") +
    "</select>" +
    '<span class="result-count" data-filter-count></span></div>' +
    '<div class="chips" style="margin-bottom:20px">' +
    '<button class="chip" data-filter-chip="all" aria-pressed="true">全部模块<span class="n">' + apis.length + "</span></button>" +
    moduleGroups.map((g) => {
      const n = apis.filter((d) => groupOf(d) === g).length;
      return '<button class="chip" data-filter-chip="' + attr(g) + '" aria-pressed="false">' + esc(g) + '<span class="n">' + n + "</span></button>";
    }).join("") +
    "</div>" +
    '<div class="ep-list">' + apis.map(epRow).join("") + "</div>" +
    '<div class="empty" data-filter-empty hidden>没有匹配的接口</div></div>';

  write("endpoints.html", layout({
    path: "endpoints.html", current: "endpoints.html",
    title: "接口总览",
    desc: "哔哩哔哩开放平台 " + apis.length + " 个接口 / " + endpointCount + " 个端点的完整清单，可按方法、模块筛选。",
    sidebar: apiSidebar({ root: "", href: "endpoints.html" }),
    main: epMain,
    toc: false,
  }));

  /* ======================= 接口详情 ======================= */
  const paramTable = (title, rows) => {
    if (!rows || !rows.length) return "";
    return (
      '<h3 id="' + slug(title, new Set()) + '">' + esc(title) + "</h3>" +
      '<div class="prose-table"><table><thead><tr><th>名称</th><th>类型</th><th>必填</th><th>说明</th></tr></thead><tbody>' +
      rows.map((p) =>
        "<tr><td>" + esc(p.name) + "</td><td>" + esc(p.type || "") + "</td><td>" +
        (p.required ? '<span class="req">是</span>' : '<span style="color:var(--muted-2)">否</span>') +
        "</td><td>" + esc(p.desc || "") + "</td></tr>"
      ).join("") +
      "</tbody></table></div>"
    );
  };

  apis.forEach((d) => {
    const scopesHtml = (d.scopes || []).map((s) => '<span class="badge badge-scope">' + esc(s) + "</span>").join(" ");
    const callSnippet =
      '// 让 AI 直接调（需要开放平台凭据）\nbili_api_call { "ref": "' + d.num + '", "query": {…}, "body": {…} }\n\n' +
      '// 只看将要发出的请求（不需要凭据）\nbili_api_call { "ref": "' + d.num + '", "dryRun": true }\n\n' +
      '// 生成完整调用代码\nbili_codegen { "ref": "' + d.num + '", "lang": "python" }';

    const toc = [];
    const used = new Set();
    ["url 参数", "body 参数", "响应字段"].forEach((t) => {
      const has =
        (t === "url 参数" && d.urlParams && d.urlParams.length) ||
        (t === "body 参数" && d.bodyParams && d.bodyParams.length) ||
        (t === "响应字段" && d.responseParams && d.responseParams.length);
      if (has) toc.push({ lv: 3, text: t, id: slug(t, used) });
    });
    toc.push({ lv: 3, text: "调用方式", id: slug("调用方式", used) });

    const main =
      '<nav class="breadcrumb"><a href="../endpoints.html">接口总览</a><span class="sep">/</span>' +
      esc(groupOf(d)) + '<span class="sep">/</span><span>' + esc(d.title) + "</span></nav>" +
      '<h1 class="page-title">' + esc(d.title) + "</h1>" +
      '<div class="api-head"><div class="api-meta">' +
      '<span class="badge badge-method badge-' + attr((d.method || "get").toUpperCase()) + '">' + esc(d.method || "—") + "</span>" +
      '<span class="badge badge-muted">#' + d.num + "</span>" +
      '<span class="badge badge-info">' + esc(d.type) + "</span>" +
      (scopesHtml ? " " + scopesHtml : "") +
      "</div>" +
      (d.url ? '<div class="api-url"><span class="u">' + esc(d.url) + '</span><button class="code-copy" type="button" data-copy="' + attr(d.url) + '">复制</button></div>' : "") +
      '<p style="margin:14px 0 0;color:var(--muted);font-size:14px">' + esc(d.folder || "") + "</p></div>" +
      (d.summary ? "<p>" + esc(d.summary) + "</p>" : "") +
      paramTable("url 参数", d.urlParams) +
      paramTable("body 参数", d.bodyParams) +
      paramTable("响应字段", d.responseParams) +
      '<h3 id="' + slug("调用方式", new Set()) + '">调用方式</h3>' +
      codeBlock(callSnippet, "javascript") +
      (d.requestExample ? "<h3>官方请求示例</h3>" + codeBlock(d.requestExample, "bash") : "") +
      '<hr><p style="color:var(--muted);font-size:14px">原始文档：<code>' + esc(d.file) + "</code>（" + d.bytes +
      " 字节）。用 <code>bili_docs_get { \"ref\": \"" + d.num + "\" }</code> 读全文，或用 <code>bili_api_spec { \"ref\": \"" +
      d.num + "\" }</code> 取结构化规格。</p>";

    write("api/" + pad(d.num) + ".html", layout({
      root: "../",
      path: "api/" + pad(d.num) + ".html",
      title: d.title,
      desc: (d.title + " — " + (d.url || "") + " — " + (d.summary || "")).slice(0, 200),
      sidebar: apiSidebar({ root: "../", href: "" }),
      tocHtml: tocHtml(toc),
      main: main,
    }));
  });

  /* ======================= 指南与协议 · 总览 ======================= */
  const guideRow = (d) =>
    '<a class="ep" href="' + docHref(d) + '" data-item data-group="' + attr(groupOf(d)) + '" data-search="' + attr(d.title + " " + (d.folder || "")) + '">' +
    '<span class="badge badge-method badge-GET">DOC</span>' +
    '<div><div class="ep-title">' + esc(d.title) + '</div><div class="ep-folder">' + esc(d.folder || "") + "</div></div>" +
    '<div class="ep-scopes"><span class="badge badge-muted">#' + d.num + "</span></div></a>";

  const gMain =
    '<h1 class="page-title">指南与协议</h1>' +
    '<p class="page-lede">这 ' + guides.length + " 篇不是单个 HTTP 接口，而是签名规则、权限白名单、业务说明、直播长连协议这类说明文档。" +
    '接口清单见 <a href="endpoints.html">接口总览</a>，事件清单见 <a href="webhooks.html">推送事件</a>。</p>' +
    '<div data-filter-scope><div class="toolbar">' +
    '<input class="input" data-filter-input type="search" placeholder="搜指南标题、路径…" aria-label="筛选指南">' +
    '<span class="result-count" data-filter-count></span></div>' +
    '<div class="ep-list">' + guides.map(guideRow).join("") + "</div>" +
    '<div class="empty" data-filter-empty hidden>没有匹配的指南</div></div>';

  write("guides.html", layout({
    path: "guides.html", current: "guides.html",
    title: "指南与协议",
    desc: "哔哩哔哩开放平台 " + guides.length + " 篇指南与协议：签名规则、权限白名单、业务流程、直播长连与消息协议。",
    sidebar: apiSidebar({ root: "", href: "guides.html" }),
    main: gMain,
    toc: false,
  }));

  /* ======================= 指南 / 事件 详情 ======================= */
  [...guides, ...events].forEach((d) => {
    const isEvent = d.type === "event";
    const raw = read(path.join(docRoot, d.file));
    // 原文自带一级标题，摘出来当页面标题，避免正文里出现两个 h1
    const h1m = raw.match(/^\s*#\s+([^\n]*)\n/);
    const docH1 = h1m ? h1m[1].trim() : "";
    const r = md(h1m ? raw.slice(h1m[0].length) : raw);
    const parent = isEvent ? "webhooks.html" : "guides.html";
    const parentLabel = isEvent ? "推送事件" : "指南与协议";
    const main =
      '<nav class="breadcrumb"><a href="../' + parent + '">' + parentLabel + '</a><span class="sep">/</span>' +
      esc(groupOf(d)) + '<span class="sep">/</span><span>' + esc(d.title) + "</span></nav>" +
      '<h1 class="page-title">' + esc(d.title) + "</h1>" +
      '<div class="api-head"><div class="api-meta">' +
      '<span class="badge badge-info">' + esc(isEvent ? "event" : d.type) + "</span>" +
      '<span class="badge badge-muted">#' + d.num + "</span>" +
      (docH1 && docH1 !== d.title ? '<span class="badge badge-muted">' + esc(docH1) + "</span>" : "") +
      ((d.scopes || []).map((s) => '<span class="badge badge-scope">' + esc(s) + "</span>").join(" ")) +
      "</div>" +
      (d.summary ? '<p style="margin:14px 0 0;color:var(--muted);font-size:14px">' + esc(d.summary) + "</p>" : "") +
      "</div>" +
      '<article class="prose">' + fixRepoLinks(r.html, "../") + "</article>" +
      '<hr><p style="color:var(--muted);font-size:14px">原始文档：<code>' + esc(d.file) + "</code>（" + d.bytes +
      ' 字节）。用 <code>bili_docs_get { "ref": "' + d.num + '" }</code> 读全文，用 <code>bili_docs_search { "query": "…" }</code> 检索。</p>';

    write(docHref(d), layout({
      root: "../",
      path: docHref(d),
      title: d.title,
      desc: (d.title + " — " + (d.folder || "") + " — " + (d.summary || "")).slice(0, 200),
      sidebar: apiSidebar({ root: "../", href: "" }),
      tocHtml: tocHtml(r.toc, "本页目录"),
      main: main,
    }));
  });

  /* ======================= 推送事件 ======================= */
  const evGroups = [...new Set(events.map(groupOf))];
  const evMain =
    '<h1 class="page-title">推送事件 · ' + events.length + " 个</h1>" +
    '<p class="page-lede">开放平台 Webhook 推送的全部事件。验签用 <code>SHA1(app_secret + 原始 body)</code>，' +
    "与请求头 <code>x-bilibili-signature</code> 比对 —— <strong>必须用原始字节，重新序列化会验签失败</strong>。</p>" +
    '<div data-filter-scope><div class="toolbar">' +
    '<input class="input" data-filter-input type="search" placeholder="搜事件名…" aria-label="筛选事件">' +
    '<span class="result-count" data-filter-count></span></div>' +
    '<div class="ep-list">' +
    events.map((d) =>
      '<a class="ep" href="' + docHref(d) + '" data-item data-group="' + attr(groupOf(d)) + '" data-search="' + attr(d.title + " " + d.folder) + '">' +
      '<span class="badge badge-method badge-POST">EVT</span>' +
      '<div><div class="ep-title">' + esc(d.title) + '</div><div class="ep-folder">' + esc(d.folder || "") + "</div></div>" +
      '<div class="ep-scopes"><span class="badge badge-muted">#' + d.num + "</span></div></a>"
    ).join("") +
    "</div>" +
    '<div class="empty" data-filter-empty hidden>没有匹配的事件</div></div>' +
    "<h2>验签代码</h2>" +
    codeBlock(
      "import hashlib, hmac\n\n" +
      "def verify(secret: str, raw_body: bytes, signature: str) -> bool:\n" +
      "    # 必须用收到的原始字节，不要重新序列化 JSON\n" +
      "    expected = hashlib.sha1(secret.encode() + raw_body).hexdigest()\n" +
      "    return hmac.compare_digest(expected, signature)\n",
      "python"
    );

  write("webhooks.html", layout({
    path: "webhooks.html", current: "webhooks.html",
    title: "推送事件",
    desc: "哔哩哔哩开放平台 Webhook 的 " + events.length + " 个推送事件与验签方式。",
    sidebar: apiSidebar({ root: "", href: "webhooks.html" }),
    main: evMain,
    toc: false,
  }));

  /* ======================= 错误码 ======================= */
  const codePrefixes = {};
  Object.keys(codes).forEach((c) => {
    const p = c.slice(0, 3) + "xxx";
    codePrefixes[p] = (codePrefixes[p] || 0) + 1;
  });
  const prefixList = Object.keys(codePrefixes).sort((a, b) => codePrefixes[b] - codePrefixes[a]);

  const codeRow = (c) =>
    '<div class="ep" style="grid-template-columns:110px minmax(0,1fr)" data-item data-group="' + attr(c.slice(0, 3) + "xxx") +
    '" data-search="' + attr(c + " " + codes[c]) + '">' +
    '<span class="badge badge-method badge-DELETE">' + esc(c) + "</span>" +
    "<div>" + esc(codes[c]) + "</div></div>";

  const codeMain =
    '<h1 class="page-title">错误码 · ' + Object.keys(codes).length + " 个</h1>" +
    '<p class="page-lede">返回体是 <code>{code, message, data, request_id}</code>，<code>code=0</code> 才是成功 —— ' +
    "HTTP 200 也可能是业务错误。非 0 时用 <code>bili_error_lookup { \"code\": \"…\" }</code> 查。</p>" +
    '<div data-filter-scope><div class="toolbar">' +
    '<input class="input" data-filter-input type="search" placeholder="搜错误码或含义…" aria-label="筛选错误码">' +
    '<span class="result-count" data-filter-count></span></div>' +
    '<div class="chips" style="margin-bottom:20px">' +
    '<button class="chip" data-filter-chip="all" aria-pressed="true">全部前缀<span class="n">' + Object.keys(codes).length + "</span></button>" +
    prefixList.map((p) =>
      '<button class="chip" data-filter-chip="' + attr(p) + '" aria-pressed="false">' + esc(p) + '<span class="n">' + codePrefixes[p] + "</span></button>"
    ).join("") +
    "</div>" +
    '<div class="ep-list">' + Object.keys(codes).map(codeRow).join("") + "</div>" +
    '<div class="empty" data-filter-empty hidden>没有匹配的错误码</div></div>';

  write("errors.html", layout({
    path: "errors.html", current: "errors.html",
    title: "错误码",
    desc: "哔哩哔哩开放平台 " + Object.keys(codes).length + " 个错误码含义速查。",
    sidebar: apiSidebar({ root: "", href: "errors.html" }),
    main: codeMain,
    toc: false,
  }));

  /* ======================= 沙盒 ======================= */
  const mockGroups = {};
  mock.entries.forEach((e) => {
    (mockGroups[e.group] = mockGroups[e.group] || []).push(e);
  });
  const mockMain =
    '<h1 class="page-title">沙盒环境 · ' + mock.entries.length + " 个接口</h1>" +
    '<p class="page-lede">沙盒 host 是 <code>' + esc(mock.host) + "</code>。" +
    "同一个 OAuth2 access_token 即可调用，但<strong>应用仍需已申请对应 scope</strong>。" +
    "注意 mock 路径与正式路径不总一致，用 <code>bili_mock { action: \"map\", ref: \"12\" }</code> 换算。</p>" +
    '<div data-filter-scope><div class="toolbar">' +
    '<input class="input" data-filter-input type="search" placeholder="搜沙盒接口…" aria-label="筛选沙盒接口">' +
    '<span class="result-count" data-filter-count></span></div>' +
    Object.keys(mockGroups).map((g) =>
      '<section class="section" style="padding-top:8px"><div class="section-head"><h2>' + esc(g) +
      '<span class="badge badge-muted" style="margin-left:10px">' + mockGroups[g].length + "</span></h2></div>" +
      '<div class="ep-list">' +
      mockGroups[g].map((e) =>
        '<div class="ep" style="grid-template-columns:minmax(0,1fr)" data-item data-group="' + attr(g) +
        '" data-search="' + attr(e.feature + " " + e.url) + '">' +
        '<div><div class="ep-title">' + esc(e.feature) + '</div><div class="ep-path">' + esc(e.url) +
        '</div><button class="code-copy" type="button" data-copy="' + attr(e.url) + '" style="margin-top:6px">复制地址</button></div></div>'
      ).join("") +
      "</div></section>"
    ).join("") +
    '<div class="empty" data-filter-empty hidden>没有匹配的沙盒接口</div></div>';

  write("mock.html", layout({
    path: "mock.html", current: "mock.html",
    title: "沙盒环境",
    desc: "哔哩哔哩开放平台沙盒（mock）" + mock.entries.length + " 个接口地址清单。",
    sidebar: apiSidebar({ root: "", href: "mock.html" }),
    main: mockMain,
    toc: false,
  }));

  /* ======================= Markdown 正文页 ======================= */
  const MD_PAGES = [
    ["README.md", "readme.html", "README", "项目总览：能力、目录结构、快速开始、工具一览。"],
    ["USAGE.md", "usage.html", "使用方法", "安装、接入 6 类客户端、获取两套凭据、19 个工具详解、端到端工作流、报错排查。"],
    ["AGENTS.md", "agents.html", "AI 使用契约", "给 AI 的详细契约：数据结构、工具决策树、请求总则、接口索引、交付前自检清单。"],
    ["DISCLAIMER.md", "disclaimer.html", "免责声明", "15 条：接口来源、无隶属关系、凭据边界、账号安全、使用者责任、无担保、隐私、二次分发。"],
  ];

  MD_PAGES.forEach(([file, out, title, desc]) => {
    const src = read(path.join(PKG, file));
    const r = md(src);
    write(out, layout({
      root: "", path: out, current: out, title,
      desc,
      sidebar: apiSidebar({ root: "", href: out }),
      tocHtml: tocHtml(r.toc, "本页目录"),
      main: '<article class="prose">' + fixRepoLinks(r.html, "") + "</article>" +
        '<div class="callout callout-note" style="margin-top:40px"><span class="callout-ico">📄</span><div>' +
        '这是 <code>' + esc(file) + "</code> 的站点渲染版，原文在仓库根目录；" +
        '<a href="' + REPO + '/blob/main/' + file + '" target="_blank" rel="noopener">在 GitHub 上查看 Markdown 源码</a>。' +
        "</div></div>",
    }));
  });

  /* ======================= 404 ======================= */
  write("404.html", layout({
    root: "/bili-open-mcp-bilibili-mcp-server/",
    path: "404.html", title: "页面不存在",
    plain: true,
    main:
      '<div class="hero"><div class="hero-inner"><h1>404</h1>' +
      '<p class="hero-sub">没找到这个页面。</p>' +
      '<div class="hero-actions"><a class="btn btn-primary" href="/bili-open-mcp-bilibili-mcp-server/">回首页</a>' +
      '<a class="btn btn-ghost" href="/bili-open-mcp-bilibili-mcp-server/endpoints.html">浏览接口</a></div></div></div>',
  }));

  /* ======================= 搜索索引 ======================= */
  const si = [];
  apis.forEach((d) => si.push({ t: d.title, u: docHref(d), d: (d.summary || d.url || "").slice(0, 120), k: "接口" }));
  guides.forEach((d) => si.push({ t: d.title, u: docHref(d), d: (d.summary || d.folder || "").slice(0, 120), k: "指南" }));
  events.forEach((d) => si.push({ t: d.title, u: docHref(d), d: (d.folder || "").slice(0, 120), k: "推送" }));
  si.push({ t: "指南与协议", u: "guides.html", d: "签名规则、权限白名单、业务流程、直播长连与消息协议", k: "文档" });
  Object.keys(codes).forEach((c) => si.push({ t: c, u: "errors.html", d: codes[c], k: "错误码" }));
  mcp.tools.forEach((t) => si.push({ t: t.name, u: "tools.html#" + t.name, d: (t.description || "").split("\n")[0].slice(0, 120), k: "工具" }));
  mock.entries.forEach((e) => si.push({ t: e.feature, u: "mock.html", d: e.url, k: "沙盒" }));
  MD_PAGES.forEach(([, out, title, desc]) => si.push({ t: title, u: out, d: desc, k: "文档" }));
  write("assets/search-index.json", JSON.stringify(si));

  /* ======================= sitemap / robots ======================= */
  const urls = OUT_FILES.filter((f) => f.endsWith(".html") && f !== "404.html")
    .map((f) => "  <url><loc>" + SITE_URL + "/" + f + "</loc></url>")
    .join("\n");
  write("sitemap.xml", '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + "\n</urlset>\n");
  write("robots.txt", "User-agent: *\nAllow: /\n\nSitemap: " + SITE_URL + "/sitemap.xml\n");

  /* ======================= 汇总 ======================= */
  const total = OUT_FILES.reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
  console.log("===== 站点已生成 → docs/ =====");
  console.log("页面       : " + OUT_FILES.filter((f) => f.endsWith(".html")).length + " 个 HTML");
  console.log("  列表页   : " + OUT_FILES.filter((f) => /^[^/]+\.html$/.test(f)).length);
  console.log("  接口详情 : " + OUT_FILES.filter((f) => f.indexOf("api/") === 0).length);
  console.log("  指南详情 : " + OUT_FILES.filter((f) => f.indexOf("guide/") === 0).length);
  console.log("  事件详情 : " + OUT_FILES.filter((f) => f.indexOf("event/") === 0).length);
  console.log("搜索索引   : " + si.length + " 条");
  console.log("MCP 工具   : " + mcp.tools.length + " 个（实取自 server.mjs）");
  console.log("接口       : " + apis.length + " 篇 / " + endpointCount + " 个端点");
  console.log("指南与协议 : " + guides.length + " 篇");
  console.log("推送事件   : " + events.length);
  console.log("错误码     : " + Object.keys(codes).length);
  console.log("沙盒接口   : " + mock.entries.length);
  console.log("总字节     : " + total.toLocaleString("en-US") + " (" + (total / 1024 / 1024).toFixed(2) + " MB)");
  console.log("本地预览   : npx --yes serve docs   然后打开 http://localhost:3000");
}

main().catch((e) => {
  console.error("构建失败:", e);
  process.exit(1);
});
