/**
 * signer.mjs — 哔哩哔哩开放平台 2.0 请求签名 (HMAC-SHA256)
 *
 * 规则（来自 002_接口签名和状态码.md）:
 *   1. 取 6 个 x-bili-* 头，按 key 字典序拼成 "k:v"，行间用 \n，末尾不留 \n
 *   2. 用 app_secret 对该字符串做 HMAC-SHA256，hex 小写 → Authorization
 *   3. x-bili-content-md5 = md5(body)，GET / 空 body 用 md5("") = d41d8cd9...
 */
import crypto from "node:crypto";

export const EMPTY_MD5 = "d41d8cd98f00b204e9800998ecf8427e";

export function md5(s) {
  return crypto.createHash("md5").update(s ?? "", "utf8").digest("hex");
}

/** 生成待签名字符串（已按字典序排列） */
export function signingString({ clientId, contentMd5, nonce, timestamp }) {
  return [
    `x-bili-accesskeyid:${clientId}`,
    `x-bili-content-md5:${contentMd5}`,
    `x-bili-signature-method:HMAC-SHA256`,
    `x-bili-signature-nonce:${nonce}`,
    `x-bili-signature-version:2.0`,
    `x-bili-timestamp:${timestamp}`,
  ].join("\n");
}

/**
 * @param {object} o
 * @param {string} o.clientId      应用 client_id (= x-bili-accesskeyid)
 * @param {string} o.appSecret     应用 secret
 * @param {string} [o.accessToken] OAuth2 换来的 access_token
 * @param {string} [o.body]        请求体（JSON 字符串）。GET/空 body 传 "" 或省略
 * @returns {{headers:Record<string,string>, signingString:string, authorization:string, contentMd5:string, timestamp:string, nonce:string}}
 */
export function signHeaders({ clientId, appSecret, accessToken, body = "" }) {
  if (!clientId) throw new Error("missing clientId (client_id / x-bili-accesskeyid)");
  if (!appSecret) throw new Error("missing appSecret (app_secret)");

  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const contentMd5 = md5(body ?? "");
  const toSign = signingString({ clientId, contentMd5, nonce, timestamp });
  const authorization = crypto
    .createHmac("sha256", appSecret)
    .update(toSign, "utf8")
    .digest("hex");

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

  return { headers, signingString: toSign, authorization, contentMd5, timestamp, nonce };
}

/** 把请求渲染成可直接粘贴的 curl */
export function toCurl({ method = "GET", url, headers, body }) {
  const lines = [`curl --location --request ${method.toUpperCase()} '${url}'`];
  for (const [k, v] of Object.entries(headers)) lines.push(`--header '${k}: ${v}'`);
  if (body) lines.push(`--data-raw '${body}'`);
  return lines.join(" \\\n");
}