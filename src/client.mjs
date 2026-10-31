/**
 * client.mjs — 带 2.0 签名的 HTTP 调用封装
 */
import { signHeaders, toCurl } from "./signer.mjs";
import { loadCredFile } from "./credentials.mjs";

/** 解析开放平台凭据：显式参数 → 环境变量 → secrets/open-platform.json */
export function resolveCreds(explicit = {}) {
  const f = loadCredFile().data;
  return {
    clientId: explicit.clientId || process.env.BILI_CLIENT_ID || process.env.BILI_ACCESS_KEY_ID || f.clientId || "",
    appSecret: explicit.appSecret || process.env.BILI_APP_SECRET || process.env.BILI_SECRET || f.appSecret || "",
    accessToken: explicit.accessToken || process.env.BILI_ACCESS_TOKEN || process.env.BILI_TOKEN || f.accessToken || "",
  };
}

/**
 * @param {object} o
 * @param {'GET'|'POST'|'PUT'|'DELETE'} [o.method]
 * @param {string} o.url
 * @param {Record<string,any>} [o.query]  url 参数（自动 urlencode）
 * @param {any} [o.body]                  body 参数（对象→JSON，字符串原样）
 * @param {{clientId?:string,appSecret?:string,accessToken?:string}} [o.creds]
 * @param {boolean} [o.dryRun]            只签名不发送
 */
export async function callApi({ method = "GET", url, query, body, creds = {}, dryRun = false, timeoutMs = 30000 }) {
  const m = String(method).toUpperCase();
  const u = new URL(url);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
      else u.searchParams.set(k, String(v));
    }
  }

  let bodyStr = "";
  if (m !== "GET" && m !== "HEAD") {
    if (body === undefined || body === null) bodyStr = "";
    else bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  }

  const c = resolveCreds(creds);
  const missing = !c.clientId || !c.appSecret;
  // dryRun 且没有凭据时用占位值，保证能演示签名结构
  const effective = {
    clientId: c.clientId || "YOUR_CLIENT_ID",
    appSecret: c.appSecret || "YOUR_APP_SECRET",
    accessToken: c.accessToken || (dryRun ? "YOUR_ACCESS_TOKEN" : ""),
  };
  if (missing && !dryRun) {
    throw new Error("missing credentials: set BILI_CLIENT_ID / BILI_APP_SECRET / BILI_ACCESS_TOKEN, or pass dryRun=true");
  }
  const signed = signHeaders({ ...effective, body: bodyStr });
  const init = { method: m, headers: signed.headers, signal: AbortSignal.timeout(timeoutMs) };
  if (bodyStr) init.body = bodyStr;

  const shown = {
    method: m,
    url: u.toString(),
    headers: signed.headers,
    body: bodyStr || undefined,
  };

  if (dryRun) {
    return {
      dryRun: true,
      demoCredentials: missing,
      request: shown,
      curl: toCurl({ method: m, url: u.toString(), headers: signed.headers, body: bodyStr }),
      signingString: signed.signingString,
    };
  }

  const res = await fetch(u, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }

  return {
    httpStatus: res.status,
    ok: res.ok,
    code: json?.code,
    message: json?.message,
    requestId: json?.request_id,
    data: json?.data,
    raw: json ?? text.slice(0, 8000),
    request: shown,
  };
}