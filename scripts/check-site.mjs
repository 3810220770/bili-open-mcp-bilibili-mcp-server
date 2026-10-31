#!/usr/bin/env node
/**
 * check-site.mjs — docs/ 静态站点自检
 *
 * 站点是纯静态生成物，出问题基本只有一类：链接指到不存在的东西。
 * 这个脚本把 docs/ 下每个 HTML 的每条内部链接都过一遍：
 *
 *   1. 目标文件不存在            → 死链
 *   2. 目标文件在，但 #锚点不存在 → 锚点失效（点下去页面不动，看着像"回路"）
 *   3. 站内资源（css/js/json）缺失 → 引用缺失
 *   4. 未渲染的模板残留           → [object Object] / undefined / NaN
 *
 * 任一不通过 → 退出码 1，可直接挂进 CI。
 *
 * 用法：node scripts/check-site.mjs [docs目录]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(HERE, "..", "docs"));

if (!fs.existsSync(ROOT)) {
  console.error("找不到目录：" + ROOT + "\n先跑 node scripts/build-site.mjs");
  process.exit(2);
}

/* 收集 HTML 与每页的 id 集合 */
const htmlFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".html")) htmlFiles.push(p);
  }
})(ROOT);
htmlFiles.sort();

const relOf = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const ids = new Map();
const sources = new Map();
for (const f of htmlFiles) {
  const h = fs.readFileSync(f, "utf8");
  sources.set(relOf(f), h);
  const s = new Set();
  for (const m of h.matchAll(/\bid="([^"]+)"/g)) s.add(m[1]);
  ids.set(relOf(f), s);
}

/* 页面里被转义成纯文本的 <img src="…"> 模板不算链接 */
const looksLikeTemplate = (u) => /[{}<>]/.test(u);
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const dead = [];      // 目标文件不存在
const badAnchor = []; // 锚点不存在
const missing = [];   // 站内资源缺失
const junk = [];      // 模板残留
const mixed = [];     // http:// 子资源（HTTPS 站上被浏览器拦截）

for (const f of htmlFiles) {
  const rel = relOf(f);
  const dir = path.posix.dirname(rel);
  const h = sources.get(rel);

  for (const m of h.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    const url = m[1];
    if (!url || looksLikeTemplate(url)) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(url) && !url.startsWith("#")) continue;

    const [p, hash] = url.split("#");
    const target = p ? path.posix.normalize(dir === "." ? p : dir + "/" + p) : rel;

    if (p) {
      const abs = path.join(ROOT, target);
      if (!fs.existsSync(abs)) {
        (target.endsWith(".html") ? dead : missing).push(`${rel} -> ${url}`);
        continue;
      }
      if (!target.endsWith(".html")) continue; // 资源文件不查锚点
    }
    if (hash) {
      const set = ids.get(target);
      if (set && !set.has(decode(hash))) badAnchor.push(`${rel} -> ${url}`);
    }
  }

  for (const pat of [/\[object Object\]/, /\bundefined\b/, /\bNaN\b/]) {
    const hit = h.match(pat);
    if (hit) junk.push(`${rel} 含 ${hit[0]}`);
  }

  for (const m of h.matchAll(/\b(?:src|srcset|poster)="(http:\/\/[^"]+)"/g)) {
    mixed.push(`${rel} -> ${m[1].slice(0, 80)}`);
  }
}

/* ---------- 输出 ---------- */
const uniq = (a) => [...new Set(a)];
const deadU = uniq(dead);
const anchorU = uniq(badAnchor);
const missingU = uniq(missing);
const junkU = uniq(junk);
const mixedU = uniq(mixed);

const total = deadU.length + anchorU.length + missingU.length + junkU.length + mixedU.length;

console.log("站点检查  " + ROOT);
console.log("  HTML 页面 : " + htmlFiles.length);
console.log("");
console.log("  死链      : " + deadU.length);
console.log("  锚点失效  : " + anchorU.length);
console.log("  资源缺失  : " + missingU.length);
console.log("  模板残留  : " + junkU.length);
console.log("  混合内容  : " + mixedU.length);

const dump = (label, arr, n = 25) => {
  if (!arr.length) return;
  console.log("\n" + label + "：");
  arr.slice(0, n).forEach((x) => console.log("  " + x));
  if (arr.length > n) console.log("  … 另有 " + (arr.length - n) + " 条");
};
dump("死链", deadU);
dump("锚点失效", anchorU);
dump("资源缺失", missingU);
dump("模板残留", junkU);
dump("混合内容", mixedU);

if (total) {
  console.log("\n检查未通过：" + total + " 处问题");
  process.exit(1);
}
console.log("\n检查通过 ✓");
