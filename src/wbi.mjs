/**
 * wbi.mjs — 主站 Web 接口的 wbi 签名（w_rid + wts）
 *
 * 2023 起，/x/space/wbi/* 、/x/polymer/* 等接口要求 wbi 签名：
 *   1. 从 /x/web-interface/nav 的 data.wbi_img 取 img_key / sub_key（URL 文件名去掉扩展名）
 *   2. 按固定重排表从 img_key+sub_key 拼出 32 位 mixin_key
 *   3. 参数按 key 字典序拼接 → 去掉 !'()* → urlencode → 末尾接 mixin_key → md5 = w_rid
 *   4. 请求带上 wts（秒级时间戳）与 w_rid
 */
import crypto from "node:crypto";
import { cookieHeader } from "./cookies.mjs";

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

let cache = { key: "", at: 0 };

export function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join("").slice(0, 32);
}

export function md5(s) {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

export function encWbi(params, imgKey, subKey) {
  const mk = mixinKey(imgKey, subKey);
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(p)
    .sort()
    .map((k) => {
      const v = String(p[k]).replace(/[!'()*]/g, "");
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join("&");
  return { query: `${query}&w_rid=${md5(query + mk)}`, mixinKey: mk, params: p };
}

/** 取 wbi 密钥；用主站 Cookie 走 /x/web-interface/nav。进程内缓存 30 分钟。 */
export async function getWbiKeys(jar, { fresh = false } = {}) {
  if (!fresh && cache.key && Date.now() - cache.at < 30 * 60 * 1000) return cache.key;
  const navUrl = "https://api.bilibili.com/x/web-interface/nav";
  const res = await fetch(navUrl, {
    headers: {
      Cookie: cookieHeader(jar, navUrl),
      "User-Agent": UA,
      Referer: "https://www.bilibili.com/",
    },
  });
  const j = await res.json().catch(() => null);
  const img = j?.data?.wbi_img?.img_url || "";
  const sub = j?.data?.wbi_img?.sub_url || "";
  const imgKey = img.slice(img.lastIndexOf("/") + 1).split(".")[0];
  const subKey = sub.slice(sub.lastIndexOf("/") + 1).split(".")[0];
  if (!imgKey || !subKey) {
    throw new Error(`取 wbi 密钥失败：nav code=${j?.code ?? "?"} ${j?.message ?? ""}（先确认 Cookie 登录态）`);
  }
  cache = { key: { imgKey, subKey }, at: Date.now() };
  return cache.key;
}

/** 判断这个路径是不是要 wbi 签名 */
export function needsWbi(pathOrUrl) {
  return /\/x\/(space\/wbi|polymer|web-interface\/wbi|player\/wbi|v2\/reply\/wbi|h5\/wbi)/.test(pathOrUrl);
}
