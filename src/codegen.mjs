/**
 * codegen.mjs — 从结构化接口规格生成可运行代码骨架
 *
 * 生成物包含：完整签名实现 + 该接口的参数骨架 + 返回处理。
 * 参数值以 TODO 占位，必填项直接写进去，可选项注释掉。
 */
import { EMPTY_MD5 } from "./signer.mjs";

/** GET/DELETE 却把参数列在 body 参数下的情况，按 query 处理 */
export function effectiveParams(doc) {
  const method = (doc.method || "GET").toUpperCase();
  const query = [...(doc.urlParams || [])];
  const body = [];
  const getLike = method === "GET" || method === "DELETE";
  for (const p of doc.bodyParams || []) (getLike ? query : body).push(p);
  return { query, body, getLike };
}

export function sampleValue(p) {
  const t = String(p.type || "string").toLowerCase();
  if (/^\[\]|\[\]$|^array|^list|^set/.test(t)) return [];
  if (/bool/.test(t)) return false;
  if (/int|long|float|double|number|uint|short|byte|decimal/.test(t)) return 0;
  if (/map|dict|object|struct/.test(t)) return {};
  return "";
}

const pyLit = (v) => {
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null) return "None";
  return JSON.stringify(v, null, 0).replace(/\btrue\b/g, "True").replace(/\bfalse\b/g, "False");
};

const placeholder = (p, lang) => {
  const v = sampleValue(p);
  const todo = `TODO ${p.type || "value"}: ${(p.desc || "").slice(0, 40)}`.trim();
  if (typeof v === "string") return JSON.stringify(todo);
  if (lang === "python" && typeof v === "boolean") return v ? "True" : "False";
  return JSON.stringify(v);
};

const pyDict = (arr, indent) => {
  const pad = " ".repeat(indent);
  return arr.length
    ? "{\n" +
        arr
          .map((p) => {
            const line = `${pad}    ${JSON.stringify(p.name)}: ${placeholder(p, "python")},`;
            return p.required === false
              ? `${pad}    # 可选 ${p.type || ""} — ${(p.desc || "").slice(0, 50)}\n${pad}    # ${line.trim()}`
              : `${line}  # ${p.type || ""}${p.required ? " 必填" : ""} ${(p.desc || "").slice(0, 50)}`;
          })
          .join("\n") +
        "\n" +
        pad +
        "}"
    : "{}";
};

const jsDict = (arr, indent) => {
  const pad = " ".repeat(indent);
  if (!arr.length) return "{}";
  return (
    "{\n" +
    arr
      .map((p) => {
        const name = /^[A-Za-z_$][\w$]*$/.test(p.name) ? p.name : JSON.stringify(p.name);
        const line = `${pad}    ${name}: ${placeholder(p, "js")},`;
        return p.required === false
          ? `${pad}    // 可选 ${p.type || ""} — ${(p.desc || "").slice(0, 50)}\n${pad}    // ${line.trim()}`
          : `${line} // ${p.type || ""}${p.required ? " 必填" : ""} ${(p.desc || "").slice(0, 50)}`;
      })
      .join("\n") +
    "\n" +
    pad +
    "}"
  );
};

const header = (doc, lang) =>
  [
    `接口: ${doc.title}  (doc #${doc.num})`,
    `${doc.method || "?"} ${doc.url}`,
    doc.scopes?.length ? `scope: ${doc.scopes.join(", ")}` : "",
    doc.signVersion ? `注意: 文档标注签名版本 ${doc.signVersion}，本模板按 2.0 生成` : "",
    "由 bili-open-mcp 生成；TODO 处需填真实值，未执行的步骤请自行补齐",
  ]
    .filter(Boolean)
    .join("\n");

// ------------------------------------------------------------------ python
export function genPython(doc) {
  const { query, body, getLike } = effectiveParams(doc);
  const urlObj = new URL(doc.url);
  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
${header(doc, "python")}
"""
import hashlib
import hmac
import json
import os
import time
import urllib.parse
import urllib.request
import uuid

CLIENT_ID = os.environ.get("BILI_CLIENT_ID", "YOUR_CLIENT_ID")
APP_SECRET = os.environ.get("BILI_APP_SECRET", "YOUR_APP_SECRET")
ACCESS_TOKEN = os.environ.get("BILI_ACCESS_TOKEN", "YOUR_ACCESS_TOKEN")

URL = ${JSON.stringify(doc.url)}${
    getLike && body.length ? "\n# 注意: 文档把参数列在 body 参数下，但方法是 " + doc.method + " —— 这里按 query 传" : ""
  }


def sign_headers(client_id, app_secret, access_token, body_bytes=b""):
    ts = str(int(time.time()))
    nonce = str(uuid.uuid4())
    content_md5 = hashlib.md5(body_bytes or b"").hexdigest()
    pairs = [
        ("x-bili-accesskeyid", client_id),
        ("x-bili-content-md5", content_md5),
        ("x-bili-signature-method", "HMAC-SHA256"),
        ("x-bili-signature-nonce", nonce),
        ("x-bili-signature-version", "2.0"),
        ("x-bili-timestamp", ts),
    ]
    to_sign = "\\n".join(f"{k}:{v}" for k, v in sorted(pairs))
    auth = hmac.new(app_secret.encode(), to_sign.encode(), hashlib.sha256).hexdigest()
    h = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": auth,
        "X-Bili-Accesskeyid": client_id,
        "X-Bili-Content-Md5": content_md5,
        "X-Bili-Signature-Method": "HMAC-SHA256",
        "X-Bili-Signature-Nonce": nonce,
        "X-Bili-Signature-Version": "2.0",
        "X-Bili-Timestamp": ts,
    }
    if access_token:
        h["Access-Token"] = access_token
    return h


def call(method, url, query=None, body=None):
    if query:
        sep = "&" if "?" in url else "?"
        url = url + sep + urllib.parse.urlencode(
            {k: v for k, v in query.items() if v is not None}
        )
    payload = b""
    if body is not None and method.upper() not in ("GET", "HEAD"):
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    headers = sign_headers(CLIENT_ID, APP_SECRET, ACCESS_TOKEN, payload)
    req = urllib.request.Request(url, data=payload or None, headers=headers, method=method.upper())
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    query = ${pyDict(query, 4)}
    body = ${pyDict(body, 4)}

    resp = call(${JSON.stringify(doc.method || "GET")}, URL, query=query, body=body)
    if resp.get("code") != 0:           # HTTP 200 也可能是业务错误
        raise SystemExit(f"接口失败: code={resp.get('code')} message={resp.get('message')} request_id={resp.get('request_id')}")
    print(json.dumps(resp.get("data"), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()`;
}

// ------------------------------------------------------------------ node
export function genNode(doc) {
  const { query, body, getLike } = effectiveParams(doc);
  return `#!/usr/bin/env node
/**
 * ${header(doc, "node")}
 */
import crypto from "node:crypto";

const CLIENT_ID = process.env.BILI_CLIENT_ID || "YOUR_CLIENT_ID";
const APP_SECRET = process.env.BILI_APP_SECRET || "YOUR_APP_SECRET";
const ACCESS_TOKEN = process.env.BILI_ACCESS_TOKEN || "YOUR_ACCESS_TOKEN";

const URL_ = ${JSON.stringify(doc.url)};${
    getLike && body.length
      ? `\n// 注意: 文档把参数列在 body 参数下，但方法是 ${doc.method} —— 这里按 query 传`
      : ""
  }

function signHeaders({ clientId, appSecret, accessToken, body = "" }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const contentMd5 = crypto.createHash("md5").update(body, "utf8").digest("hex");
  const toSign = [
    "x-bili-accesskeyid:" + clientId,
    "x-bili-content-md5:" + contentMd5,
    "x-bili-signature-method:HMAC-SHA256",
    "x-bili-signature-nonce:" + nonce,
    "x-bili-signature-version:2.0",
    "x-bili-timestamp:" + timestamp,
  ].join("\\n");
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
  return headers;
}

export async function invoke({ query = {}, body } = {}) {
  const url = new URL(URL_);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

  const method = ${JSON.stringify((doc.method || "GET").toUpperCase())};
  const bodyStr = method === "GET" || body === undefined ? "" : JSON.stringify(body);
  const headers = signHeaders({ clientId: CLIENT_ID, appSecret: APP_SECRET, accessToken: ACCESS_TOKEN, body: bodyStr });

  const res = await fetch(url, { method, headers, body: bodyStr || undefined });
  const json = await res.json();
  if (json.code !== 0) throw new Error("接口失败: code=" + json.code + " message=" + json.message);
  return json.data;
}

const query = ${jsDict(query, 2)};
const body = ${jsDict(body, 2)};

invoke({ query${body.length ? ", body" : ""} }).then((data) => console.log(JSON.stringify(data, null, 2)));`;
}

// ------------------------------------------------------------------ bash + curl
export function genCurl(doc) {
  const { query, body, getLike } = effectiveParams(doc);
  const q = query
    .map((p) => `${p.name}=${p.required ? "TODO_" + p.name : ""}`)
    .filter(Boolean);
  const urlWithQuery = q.length ? `${doc.url}?${q.join("&")}` : doc.url;
  const bodyObj = {};
  if (!getLike) for (const p of body) bodyObj[p.name] = p.required ? "TODO" : "";
  return `#!/usr/bin/env bash
# ${header(doc, "bash").split("\n").join("\n# ")}
set -euo pipefail

CID="\${BILI_CLIENT_ID:?set BILI_CLIENT_ID}"
SEC="\${BILI_APP_SECRET:?set BILI_APP_SECRET}"
TOK="\${BILI_ACCESS_TOKEN:-}"

URL='${urlWithQuery}'
BODY='${JSON.stringify(bodyObj)}'

TS=$(date +%s)
NONCE=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
MD5=$(printf '%s' "$BODY" | md5sum | cut -d' ' -f1)

TO_SIGN=$(printf 'x-bili-accesskeyid:%s\\nx-bili-content-md5:%s\\nx-bili-signature-method:HMAC-SHA256\\nx-bili-signature-nonce:%s\\nx-bili-signature-version:2.0\\nx-bili-timestamp:%s' \\
  "$CID" "$MD5" "$NONCE" "$TS")
AUTH=$(printf '%s' "$TO_SIGN" | openssl dgst -sha256 -hmac "$SEC" -hex | awk '{print $NF}')

curl --location --request ${(doc.method || "GET").toUpperCase()} "$URL" \\
  --header 'Accept: application/json' \\
  --header 'Content-Type: application/json' \\
  --header "Authorization: $AUTH" \\
  --header "x-bili-accesskeyid: $CID" \\
  --header "x-bili-content-md5: $MD5" \\
  --header 'x-bili-signature-method: HMAC-SHA256' \\
  --header "x-bili-signature-nonce: $NONCE" \\
  --header 'x-bili-signature-version: 2.0' \\
  --header "x-bili-timestamp: $TS" \\
  \${TOK:+--header "access-token: $TOK"} \\
  ${body.length && !getLike ? "--data-raw \"$BODY\"" : ""}`;
}

// ------------------------------------------------------------------ java
export function genJava(doc) {
  const { query, body } = effectiveParams(doc);
  const cls = "Api" + doc.num;
  return `// ${header(doc, "java").split("\n").join("\n// ")}
// JDK 11+，只用 java.net.http 与 javax.crypto，无第三方依赖
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

public class ${cls} {
    static final String URL = ${JSON.stringify(doc.url)};
    static final String METHOD = ${JSON.stringify((doc.method || "GET").toUpperCase())};
${query.map((p) => `    static final String ${p.name.toUpperCase()} = ${JSON.stringify("TODO " + (p.desc || p.name))};`).join("\n")}
${body.map((p) => `    static final String ${p.name.toUpperCase()} = ${JSON.stringify("TODO " + (p.desc || p.name))};`).join("\n")}

    static String md5(byte[] b) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (byte x : MessageDigest.getInstance("MD5").digest(b)) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    static String hmacSha256(String secret, String data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        StringBuilder sb = new StringBuilder();
        for (byte x : mac.doFinal(data.getBytes(StandardCharsets.UTF_8))) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    public static void main(String[] args) throws Exception {
        String clientId = System.getenv().getOrDefault("BILI_CLIENT_ID", "YOUR_CLIENT_ID");
        String secret = System.getenv().getOrDefault("BILI_APP_SECRET", "YOUR_APP_SECRET");
        String token = System.getenv().getOrDefault("BILI_ACCESS_TOKEN", "");

        String json = ${JSON.stringify(JSON.stringify(Object.fromEntries(body.map((p) => [p.name, "TODO"]))))};
        String timestamp = String.valueOf(Instant.now().getEpochSecond());
        String nonce = UUID.randomUUID().toString();
        String contentMd5 = md5(json.getBytes(StandardCharsets.UTF_8));

        String toSign = String.join("\\n",
            "x-bili-accesskeyid:" + clientId,
            "x-bili-content-md5:" + contentMd5,
            "x-bili-signature-method:HMAC-SHA256",
            "x-bili-signature-nonce:" + nonce,
            "x-bili-signature-version:2.0",
            "x-bili-timestamp:" + timestamp);

        // TODO: 把 query 参数按 urlencode 拼到 URL 后面
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(URL))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("Authorization", hmacSha256(secret, toSign))
            .header("x-bili-accesskeyid", clientId)
            .header("x-bili-content-md5", contentMd5)
            .header("x-bili-signature-method", "HMAC-SHA256")
            .header("x-bili-signature-nonce", nonce)
            .header("x-bili-signature-version", "2.0")
            .header("x-bili-timestamp", timestamp);
        if (!token.isEmpty()) b.header("access-token", token);

        HttpResponse<String> resp = HttpClient.newHttpClient().send(
            b.method(METHOD, HttpRequest.BodyPublishers.ofString("")).build(),
            HttpResponse.BodyHandlers.ofString());
        System.out.println(resp.body());
    }
}`;
}

// ------------------------------------------------------------------ php
export function genPhp(doc) {
  const { query, body, getLike } = effectiveParams(doc);
  const bodyObj = Object.fromEntries(body.map((p) => [p.name, p.required ? "TODO" : ""]));
  return `<?php
// ${header(doc, "php").split("\n").join("\n// ")}

$clientId = getenv('BILI_CLIENT_ID') ?: 'YOUR_CLIENT_ID';
$secret   = getenv('BILI_APP_SECRET') ?: 'YOUR_APP_SECRET';
$token    = getenv('BILI_ACCESS_TOKEN') ?: '';

$url = ${JSON.stringify(doc.url)}${
    query.length ? " . '?' . http_build_query(" + JSON.stringify(Object.fromEntries(query.map((p) => [p.name, "TODO"]))) + ")" : ""
  };
$body = json_encode(${JSON.stringify(bodyObj)}, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

$ts    = (string) time();
$nonce = bin2hex(random_bytes(16));
$md5   = md5($body);

$toSign = implode("\\n", [
    'x-bili-accesskeyid:' . $clientId,
    'x-bili-content-md5:' . $md5,
    'x-bili-signature-method:HMAC-SHA256',
    'x-bili-signature-nonce:' . $nonce,
    'x-bili-signature-version:2.0',
    'x-bili-timestamp:' . $ts,
]);
$auth = hash_hmac('sha256', $toSign, $secret);

$headers = [
    'Accept: application/json',
    'Content-Type: application/json',
    'Authorization: ' . $auth,
    'x-bili-accesskeyid: ' . $clientId,
    'x-bili-content-md5: ' . $md5,
    'x-bili-signature-method: HMAC-SHA256',
    'x-bili-signature-nonce: ' . $nonce,
    'x-bili-signature-version: 2.0',
    'x-bili-timestamp: ' . $ts,
];
if ($token) $headers[] = 'access-token: ' . $token;

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST => ${JSON.stringify((doc.method || "GET").toUpperCase())},
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_RETURNTRANSFER => true,
    ${body.length && !getLike ? "CURLOPT_POSTFIELDS => $body," : ""}
]);
$resp = json_decode(curl_exec($ch), true);
if (($resp['code'] ?? -1) !== 0) {
    fwrite(STDERR, "接口失败: " . json_encode($resp, JSON_UNESCAPED_UNICODE) . PHP_EOL);
    exit(1);
}
echo json_encode($resp['data'], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), PHP_EOL;`;
}

// ------------------------------------------------------------------ go
export function genGo(doc) {
  const { body } = effectiveParams(doc);
  const bodyObj = Object.fromEntries(body.map((p) => [p.name, p.required ? "TODO" : ""]));
  return `// ${header(doc, "go").split("\n").join("\n// ")}
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

const apiURL = ${JSON.stringify(doc.url)}
const method = ${JSON.stringify((doc.method || "GET").toUpperCase())}

func sign(clientID, secret, nonce, ts, contentMD5 string) string {
	pairs := []string{
		"x-bili-accesskeyid:" + clientID,
		"x-bili-content-md5:" + contentMD5,
		"x-bili-signature-method:HMAC-SHA256",
		"x-bili-signature-nonce:" + nonce,
		"x-bili-signature-version:2.0",
		"x-bili-timestamp:" + ts,
	}
	sort.Strings(pairs)
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(strings.Join(pairs, "\\n")))
	return hex.EncodeToString(m.Sum(nil))
}

func main() {
	clientID := os.Getenv("BILI_CLIENT_ID")
	secret := os.Getenv("BILI_APP_SECRET")
	token := os.Getenv("BILI_ACCESS_TOKEN")

	body := map[string]any${JSON.stringify(bodyObj)}
	bodyBytes, _ := json.Marshal(body)

	sum := md5.Sum(bodyBytes)
	contentMD5 := hex.EncodeToString(sum[:])
	ts := fmt.Sprintf("%d", time.Now().Unix())
	nonce := uuid.NewString()

	req, _ := http.NewRequest(method, apiURL, bytes.NewReader(bodyBytes))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", sign(clientID, secret, nonce, ts, contentMD5))
	req.Header.Set("x-bili-accesskeyid", clientID)
	req.Header.Set("x-bili-content-md5", contentMD5)
	req.Header.Set("x-bili-signature-method", "HMAC-SHA256")
	req.Header.Set("x-bili-signature-nonce", nonce)
	req.Header.Set("x-bili-signature-version", "2.0")
	req.Header.Set("x-bili-timestamp", ts)
	if token != "" {
		req.Header.Set("access-token", token)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	fmt.Println(string(out))
}`;
}

// ------------------------------------------------------------------ webhook 验签
export function genWebhookVerifier(lang = "python") {
  if (lang === "node") {
    return `// 开放平台 Webhook 验签 + 地址校验（Node，零依赖，直接挂到 http server 上）
import crypto from "node:crypto";

const APP_SECRET = process.env.BILI_APP_SECRET || "YOUR_APP_SECRET";
const seen = new Set(); // 生产环境请换成 Redis/DB，按 request_id + event 去重

export function verify(rawBody, signature) {
  const expect = crypto.createHash("sha1").update(APP_SECRET + rawBody, "utf8").digest("hex");
  return { ok: expect === signature, expect, got: signature };
}

export function handle(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8"); // 必须用原始字节算签名，不要重新序列化
    const { ok } = verify(raw, req.headers["x-bilibili-signature"] || "");
    if (!ok) {
      res.writeHead(401).end();
      return;
    }
    const msg = JSON.parse(raw);
    const key = msg.event + ":" + JSON.stringify(msg.content);
    if (seen.has(key)) {
      res.writeHead(200).end(JSON.stringify({ data: msg.content?.data })); // 幂等：重复消息直接 2xx
      return;
    }
    seen.add(key);

    if (msg.event === "verify_webhooks") {
      // 地址校验：原样回 data
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: msg.content.data }));
      return;
    }

    // TODO: 在这里分发业务事件
    console.log("[event]", msg.event, JSON.stringify(msg.content));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: msg.content?.data }));
  });
}`;
  }
  return `# 开放平台 Webhook 验签 + 地址校验（Python，零依赖）
import hashlib
import hmac
import json
import os

APP_SECRET = os.environ.get("BILI_APP_SECRET", "YOUR_APP_SECRET")
_seen = set()  # 生产环境换成 Redis/DB，按 event + content 去重


def verify(raw_body: bytes, signature: str) -> bool:
    """signature 取自请求头 x-bilibili-signature"""
    expect = hashlib.sha1(APP_SECRET.encode() + raw_body).hexdigest()
    return hmac.compare_digest(expect, signature or "")


def handle(raw_body: bytes, signature: str):
    # raw_body 必须是收到的**原始字节**：字段顺序变了签名就对不上
    if not verify(raw_body, signature):
        return 401, {}

    msg = json.loads(raw_body)
    key = (msg.get("event"), json.dumps(msg.get("content"), sort_keys=True))
    if key in _seen:
        return 200, {"data": (msg.get("content") or {}).get("data")}  # 幂等
    _seen.add(key)

    if msg.get("event") == "verify_webhooks":
        return 200, {"data": msg["content"]["data"]}      # 地址校验：原样回 data

    # TODO: 业务事件分发
    print("[event]", msg.get("event"), msg.get("content"))
    return 200, {"data": (msg.get("content") or {}).get("data")}


if __name__ == "__main__":
    # 自测
    body = b'{"event":"verify_webhooks","content":{"data":1371848576},"timestamp":"2021-01-01 12:01:01"}'
    sig = hashlib.sha1(APP_SECRET.encode() + body).hexdigest()
    print(handle(body, sig))
`;
}

// ------------------------------------------------------------------ 直播长连
export function genWsClient() {
  return `# 直播间长连客户端（Python，需要 websockets）
# 协议见 bili_ws_protocol；本文件与 examples/live_ws.py 等价，内联版便于直接改
import asyncio
import json
import struct
import zlib

import websockets

from bili_open import MEMBER_HOST, call  # 或用 requests 自己发 ws-start

OP_HEARTBEAT, OP_HEARTBEAT_REPLY, OP_SEND_SMS_REPLY, OP_AUTH, OP_AUTH_REPLY = 2, 3, 5, 7, 8
HDR = struct.Struct(">IHHII")  # len, headerLen, version, op, seq


def pack(op: int, body: bytes = b"", version: int = 1, seq: int = 1) -> bytes:
    return HDR.pack(HDR.size + len(body), HDR.size, version, op, seq) + body


def unpack(buf: bytes):
    """返回 [(op, body, version)]；version=2 先 zlib 解压再递归"""
    out, off = [], 0
    while off + HDR.size <= len(buf):
        plen, hlen, ver, op, seq = HDR.unpack_from(buf, off)
        if plen < hlen or off + plen > len(buf):
            break
        body = buf[off + hlen:off + plen]
        off += plen
        if ver == 2:
            try:
                out.extend(unpack(zlib.decompress(body)))
                continue
            except zlib.error:
                pass
        out.append((op, body, ver))
    return out


async def run():
    r = call("POST", MEMBER_HOST + "/arcopen/fn/live/room/ws-start")
    if r.get("code") != 0:
        raise SystemExit(r)
    info = r["data"]
    links = info["websocket_info"]["wss_link"]
    auth_body = info["websocket_info"]["auth_body"]

    async with websockets.connect(links[0], max_size=None) as ws:
        await ws.send(pack(OP_AUTH, auth_body.encode()))
        hb = asyncio.create_task(_heartbeat(ws))
        try:
            async for frame in ws:
                if isinstance(frame, str):
                    continue
                for op, body, ver in unpack(frame):
                    if op == OP_AUTH_REPLY:
                        print("[auth]", body[:200])
                    elif op == OP_SEND_SMS_REPLY:
                        print("[msg]", json.loads(body.decode("utf-8", "replace")))
        finally:
            hb.cancel()


async def _heartbeat(ws):
    while True:
        await asyncio.sleep(30)
        await ws.send(pack(OP_HEARTBEAT))


if __name__ == "__main__":
    asyncio.run(run())
`;
}

export const GENERATORS = {
  python: genPython,
  node: genNode,
  curl: genCurl,
  bash: genCurl,
  java: genJava,
  php: genPhp,
  go: genGo,
};

export const LANGS = Object.keys(GENERATORS);
export { EMPTY_MD5 };
