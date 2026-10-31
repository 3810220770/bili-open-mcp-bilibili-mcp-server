#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bili_open.py — 哔哩哔哩开放平台最小可用客户端（零第三方依赖）

包含:
  - 2.0 签名 (HMAC-SHA256)
  - 统一请求封装 (JSON body / 裸二进制 / multipart)
  - 视频稿件上传全流程辅助 (init → part upload → complete)
  - OAuth2 code 换 token / refresh_token

凭据来自环境变量:
  BILI_CLIENT_ID      client_id           (即 x-bili-accesskeyid)
  BILI_APP_SECRET     app_secret
  BILI_ACCESS_TOKEN   OAuth2 access_token
"""
import hashlib
import hmac
import json
import os
import time
import uuid
import urllib.parse
import urllib.request
import urllib.error

MEMBER_HOST = "https://member.bilibili.com"
OAUTH_HOST = "https://api.bilibili.com"
UPLOAD_HOST = "https://openupos.bilivideo.com"
EMPTY_MD5 = "d41d8cd98f00b204e9800998ecf8427e"


# ------------------------------------------------------------------ 签名
def sign_headers(client_id: str, app_secret: str, access_token: str = None, body: bytes = b"") -> dict:
    """生成 2.0 签名头。body 必须是最终发出的字节内容。"""
    ts = str(int(time.time()))
    nonce = str(uuid.uuid4())
    content_md5 = hashlib.md5(body or b"").hexdigest()
    pairs = [
        ("x-bili-accesskeyid", client_id),
        ("x-bili-content-md5", content_md5),
        ("x-bili-signature-method", "HMAC-SHA256"),
        ("x-bili-signature-nonce", nonce),
        ("x-bili-signature-version", "2.0"),
        ("x-bili-timestamp", ts),
    ]
    to_sign = "\n".join(f"{k}:{v}" for k, v in sorted(pairs))
    auth = hmac.new(app_secret.encode(), to_sign.encode(), hashlib.sha256).hexdigest()
    headers = {
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
        headers["Access-Token"] = access_token
    return headers


def _creds(client_id=None, app_secret=None, access_token=None):
    return (
        client_id or os.getenv("BILI_CLIENT_ID", ""),
        app_secret or os.getenv("BILI_APP_SECRET", ""),
        access_token or os.getenv("BILI_ACCESS_TOKEN", ""),
    )


# ------------------------------------------------------------------ 请求
def call(method, url, query=None, body=None, *, client_id=None, app_secret=None,
         access_token=None, raw=None, timeout=30):
    """
    method: GET/POST/...
    query:  dict → urlencode
    body:   dict/list → JSON; str → 原样
    raw:    bytes → 直接作为请求体（不做 JSON 序列化, 用于分片上传）
    返回:   dict (接口 JSON)，非 JSON 响应返回 {"_raw": text}
    """
    client_id, app_secret, access_token = _creds(client_id, app_secret, access_token)

    if query:
        sep = "&" if "?" in url else "?"
        url = url + sep + urllib.parse.urlencode(query)

    payload = b""
    if raw is not None:
        payload = raw
    elif body is not None:
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    headers = sign_headers(client_id, app_secret, access_token, payload if method.upper() != "GET" else b"")
    if raw is not None:
        headers["Content-Type"] = "application/octet-stream"

    req = urllib.request.Request(url, data=payload or None, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read().decode("utf-8", "replace")
            status = r.status
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        status = e.code

    try:
        data = json.loads(text)
        data.setdefault("_http", status)
        return data
    except json.JSONDecodeError:
        return {"_http": status, "_raw": text[:4000]}


def multipart(field_name, filename, content: bytes, boundary=None):
    """构造 multipart/form-data，返回 (body_bytes, content_type)"""
    boundary = boundary or "----bili" + uuid.uuid4().hex
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    return head + content + tail, f"multipart/form-data; boundary={boundary}"


def call_multipart(url, field_name, filename, content, **kw):
    """带签名上传文件（如封面上传）。"""
    body, ctype = multipart(field_name, filename, content)
    client_id, app_secret, access_token = _creds(kw.get("client_id"), kw.get("app_secret"), kw.get("access_token"))
    headers = sign_headers(client_id, app_secret, access_token, body)
    headers["Content-Type"] = ctype
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


# ------------------------------------------------------------------ OAuth2
def oauth_token(code, client_id=None, client_secret=None):
    """授权码换 access_token。POST form-urlencoded 到 api.bilibili.com。"""
    client_id, app_secret, _ = _creds(client_id, client_secret)
    form = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": app_secret,
        "grant_type": "authorization_code",
        "code": code,
    }).encode()
    req = urllib.request.Request(
        OAUTH_HOST + "/x/account-oauth2/v1/token",
        data=form,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def oauth_refresh(refresh_token, client_id=None, client_secret=None):
    client_id, app_secret, _ = _creds(client_id, client_secret)
    form = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": app_secret,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }).encode()
    req = urllib.request.Request(
        OAUTH_HOST + "/x/account-oauth2/v1/refresh_token",
        data=form,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


# ------------------------------------------------------------------ 业务封装
def get_user_info(**kw):
    return call("GET", MEMBER_HOST + "/arcopen/fn/user/account/info", **kw)


def get_scopes(**kw):
    return call("GET", MEMBER_HOST + "/arcopen/fn/user/account/scopes", **kw)


def video_init(filename, utype="0", **kw):
    """文件上传预处理 → upload_token"""
    return call("POST", MEMBER_HOST + "/arcopen/fn/archive/video/init",
                body={"name": filename, "utype": str(utype)}, **kw)


def upload_part(upload_token, part_number, chunk: bytes):
    """分片上传：裸二进制，凭 url 上的 upload_token 鉴权，无需签名头"""
    url = f"{UPLOAD_HOST}/video/v2/part/upload?upload_token={urllib.parse.quote(upload_token)}&part_number={part_number}"
    req = urllib.request.Request(url, data=chunk, headers={"Content-Type": "application/octet-stream"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def upload_single(upload_token, content: bytes):
    """小文件（<100M）单请求上传"""
    url = f"{UPLOAD_HOST}/video/v2/upload?upload_token={urllib.parse.quote(upload_token)}"
    req = urllib.request.Request(url, data=content, headers={"Content-Type": "application/octet-stream"}, method="POST")
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode("utf-8"))


def video_complete(upload_token, **kw):
    return call("POST", MEMBER_HOST + "/arcopen/fn/archive/video/complete",
                query={"upload_token": upload_token}, **kw)


def submit_archive(upload_token, title, tid, tag, desc="", cover=None, copyright=1, **kw):
    body = {"title": title, "tid": int(tid), "tag": tag, "desc": desc, "copyright": int(copyright)}
    if cover:
        body["cover"] = cover
    return call("POST", MEMBER_HOST + "/arcopen/fn/archive/add-by-utoken",
                query={"upload_token": upload_token}, body=body, **kw)


if __name__ == "__main__":
    cid, sec, tok = _creds()
    if not (cid and sec):
        print("请先设置 BILI_CLIENT_ID / BILI_APP_SECRET / BILI_ACCESS_TOKEN")
        print("签名示例（占位凭据）:")
        h = sign_headers("YOUR_CLIENT_ID", "YOUR_APP_SECRET", "YOUR_ACCESS_TOKEN", b"")
        for k, v in h.items():
            print(f"  {k}: {v}")
    else:
        print(json.dumps(get_user_info(), ensure_ascii=False, indent=2))