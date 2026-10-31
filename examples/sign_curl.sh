#!/usr/bin/env bash
# sign_curl.sh — 纯 bash + openssl 生成开放平台 2.0 签名并调用
#
# 用法:
#   export BILI_CLIENT_ID=xxx BILI_APP_SECRET=yyy BILI_ACCESS_TOKEN=zzz
#   ./sign_curl.sh GET  https://member.bilibili.com/arcopen/fn/user/account/info
#   ./sign_curl.sh POST https://member.bilibili.com/arcopen/fn/archive/add-by-utoken \
#        '{"title":"t","tid":21,"tag":"a","copyright":1}' '["upload_token","xxx"]'
#
# 第 4 个参数可选，JSON 数组形式的 url 参数 ["k","v","k2","v2"]，调用方自己做 urlencode。
set -euo pipefail

METHOD="${1:?method}"
URL="${2:?url}"
BODY="${3:-}"
QUERY_JSON="${4:-}"

CID="${BILI_CLIENT_ID:?set BILI_CLIENT_ID}"
SEC="${BILI_APP_SECRET:?set BILI_APP_SECRET}"
TOK="${BILI_ACCESS_TOKEN:-}"

# 拼 url 参数
if [[ -n "$QUERY_JSON" ]]; then
  QS=$(python -c 'import sys,json,urllib.parse
a=json.loads(sys.argv[1]);print(urllib.parse.urlencode(dict(zip(a[0::2],a[1::2]))))' "$QUERY_JSON")
  if [[ "$URL" == *\?* ]]; then URL="${URL}&${QS}"; else URL="${URL}?${QS}"; fi
fi

TS=$(date +%s)
NONCE=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)

if [[ "$METHOD" == "GET" || -z "$BODY" ]]; then
  MD5=$(printf '%s' "" | md5sum | cut -d' ' -f1)
else
  MD5=$(printf '%s' "$BODY" | md5sum | cut -d' ' -f1)
fi

TO_SIGN=$(printf 'x-bili-accesskeyid:%s\nx-bili-content-md5:%s\nx-bili-signature-method:HMAC-SHA256\nx-bili-signature-nonce:%s\nx-bili-signature-version:2.0\nx-bili-timestamp:%s' \
  "$CID" "$MD5" "$NONCE" "$TS")

AUTH=$(printf '%s' "$TO_SIGN" | openssl dgst -sha256 -hmac "$SEC" -hex | awk '{print $NF}')

echo "--- 待签名串 ---"
echo "$TO_SIGN"
echo "--- 请求 ---"

curl --location --request "$METHOD" "$URL" \
  --header 'Accept: application/json' \
  --header 'Content-Type: application/json' \
  --header "Authorization: ${AUTH}" \
  --header "x-bili-accesskeyid: ${CID}" \
  --header "x-bili-content-md5: ${MD5}" \
  --header 'x-bili-signature-method: HMAC-SHA256' \
  --header "x-bili-signature-nonce: ${NONCE}" \
  --header 'x-bili-signature-version: 2.0' \
  --header "x-bili-timestamp: ${TS}" \
  ${TOK:+--header "access-token: ${TOK}"} \
  ${BODY:+--data-raw "$BODY"}