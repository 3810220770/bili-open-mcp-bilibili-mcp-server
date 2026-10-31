/**
 * oauth-login.mjs — 本机一键跑完开放平台授权回环
 *
 *   npm run login                                  # 用文件里的 clientId/secret
 *   npm run login -- --client-id xxx --secret yyy  # 现填，存进文件
 *   npm run login -- --gourl http://127.0.0.1:8848/callback
 *
 * 流程：起本地回调服务 → 打印授权页链接 → 你点同意 → 抓 code → POST 换 token
 *      → 把 access_token / refresh_token / expires_in / scopes 写进 secrets/open-platform.json
 */
import http from "node:http";
import { execFile } from "node:child_process";
import { loadCredFile, saveCredFile } from "../src/credentials.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

const DEFAULT_PORT = 8848;
const PORT = Number(opt("port", DEFAULT_PORT));
const GOURI = opt("gourl", `http://127.0.0.1:${PORT}/callback`);
const clientId = opt("client-id", "") || loadCredFile().data.clientId || process.env.BILI_CLIENT_ID || "";
const appSecret = opt("secret", "") || loadCredFile().data.appSecret || process.env.BILI_APP_SECRET || "";
const state = Math.random().toString(36).slice(2) + Date.now().toString(36);

if (!clientId || !appSecret) {
  console.error(
    [
      "缺 Client ID / App Secret。",
      "",
      "这两个不是浏览器 cookie，Cookie 里没有它们。获取方式：",
      "  1. 打开 https://open.bilibili.com  用你的 B 站账号登录",
      "  2. 完成实名认证 + 开发者入驻（个人 up 主也可，审核后才可创建应用）",
      "  3. 控制台 → 应用管理 → 创建应用 → 类型选「网页应用」",
      "     授权回调域填: " + GOURI,
      "  4. 应用详情页复制 Client ID 与 Secret，然后:",
      "       npm run login -- --client-id <ClientID> --secret <Secret> --gourl " + GOURI,
      "",
      "全程不需要填 BILI_ACCESS_TOKEN —— 它会由本次授权换出来并自动保存。",
    ].join("\n")
  );
  process.exit(1);
}

const authorizeUrl =
  "https://account.bilibili.com/pc/account-pc/auth/oauth" +
  `?client_id=${encodeURIComponent(clientId)}&gourl=${encodeURIComponent(GOURI)}&state=${encodeURIComponent(state)}`;

const exchange = async (code) => {
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: appSecret,
    grant_type: "authorization_code",
    code,
  });
  const res = await fetch("https://api.bilibili.com/x/account-oauth2/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px/1.6 system-ui;padding:40px;max-width:640px;margin:auto">` +
  `<h2>${title}</h2>${body}</body>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname !== "/callback") {
    res.writeHead(404).end("not found");
    return;
  }
  const code = u.searchParams.get("code");
  const gotState = u.searchParams.get("state");
  if (!code) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("授权失败", "<p>回调里没有 code。</p>"));
    return;
  }
  if (gotState && gotState !== state) {
    res
      .writeHead(400, { "content-type": "text/html; charset=utf-8" })
      .end(page("state 不匹配", `<p>期望 ${state}，收到 ${gotState}。已丢弃，防 CSRF。</p>`));
    return;
  }
  console.log("\n收到 code，正在换取 access_token …");
  const { status, json } = await exchange(code);
  const ok = json?.code === 0 && json?.data?.access_token;
  if (!ok) {
    console.error(`换取失败  HTTP ${status}\n` + JSON.stringify(json, null, 2));
    res
      .writeHead(500, { "content-type": "text/html; charset=utf-8" })
      .end(page("换取 token 失败", `<pre>${JSON.stringify(json, null, 2)}</pre>`));
    server.close();
    process.exitCode = 1;
    return;
  }
  const saved = saveCredFile({
    clientId,
    appSecret,
    accessToken: json.data.access_token,
    refreshToken: json.data.refresh_token,
    expires_in: json.data.expires_in,
    scopes: json.data.scopes,
  });
  const exp = json.data.expires_in ? new Date(json.data.expires_in * 1000).toISOString() : "未知";
  console.log(
    [
      "",
      "✅ 授权完成",
      `  access_token  : ${json.data.access_token.slice(0, 8)}…(${json.data.access_token.length}B)`,
      `  refresh_token : ${json.data.refresh_token ? json.data.refresh_token.slice(0, 8) + "…" : "（未返回）"}`,
      `  到期(UTC)     : ${exp}`,
      `  scopes        : ${(json.data.scopes || []).join(", ") || "（未返回）"}`,
      `  已写入        : ${saved.file}`,
      "",
      "现在 bili_api_call 可以直接发真实请求了，例如:",
      '  bili_api_call {ref:"#5"}',
      "",
    ].join("\n")
  );
  res
    .writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(page("授权成功", "<p>可以关闭本页，回到终端。</p>"));
  server.close();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    [
      "",
      "本地回调服务已监听  " + GOURI,
      "",
      "在浏览器打开下面的链接并点「同意授权」:",
      "",
      authorizeUrl,
      "",
      `（回调域必须和应用里配的一致，否则会提示「不合法的授权请求」）`,
      "等待回调中…  Ctrl+C 取消",
    ].join("\n")
  );
  const opener = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", authorizeUrl] : [authorizeUrl];
  execFile(opener, args, () => {});
});

setTimeout(() => {
  console.error("\n超时 5 分钟未收到回调，退出。");
  server.close();
  process.exit(1);
}, 300000).unref();
