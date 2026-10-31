#!/usr/bin/env node
/**
 * node_client.mjs — 哔哩哔哩开放平台 Node 客户端示例（零依赖，Node >= 18）
 *
 * 运行:  node examples/node_client.mjs sign
 *        node examples/node_client.mjs info        (需要环境变量凭据)
 */
import crypto from "node:crypto";

const MEMBER = "https://member.bilibili.com";
const OAUTH = "https://api.bilibili.com";
export const EMPTY_MD5 = "d41d8cd98f00b204e9800998ecf8427e";

export function signHeaders({ clientId, appSecret, accessToken, body = "" }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const contentMd5 = crypto.createHash("md5").update(body, "utf8").digest("hex");
  const toSign = [
    `x-bili-accesskeyid:${clientId}`,
    `x-bili-content-md5:${contentMd5}`,
    `x-bili-signature-method:HMAC-SHA256`,
    `x-bili-signature-nonce:${nonce}`,
    `x-bili-signature-version:2.0`,
    `x-bili-timestamp:${timestamp}`,
  ].join("\n");
  const authorization = crypto.createHmac("sha256", appSecret).update(toSign, "utf8").digest("hex");

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: authorization,
    "X-Bili-Accesskeyid": clientId,
    "X-Bili-Content-Md5": contentMd5,
    "X-Bili-Signature-Method": "HMAC-SHA256",
    "X-Bili-Signature-Nonce": nonce,
    "X-Bili-Signature-Version": "2.0",
    "X-Bili-Timestamp": timestamp,
  };
  if (accessToken) headers["Access-Token"] = accessToken;
  return { headers, toSign, authorization, contentMd5 };
}

export async function callApi({ method = "GET", url, query, body, clientId, appSecret, accessToken }) {
  const cid = clientId || process.env.BILI_CLIENT_ID || "";
  const sec = appSecret || process.env.BILI_APP_SECRET || "";
  const tok = accessToken || process.env.BILI_ACCESS_TOKEN || "";

  const u = new URL(url);
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));

  const bodyStr = method.toUpperCase() === "GET" || body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const { headers } = signHeaders({ clientId: cid, appSecret: sec, accessToken: tok, body: bodyStr });

  const res = await fetch(u, { method, headers, body: bodyStr || undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { http: res.status, json: json ?? text };
}

// ------------------------------------------------------------------ CLI
if (process.argv[1] && process.argv[1].endsWith("node_client.mjs")) {
  const cmd = process.argv[2] || "sign";
  if (cmd === "sign") {
    const cid = process.env.BILI_CLIENT_ID || "YOUR_CLIENT_ID";
    const sec = process.env.BILI_APP_SECRET || "YOUR_APP_SECRET";
    const tok = process.env.BILI_ACCESS_TOKEN || "YOUR_ACCESS_TOKEN";
    const body = JSON.stringify({ title: "demo" });
    const s = signHeaders({ clientId: cid, appSecret: sec, accessToken: tok, body });
    console.log("待签名串:\n" + s.toSign);
    console.log("\nheaders:");
    for (const [k, v] of Object.entries(s.headers)) console.log(`  ${k}: ${v}`);
  } else if (cmd === "info") {
    const r = await callApi({ method: "GET", url: MEMBER + "/arcopen/fn/user/account/info" });
    console.log(JSON.stringify(r, null, 2));
  }
}