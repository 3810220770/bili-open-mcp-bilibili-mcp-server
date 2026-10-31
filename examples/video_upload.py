#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
video_upload.py — 视频投稿完整流程（服务端投递）

流程（对应文档 #8 → #9/#10 → #11 → #12）:
  1. POST /arcopen/fn/archive/video/init          文件上传预处理 → upload_token
  2. POST openupos.../video/v2/part/upload        分片上传（裸二进制，part_number 从 1 开始）
     或 POST openupos.../video/v2/upload          单文件（<100M，utype=1）
  3. POST /arcopen/fn/archive/video/complete      分片合片
  4. POST /arcopen/fn/archive/cover/upload        封面上传（multipart, 返回 url）
  5. POST /arcopen/fn/archive/add-by-utoken       稿件提交 → resource_id(BV 号)

用法:
  set BILI_CLIENT_ID=...
  set BILI_APP_SECRET=...
  set BILI_ACCESS_TOKEN=...
  python video_upload.py demo.mp4 "标题" 21 "标签1,标签2" [封面.png]
"""
import os
import sys

from bili_open import (
    MEMBER_HOST,
    call_multipart,
    submit_archive,
    upload_part,
    upload_single,
    video_complete,
    video_init,
)

CHUNK = 10 * 1024 * 1024  # 10MB，除最后一片外必须等大


def log(*a):
    print(*a, flush=True)


def upload_cover(path):
    with open(path, "rb") as f:
        content = f.read()
    name = os.path.basename(path)
    r = call_multipart(MEMBER_HOST + "/arcopen/fn/archive/cover/upload", "file", name, content)
    if r.get("code") != 0:
        raise RuntimeError(f"封面上传失败: {r}")
    return r["data"]["url"]


def main():
    if len(sys.argv) < 5:
        print(__doc__)
        sys.exit(1)

    path, title, tid, tag = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    cover_path = sys.argv[5] if len(sys.argv) > 5 else None

    size = os.path.getsize(path)
    filename = os.path.basename(path)
    single = size <= 100 * 1024 * 1024
    log(f"文件: {filename}  {size/1024/1024:.1f}MB  模式: {'单文件' if single else '分片'}")

    # 1. 预处理
    r = video_init(filename, utype="1" if single else "0")
    if r.get("code") != 0:
        raise RuntimeError(f"init 失败: {r}")
    token = r["data"]["upload_token"]
    log(f"upload_token = {token}")

    # 2. 上传
    if single:
        with open(path, "rb") as f:
            res = upload_single(token, f.read())
        log(f"单文件上传: {res}")
    else:
        total = (size + CHUNK - 1) // CHUNK
        with open(path, "rb") as f:
            for n in range(1, total + 1):
                chunk = f.read(CHUNK)
                res = upload_part(token, n, chunk)
                if res.get("code") not in (0, None):
                    raise RuntimeError(f"分片 {n}/{total} 失败: {res}")
                log(f"  分片 {n}/{total}  {len(chunk)/1024/1024:.1f}MB  ok")
        # 3. 合片
        rc = video_complete(token)
        if rc.get("code") != 0:
            raise RuntimeError(f"合片失败: {rc}")
        log("合片完成")

    # 4. 封面
    cover_url = None
    if cover_path:
        cover_url = upload_cover(cover_path)
        log(f"封面: {cover_url}")

    # 5. 提交
    rs = submit_archive(token, title=title, tid=tid, tag=tag, desc="", cover=cover_url, copyright=1)
    if rs.get("code") != 0:
        raise RuntimeError(f"提交失败: {rs}")
    log(f"投稿成功: {rs['data'].get('resource_id')}")


if __name__ == "__main__":
    main()