/**
 * cookies.mjs — 主站 (www.bilibili.com) Cookie 罐
 *
 * 支持三种输入：EditThisCookie 导出的数组、{name: value} 对象、"k=v; k=v" 字符串。
 * 与开放平台的 client_id/secret + access_token 是两套体系，互不通用。
 */
import fs from "node:fs";
import path from "node:path";
import { resolveSecretPath } from "./paths.mjs";

export function jarPath(explicit) {
  return resolveSecretPath(explicit, process.env.BILI_COOKIE_FILE, "cookies.json");
}

function normalize(list) {
  const entries = list
    .filter((e) => e && e.name)
    .map((e) => ({
      name: String(e.name),
      value: String(e.value ?? ""),
      domain: e.domain || ".bilibili.com",
      path: e.path || "/",
      hostOnly: !!e.hostOnly,
      secure: !!e.secure,
      httpOnly: !!e.httpOnly,
      session: !!e.session,
      ...(e.expirationDate !== undefined ? { expirationDate: e.expirationDate } : {}),
    }));
  return { entries, map: Object.fromEntries(entries.map((e) => [e.name, e.value])) };
}

export function parseCookies(input) {
  if (input == null) return { entries: [], map: {} };
  if (Array.isArray(input)) return normalize(input);
  if (typeof input === "object") {
    if (Array.isArray(input.cookies)) return parseCookies(input.cookies);
    return normalize(Object.entries(input).map(([name, value]) => ({ name, value })));
  }
  const s = String(input).trim();
  if (!s) return { entries: [], map: {} };
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      return parseCookies(JSON.parse(s));
    } catch (e) {
      throw new Error("看起来是 JSON 但解析失败: " + e.message);
    }
  }
  const entries = s
    .split(/;\s*/)
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf("=");
      return { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim(), domain: ".bilibili.com", path: "/" };
    })
    .filter((e) => e.name);
  return normalize(entries);
}

function domainOf(entry) {
  return entry.domain.startsWith(".") ? entry.domain.slice(1) : entry.domain;
}

export function domainMatches(entry, host) {
  const d = domainOf(entry);
  if (entry.hostOnly) return host === d;
  return host === d || host.endsWith("." + d);
}

/** 按 URL 生成 Cookie 头 */
export function cookieHeader(jar, url) {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return "";
  }
  return jar.entries
    .filter((e) => e.value !== "" && domainMatches(e, host))
    .map((e) => `${e.name}=${e.value}`)
    .join("; ");
}

export function mask(v, reveal = false) {
  const s = String(v ?? "");
  if (reveal) return s;
  if (s.length <= 8) return s.slice(0, 1) + "***";
  return s.slice(0, 6) + "…" + s.slice(-4) + ` [len=${s.length}]`;
}

export function loadJar(explicit) {
  const file = jarPath(explicit);
  let raw = null;
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  const jar = parseCookies(raw);
  return { ...jar, file, exists: !!raw };
}

export function saveJar(entries, explicit) {
  const file = jarPath(explicit);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const jar = normalize(entries);
  fs.writeFileSync(file, JSON.stringify(jar.entries, null, 1), "utf8");
  return { file, count: jar.entries.length };
}

/** 登录态体检：哪些关键 cookie 在、什么时候过期 */
export function jarStatus(jar, reveal = false) {
  const KEY = {
    SESSDATA: "登录凭证（必需）",
    bili_jct: "CSRF token，POST 必带",
    DedeUserID: "登录用户 uid",
    DedeUserID__ckMd5: "uid 校验",
    buvid3: "设备指纹（风控）",
    buvid4: "设备指纹（风控）",
    b_nut: "设备指纹时间戳",
    sid: "会话 id",
    bili_ticket: "风控票据（部分接口）",
  };
  const lines = [];
  const now = Math.floor(Date.now() / 1000);
  for (const [name, desc] of Object.entries(KEY)) {
    const e = jar.entries.find((x) => x.name === name);
    if (!e) {
      lines.push(`- ❌ ${name.padEnd(18)} 缺失    ${desc}`);
      continue;
    }
    let exp = "会话级";
    if (e.expirationDate) {
      const d = new Date(e.expirationDate * 1000);
      const left = e.expirationDate - now;
      exp = left <= 0 ? "已过期" : d.toISOString().slice(0, 16).replace("T", " ") + `（剩余 ${Math.round(left / 86400)} 天）`;
    }
    lines.push(`- ✅ ${name.padEnd(18)} ${mask(e.value, reveal).padEnd(28)} ${exp}    ${desc}`);
  }
  const others = jar.entries.filter((x) => !(x.name in KEY));
  lines.push("");
  lines.push(`共 ${jar.entries.length} 个 cookie，其中 ${others.length} 个与登录无关（播放器偏好、埋点等）：${others.map((x) => x.name).join(", ")}`);
  return lines.join("\n");
}
