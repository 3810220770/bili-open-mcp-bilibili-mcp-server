#!/usr/bin/env node
/**
 * audit.mjs — 对本仓库的数据与文档做一致性审计
 *
 * 检查项:
 *  A 文档清单完整性 (1..170 连续、文件存在)
 *  B 类型分布自洽
 *  C 接口 URL / METHOD 合法性
 *  D 参数卫生 (空名、表头泄漏、组内重复)
 *  E required 类型
 *  F scope 白名单
 *  G 原始 Markdown 有参数表但解析为空 (漏解析)
 *  H 错误码表完整性与格式
 *  I AGENTS.md 索引表 vs data/index.json
 *  J llms.txt 覆盖所有接口
 *
 * 用法: node scripts/audit.mjs [docsRoot]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, "..");
const ROOT = path.resolve(process.argv[2] ?? path.join(PKG, ".."));

const index = JSON.parse(fs.readFileSync(path.join(PKG, "data", "index.json"), "utf8"));
const status = JSON.parse(fs.readFileSync(path.join(PKG, "data", "status-codes.json"), "utf8"));
const docs = index.docs;

const problems = [];
const notes = [];
const fails = (check, msg) => problems.push(`[${check}] ${msg}`);

const HOSTS = new Set(["member.bilibili.com", "openupos.bilivideo.com", "api.bilibili.com"]);
const METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);
const SCOPES = new Set([
  "USER_INFO", "USER_DATA", "ARC_BASE", "ARC_DATA", "ATC_BASE", "ATC_DATA",
  "LIVE_ROOM_DATA", "LIVE_STREAM_DATA", "SHOP_BA_CHAT", "SHOP_STORE_INFO",
  "SHOP_COMMODITY_INFO", "SHOP_ORDER_INFO", "SHOP_LOGISTICS_INFO", "SHOP_AFTERSALES_INFO",
  "SHOP_STOCK_INFO", "SHOP_LIVE_COMMERC_DATA", "SHOP_TICKET_ORDER_DATA", "UPOWER_ORDER_DATA",
  "COURSE_ORDER_DATA", "COPYRIGHT_MUSIC_DATA",
]);
const HEADERISH = /^(参数名|名称|必传|类型|备注|字段|说明)$/;

// ---------------- A 清单完整性
{
  const nums = docs.map((d) => d.num).sort((a, b) => a - b);
  if (docs.length !== 170) fails("A", `docs 数 ${docs.length} != 170`);
  for (let i = 0; i < 170; i++) if (nums[i] !== i + 1) (fails("A", `num 序列断裂: 第 ${i} 个是 ${nums[i]}`), 0);
  const missing = docs.filter((d) => !fs.existsSync(path.join(ROOT, d.file)));
  if (missing.length) fails("A", `文件缺失: ${missing.map((d) => d.file).join(", ")}`);
  const ids = new Set(docs.map((d) => d.id));
  if (ids.size !== docs.length) fails("A", `id 重复 (${docs.length - ids.size} 个)`);
  notes.push(`A 通过: 170 篇，num 1..170 连续，文件与 id 齐备`);
}

// ---------------- B 类型分布
{
  const byType = {};
  for (const d of docs) byType[d.type] = (byType[d.type] || 0) + 1;
  const sum = Object.values(byType).reduce((a, b) => a + b, 0);
  if (sum !== docs.length) fails("B", `类型计数和 ${sum} != ${docs.length}`);
  notes.push(`B 通过: ${JSON.stringify(byType)}`);
}

// ---------------- C URL / METHOD
{
  let checked = 0;
  for (const d of docs) {
    const list = d.endpoints?.length ? d.endpoints : d.url ? [{ url: d.url, method: d.method }] : [];
    for (const e of list) {
      checked++;
      let host;
      try {
        host = new URL(e.url).host;
      } catch {
        fails("C", `#${d.num} URL 不可解析: ${e.url}`);
        continue;
      }
      if (!HOSTS.has(host)) fails("C", `#${d.num} 意外主机: ${host}`);
      if (!e.url.startsWith("https://")) fails("C", `#${d.num} 非 https: ${e.url}`);
      if (!METHODS.has(e.method)) fails("C", `#${d.num} METHOD 异常: "${e.method}" (${e.url})`);
      if (e.url.includes("](") || e.url.includes("`")) fails("C", `#${d.num} URL 含 markdown 残留: ${e.url}`);
    }
    // 文档里有 请求URL 小节，且该小节正文确实含 http(s) 链接，却没解析出来
    const raw = fs.readFileSync(path.join(ROOT, d.file), "utf8");
    if (!d.url && urlSecHasUrl(raw)) {
      fails("C", `#${d.num} ${d.file} 有请求URL小节且正文含链接，但未解析出 url (type=${d.type})`);
    }
  }
  notes.push(`C 通过: 校验 ${checked} 个端点，主机/协议/方法/残留均正常`);
}

/** 找「请求URL / 请求方式…URL」小节，看它的正文（到下一个 ## 之前）里有没有裸 http 链接 */
function urlSecHasUrl(raw) {
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{1,6}\s*.*(请求\s*URL|请求地址|接口地址|请求方式.*URL)/i.test(lines[i])) continue;
    for (let k = i + 1; k < lines.length; k++) {
      if (/^#{1,6}\s/.test(lines[k])) break;
      if (/https?:\/\/[^\s`'"<>)\]]+/.test(lines[k])) return true;
    }
  }
  return false;
}

// ---------------- D/E 参数卫生
{
  let checked = 0;
  for (const d of docs) {
    for (const [group, arr] of [
      ["urlParams", d.urlParams],
      ["bodyParams", d.bodyParams],
      ["responseParams", d.responseParams],
    ]) {
      if (!arr) continue;
      const seen = new Map();
      for (const p of arr) {
        checked++;
        if (!p.name || !p.name.trim()) fails("D", `#${d.num} ${group} 有空参数名`);
        else if (HEADERISH.test(p.name)) fails("D", `#${d.num} ${group} 表头泄漏: "${p.name}"`);
        if (p.name && p.name.includes("|")) fails("D", `#${d.num} ${group} 名称含竖线: "${p.name}"`);
        if (p.name) {
          const k = `${p.depth || 0}|${p.name}`;
          if (seen.has(k)) {
            // 同名同层级：只有类型与说明也完全相同时才算解析重复
            const prev = seen.get(k);
            if ((prev.type || "") === (p.type || "") && (prev.desc || "") === (p.desc || "")) {
              fails("D", `#${d.num} ${group} 完全重复的条目: "${p.name}"`);
            }
          } else seen.set(k, p);
        }
        if ("required" in p && typeof p.required !== "boolean") fails("E", `#${d.num} ${group}.${p.name} required=${p.required}`);
        if (p.type === undefined) notes.push(`E 提示: #${d.num} ${group}.${p.name} 无类型`);
        if (p.depth !== undefined && (typeof p.depth !== "number" || p.depth < 1)) fails("D", `#${d.num} ${group}.${p.name} depth 异常: ${p.depth}`);
      }
    }
  }
  notes.push(`D/E 通过: 校验 ${checked} 个参数对象`);
}

// ---------------- F scope
{
  for (const d of docs) for (const s of d.scopes || []) if (!SCOPES.has(s)) fails("F", `#${d.num} 未知 scope: "${s}"`);
  const withScope = docs.filter((d) => d.scopes?.length).length;
  notes.push(`F 通过: ${withScope} 篇带 scope，全部在白名单内`);
}

// ---------------- G 漏解析探测
{
  let suspects = 0;
  for (const d of docs) {
    if (d.type !== "api" && d.type !== "multi-api") continue;
    const raw = fs.readFileSync(path.join(ROOT, d.file), "utf8");
    const hasParamTable = /\|\s*参数名\s*\|/i.test(raw) || /\|\s*`?参数名`?\s*\|/i.test(raw);
    const parsed = (d.urlParams?.length || 0) + (d.bodyParams?.length || 0) + (d.responseParams?.length || 0);
    if (hasParamTable && parsed === 0) {
      fails("G", `#${d.num} ${d.file} 有参数表但一个参数都没解析出来`);
      suspects++;
    }
  }
  notes.push(`G 通过: 无「有表无参」的漏解析${suspects ? ` (${suspects} 个可疑)` : ""}`);
}

// ---------------- H 错误码
{
  const raw = fs.readFileSync(path.join(ROOT, docs.find((d) => d.num === 2).file), "utf8");
  const rows = [...raw.matchAll(/^\|\s*(\d[\d\s]*)\s*\|\s*([^|]+?)\s*\|/gm)]
    .map((m) => [m[1].replace(/\s/g, ""), m[2].replace(/\s+/g, " ").trim()])
    .filter(([k, v]) => /^\d+$/.test(k) && v && v !== "说明");
  const parsedKeys = Object.keys(status);
  if (parsedKeys.length < rows.length * 0.9) fails("H", `错误码解析 ${parsedKeys.length} < 原文 ${rows.length}`);
  for (const k of parsedKeys) if (!/^\d+$/.test(k)) fails("H", `错误码 key 非数字: "${k}"`);
  for (const [k, v] of Object.entries(status)) if (!v || v.length > 120) fails("H", `错误码 ${k} 值异常: "${v}"`);
  const orphan = rows.filter(([k]) => !status[k]);
  if (orphan.length) notes.push(`H 提示: 原文有但未收录 ${orphan.length} 条: ${orphan.slice(0, 5).map((o) => o[0]).join(",")}`);
  notes.push(`H 通过: 原文 ${rows.length} 行 → 收录 ${parsedKeys.length} 条`);
}

// ---------------- I AGENTS.md 索引表
{
  const agents = path.join(PKG, "AGENTS.md");
  if (!fs.existsSync(agents)) fails("I", "AGENTS.md 不存在");
  else {
    const md = fs.readFileSync(agents, "utf8");
    const rows = [...md.matchAll(/^\|\s*#(\d+)\s*\|\s*(GET|POST|PUT|DELETE|PATCH)\s*\|\s*`([^`]+)`/gm)];
    if (rows.length < 85) fails("I", `AGENTS.md 索引表只找到 ${rows.length} 行 (期望 ≥85)`);
    for (const [, num, method, p] of rows) {
      const d = docs.find((x) => x.num === Number(num));
      if (!d) {
        fails("I", `AGENTS.md 表里有不存在的 ref #${num}`);
        continue;
      }
      if (d.method !== method) fails("I", `#${num} METHOD 不一致: AGENTS=${method} data=${d.method}`);
      const real = d.url ? d.url.replace(/^https?:\/\/[^/]+/, "") : "";
      if (real !== p) fails("I", `#${num} PATH 不一致: AGENTS=${p} data=${real}`);
    }
    // scope 列
    const scopeRows = [...md.matchAll(/^\|\s*#(\d+)\s*\|\s*(?:GET|POST|PUT|DELETE|PATCH)\s*\|\s*`[^`]+`[^|]*\|\s*([^|\s]+)\s*\|/gm)];
    for (const [, num, s] of scopeRows) {
      const d = docs.find((x) => x.num === Number(num));
      const real = (d.scopes || ["—"]).join(",");
      if (s !== real) fails("I", `#${num} scope 不一致: AGENTS=${s} data=${real}`);
    }
    notes.push(`I 通过: AGENTS.md 索引表 ${rows.length} 行（含 scope ${scopeRows.length} 行）与 data 完全一致`);
    // 数量声明必须与数据一致
    const apiCount = docs.filter((d) => d.type === "api").length;
    const endpointCount = docs.reduce(
      (n, d) => n + (d.endpoints?.length > 1 ? d.endpoints.length : d.url && d.method ? 1 : 0),
      0
    );
    if (!md.includes(`${apiCount} 篇单接口`)) notes.push(`I 提示: AGENTS.md 未声明「${apiCount} 篇单接口」`);
    if (!md.includes(`${endpointCount} 个端点`)) notes.push(`I 提示: AGENTS.md 未声明「${endpointCount} 个端点」`);
  }
}

// ---------------- J llms.txt
{
  const ll = fs.readFileSync(path.join(PKG, "data", "llms.txt"), "utf8");
  const lines = ll.split(/\r?\n/);
  const refs = new Set([...ll.matchAll(/^\[#(\d+)\]/gm)].map((m) => Number(m[1])));
  if (refs.size !== docs.length) fails("J", `llms.txt 覆盖 ${refs.size} != ${docs.length}`);
  for (const d of docs) if (!refs.has(d.num)) fails("J", `llms.txt 缺少 #${d.num}`);
  for (const d of docs.filter((x) => x.type === "api")) {
    const hit = lines.find((l) => l.startsWith(`[#${d.num}]`));
    if (!hit || !hit.includes(d.url)) fails("J", `llms.txt #${d.num} 行内 URL 缺失`);
  }
  notes.push(`J 通过: llms.txt ${lines.length} 行，覆盖全部 170 篇且接口 URL 一致`);
}

// ---------------- K 工具清单与文档同步
{
  const serverSrc = fs.readFileSync(path.join(PKG, "src", "server.mjs"), "utf8");
  const registered = new Set([...serverSrc.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
  const readme = fs.readFileSync(path.join(PKG, "README.md"), "utf8");
  const inReadme = new Set([...readme.matchAll(/^\|\s*`(bili_[a-z_]+)`\s*\|/gm)].map((m) => m[1]));
  const agents2 = fs.readFileSync(path.join(PKG, "AGENTS.md"), "utf8");
  const inAgents = new Set([...agents2.matchAll(/^###\s*`(bili_[a-z_]+)`/gm)].map((m) => m[1]));

  if (registered.size < 19) fails("K", `注册的工具只有 ${registered.size} 个`);
  for (const n of registered) {
    if (!inReadme.has(n)) fails("K", `README 工具表缺少 ${n}`);
    if (!inAgents.has(n)) fails("K", `AGENTS.md 工具章节缺少 ${n}`);
  }
  for (const n of inReadme) if (!registered.has(n)) fails("K", `README 列了未注册的工具 ${n}`);
  for (const n of inAgents) if (!registered.has(n)) fails("K", `AGENTS.md 列了未注册的工具 ${n}`);

  // 资源与提示也要提到
  const resUris = [...serverSrc.matchAll(/registerResource\(\s*"[^"]+",\s*(?:"([^"]+)"|new ResourceTemplate\(\s*"([^"]+)")/g)].map(
    (m) => m[1] || m[2]
  );
  for (const u of resUris) if (!readme.includes(u)) fails("K", `README 未提到资源 ${u}`);

  notes.push(
    `K 通过: 工具 ${registered.size} 个（README ${inReadme.size} / AGENTS ${inAgents.size}），资源 ${resUris.length} 个，三者一致`
  );
}

// ---------------- 输出
console.log(notes.map((n) => "  " + n).join("\n"));
console.log("");
if (problems.length) {
  console.log(`发现问题 ${problems.length} 条:`);
  for (const p of problems.slice(0, 80)) console.log("  ✗ " + p);
  if (problems.length > 80) console.log(`  … 其余 ${problems.length - 80} 条省略`);
  process.exitCode = 1;
} else {
  console.log("AUDIT PASSED — 11 类检查全部通过");
}
