#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
live_ws.py — 直播间长连（消息订阅）示例

依赖:  pip install websockets

流程（文档 #43 / #44）:
  1. POST /arcopen/fn/live/room/ws-start  → conn_id + websocket_info{wss_link[], auth_body}
  2. 连接 wss_link，先发 OP_AUTH(7)，body = auth_body(JSON 字符串)
  3. 每 30s 发 OP_HEARTBEAT(2)，空 body
  4. 收 OP_SEND_SMS_REPLY(5) 即弹幕/礼物等消息；version=2 时 body 为 zlib 压缩，可能含多个包

包头 16 字节，全大端:
  Packet Length uint32 | Header Length uint16(=16) | Version uint16 |
  Operation uint32 | Sequence ID uint32 | Body
"""
import asyncio
import json
import struct
import zlib

try:
    import websockets
except ImportError:
    raise SystemExit("需要 websockets: pip install websockets")

from bili_open import MEMBER_HOST, call

OP_HEARTBEAT = 2
OP_HEARTBEAT_REPLY = 3
OP_SEND_SMS_REPLY = 5
OP_AUTH = 7
OP_AUTH_REPLY = 8

HEADER = struct.Struct(">IHHII")


def pack(op, body: bytes = b"", version: int = 1, seq: int = 1) -> bytes:
    return HEADER.pack(HEADER.size + len(body), HEADER.size, version, op, seq) + body


def unpack(buf: bytes):
    """返回 [(op, body_bytes, version)]；version=2 会先解压再递归。"""
    out = []
    off = 0
    while off + HEADER.size <= len(buf):
        plen, hlen, ver, op, seq = HEADER.unpack_from(buf, off)
        if plen < hlen or off + plen > len(buf):
            break
        body = buf[off + hlen: off + plen]
        off += plen
        if ver == 2:
            try:
                out.extend(unpack(zlib.decompress(body)))
                continue
            except zlib.error:
                pass
        if ver == 3:  # brotli，需要额外依赖
            out.append((op, body, ver))
            continue
        out.append((op, body, ver))
    return out


async def run():
    r = call("POST", MEMBER_HOST + "/arcopen/fn/live/room/ws-start")
    if r.get("code") != 0:
        raise SystemExit(f"ws-start 失败: {r}")

    info = r["data"]
    conn_id = info["conn_id"]
    wi = info["websocket_info"]
    links = wi["wss_link"]
    auth_body = wi["auth_body"]

    print("conn_id:", conn_id)
    print("links:", links)

    async with websockets.connect(links[0], max_size=None) as ws:
        # 1. 鉴权
        await ws.send(pack(OP_AUTH, auth_body.encode(), seq=1))
        print("sent AUTH")

        # 2. 心跳任务
        async def heartbeat():
            while True:
                await asyncio.sleep(30)
                await ws.send(pack(OP_HEARTBEAT, b"", seq=1))
                # 可选: 同时走 HTTP 心跳
                # call("POST", MEMBER_HOST + "/arcopen/fn/live/room/ws-heartbeat",
                #      query={"client_id": os.getenv("BILI_CLIENT_ID")}, body={"conn_id": conn_id})

        hb = asyncio.create_task(heartbeat())

        try:
            async for frame in ws:
                if isinstance(frame, str):
                    print("[text]", frame[:300])
                    continue
                for op, body, ver in unpack(frame):
                    if op == OP_AUTH_REPLY:
                        print("[auth]", body.decode("utf-8", "replace")[:300])
                    elif op == OP_HEARTBEAT_REPLY:
                        print("[hb]", body.hex())
                    elif op == OP_SEND_SMS_REPLY:
                        try:
                            msg = json.loads(body.decode("utf-8", "replace"))
                            print("[msg]", json.dumps(msg, ensure_ascii=False)[:500])
                        except Exception:
                            print("[msg raw]", body[:200])
                    else:
                        print("[op", op, "]", body[:120])
        finally:
            hb.cancel()


if __name__ == "__main__":
    asyncio.run(run())