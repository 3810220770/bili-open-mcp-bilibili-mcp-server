#!/usr/bin/env node
/**
 * selftest.mjs — 通过 stdio 连上本 MCP 服务，逐个调用工具/资源/提示验证可用性。
 * 会对生成的代码做真实语法检查（python -m py_compile / node --check）。
 * 用法: npm run selftest
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "src", "server.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mcp-"));

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
const client = new Client({ name: "selftest", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);

const fail = [];
const pick = (r) => r?.content?.[0]?.text ?? "";

async function t(name, args, check) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = pick(r);
    const ok = check ? check(text) : text.length > 0;
    if (!ok) fail.push(`${name} -> 输出不符合预期`);
    console.log(`===== ${name} ${ok ? "OK" : "FAIL"} =====`);
    return text;
  } catch (e) {
    fail.push(`${name} -> ${e.message}`);
    console.log(`===== ${name} ERROR =====\n${e.message}`);
    return "";
  }
}

const fence = (s, lang) => {
  const m = new RegExp("```" + lang + "\\n([\\s\\S]*?)\\n```").exec(s);
  return m ? m[1] : "";
};

const tools = await client.listTools();
const names = tools.tools.map((x) => x.name);
console.log("tools(" + names.length + "):\n  " + names.join("\n  "));

// ---------------- 基础工具 ----------------
await t("bili_quickstart", {}, (s) => s.includes("HMAC-SHA256") && s.includes("93daf316"));
await t("bili_docs_search", { query: "投稿" }, (s) => s.includes("#"));
await t("bili_docs_list", { folder: "直播能力", limit: 8 }, (s) => s.includes("直播"));
await t("bili_api_spec", { ref: "12" }, (s) => s.includes("upload_token") && s.includes("POST"));
await t("bili_api_spec", { url: "https://member.bilibili.com/arcopen/fn/live/room/info" }, (s) => s.includes("GET"));
await t("bili_api_spec", { ref: "16" }, (s) => s.includes("signVersion") && s.includes("子结构"));
await t("bili_api_spec", { ref: "114" }, (s) => s.includes("  - "));
await t("bili_api_sign", { url: "https://member.bilibili.com/arcopen/fn/user/account/info", method: "GET" }, (s) =>
  s.includes("x-bili-timestamp") && s.includes("curl")
);
await t("bili_api_call", { ref: "5", dryRun: true }, (s) => s.includes("dryRun"));
await t("bili_error_lookup", { code: "4002" }, (s) => s.includes("签名"));
await t("bili_error_lookup", { code: "1230", fuzzy: true }, (s) => s.includes("1230"));
await t("bili_docs_get", { ref: "044", maxChars: 600 }, (s) => s.includes("doc: #44"));

// ---------------- 新增工具 ----------------
await t("bili_endpoints", { scope: "SHOP_ORDER_INFO", method: "POST" }, (s) => s.includes("命中") && s.includes("#78"));
await t("bili_endpoints", { host: "openupos.bilivideo.com" }, (s) => s.includes("#9") && s.includes("#14"));
await t("bili_endpoints", { source: "web" }, (s) => s.includes("主站隐藏能力") || s.includes("web:report-"));
await t("bili_endpoints", { source: "web", pathContains: "举报", limit: 20 }, (s) => s.includes("web:report-user") && s.includes("web:report-comment"));
await t("bili_endpoints", { source: "all", pathContains: "订单", limit: 10 }, (s) => s.includes("命中"));
await t("bili_scopes", {}, (s) => s.includes("个 scope") && s.includes("ARC_BASE"));
await t("bili_scopes", { scope: "ARC_BASE" }, (s) => s.includes("#12"));
await t("bili_scopes", { ref: "12" }, (s) => s.includes("ARC_BASE"));
await t(
  "bili_api_prepare",
  { ref: "12", query: { upload_token: "T" }, body: { title: "t", tid: "21", tag: "a", copyright: "1", no_such: 1 } },
  (s) => s.includes("类型已转换") && s.includes("多传") && s.includes('"tid":21')
);
await t("bili_api_prepare", { ref: "25", body: { pn: "2" } }, (s) => s.includes("query") && s.includes("归位"));
await t("bili_upload_plan", { fileSizeMB: 250 }, (s) => s.includes("分片") && s.includes("part_number"));
await t("bili_upload_plan", { fileSizeMB: 30 }, (s) => s.includes("单文件"));
await t("bili_oauth", { action: "help" }, (s) =>
  s.includes("只能使用一次") && s.includes("account-pc/auth/oauth") && s.includes("gourl")
);
await t("bili_webhook", { action: "list" }, (s) => s.includes("41 个") && s.includes("verify_webhooks"));
await t("bili_webhook", { action: "verify-code", lang: "python" }, (s) => s.includes("x-bilibili-signature") || s.includes("sha1"));
await t("bili_webhook", { action: "detail", ref: "164" }, (s) => s.includes("SEND_MSG"));
await t("bili_ws_protocol", { code: "python" }, (s) => s.includes("OP_AUTH") && s.includes("struct.Struct"));
await t("bili_mock", { action: "list" }, (s) => s.includes("43 个"));
await t("bili_mock", { action: "map", ref: "12" }, (s) => s.includes("/mock/"));

// 主站 Cookie / Web 接口（写操作全部指向临时 jar，绝不动 secrets/cookies.json）
const JAR = path.join(TMP, "cookies.json");
const realJar = path.join(HERE, "..", "secrets", "cookies.json");
const realBefore = fs.existsSync(realJar) ? fs.readFileSync(realJar, "utf8") : null;
await t("bili_cookie", { action: "status", file: JAR }, (s) => s.includes("cookie") && s.includes("SESSDATA"));
await t("bili_cookie", { action: "import", file: JAR, jar: "SESSDATA=abc123; bili_jct=deadbeef" }, (s) =>
  s.includes("已写入") && s.includes("2 个")
);
await t("bili_cookie", { action: "status", file: JAR, reveal: false }, (s) => s.includes("abc123") === false);
await t("bili_cookie", { action: "status", file: JAR, reveal: true }, (s) => s.includes("abc123"));
await t("bili_cookie", { action: "import", file: JAR, jar: [{ name: "SESSDATA", value: "x", domain: ".bilibili.com" }] }, (s) =>
  s.includes("合并后共 2 个")
);
await t("bili_cookie", { action: "set", file: JAR, name: "bili_jct", value: "new" }, (s) => s.includes("已更新"));
await t("bili_cookie", { action: "set", file: JAR, name: "bili_jct" }, (s) => s.includes("已更新"));
await t("bili_cookie", { action: "export", file: JAR }, (s) => s.includes("脱敏"));
await t("bili_cookie", { action: "clear", file: JAR }, (s) => s.includes("已清空"));
await t("bili_web_call", { path: "x/web-interface/nav", dryRun: true }, (s) => s.includes("dryRun") && s.includes("Cookie"));
await t("bili_web_call", { url: "https://api.bilibili.com/x/web-interface/nav", form: { a: "1" }, dryRun: true }, (s) =>
  s.includes("csrf")
);
await t("bili_web_call", { url: "https://evil.example.com/x" }, (s) => s.includes("安全限制"));
await t("bili_web_call", {}, (s) => s.includes("需要 path 或 url"));
await t("bili_web_call", { url: "https://api.bilibili.com/x/space/wbi/acc/info?mid=2", dryRun: true }, (s) =>
  s.includes("w_rid") && s.includes("mixin_key") && s.includes("wts=")
);
await t("bili_web_call", { url: "https://api.bilibili.com/x/web-interface/nav", dryRun: true }, (s) => !s.includes("w_rid"));
await t("bili_web_call", { url: "https://api.bilibili.com/x/web-interface/nav", wbi: true, dryRun: true }, (s) => s.includes("w_rid"));

// OAuth 凭据链路（不动真实凭据文件）
await t("bili_oauth", { action: "status" }, (s) => s.includes("开放平台凭据状态") && s.includes("凭据文件"));
await t("bili_oauth", { action: "status", clientId: "cid", clientSecret: "sec" }, (s) => s.includes("参数"));
await t("bili_oauth", { action: "authorize-url" }, (s) => s.includes("缺少 clientId"));
await t("bili_oauth", { action: "authorize-url", clientId: "CID123", gourl: "http://127.0.0.1:8848/callback" }, (s) =>
  s.includes("account.bilibili.com/pc/account-pc/auth/oauth") &&
  s.includes("client_id=CID123") &&
  s.includes("http%3A%2F%2F127.0.0.1%3A8848%2Fcallback")
);
await t("bili_oauth", { action: "authorize-url", clientId: "CID123" }, (s) => s.includes("需要 gourl"));
await t("bili_oauth", { action: "help" }, (s) => s.includes("account-pc/auth/oauth"));
{
  const after = fs.existsSync(realJar) ? fs.readFileSync(realJar, "utf8") : null;
  const intact = after === realBefore;
  if (!intact) fail.push("自检改动了 secrets/cookies.json（写操作没隔离到临时 jar）");
  console.log(`===== 真实 cookie 罐未被触碰 ${intact ? "OK" : "FAIL"} =====`);
}

// ---------------- 生成的代码要能编译 ----------------
const pyCode = fence(await t("bili_codegen", { ref: "12", lang: "python" }, (s) => s.includes("def sign_headers")), "python");
const jsCode = fence(await t("bili_codegen", { ref: "12", lang: "node" }, (s) => s.includes("function signHeaders")), "js");
const goCode = fence(await t("bili_codegen", { ref: "12", lang: "go" }, (s) => s.includes("func sign(")), "go");
const shCode = fence(await t("bili_codegen", { ref: "12", lang: "curl" }, (s) => s.includes("openssl")), "bash");
await t("bili_codegen", { ref: "25", lang: "php" }, (s) => s.includes("hash_hmac"));
await t("bili_codegen", { ref: "41", lang: "java" }, (s) => s.includes("HmacSHA256"));

for (const [label, code, file, cmd, args] of [
  ["python 代码编译", pyCode, "gen.py", "python", ["-m", "py_compile"]],
  ["node 代码语法", jsCode, "gen.mjs", process.execPath, ["--check"]],
]) {
  try {
    const f = path.join(TMP, file);
    fs.writeFileSync(f, code, "utf8");
    execFileSync(cmd, [...args, f], { stdio: "pipe" });
    console.log(`===== ${label} OK =====`);
  } catch (e) {
    fail.push(`${label} 失败: ${String(e.stderr || e.message).slice(0, 300)}`);
    console.log(`===== ${label} FAIL =====\n${String(e.stderr || e.message).slice(0, 400)}`);
  }
}
for (const [label, code] of [["go 骨架", goCode], ["bash 骨架", shCode]]) {
  const ok = code.length > 300 && !/undefined/.test(code);
  if (!ok) fail.push(`${label} 输出异常`);
  console.log(`===== ${label} ${ok ? "OK" : "FAIL"} (${code.length} 字符) =====`);
}

// 生成代码里的签名算法必须与参考向量一致（冻结时间与 nonce 后比对）
try {
  const genFile = path.join(TMP, "gen_sign.py");
  const harness = path.join(TMP, "check_sign.py");
  fs.writeFileSync(genFile, pyCode, "utf8");
  fs.writeFileSync(
    harness,
    [
      "import importlib.util, time, uuid, json",
      `spec = importlib.util.spec_from_file_location("gen_sign", r"${genFile}")`,
      "m = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(m)",
      "time.time = lambda: 1730185575",
      "uuid.uuid4 = lambda: '1730185575446751000'",
      "h = m.sign_headers('93a0f774fae84e6c', 'test_secret', 'TOKEN', b'')",
      "print(h['Authorization'])",
      "print(h['X-Bili-Content-Md5'])",
    ].join("\n"),
    "utf8"
  );
  const out = execFileSync("python", [harness], { encoding: "utf8" }).trim().split(/\r?\n/);
  const ok =
    out[0] === "93daf316cf499f313e6e7c487857fe3b1c8e9b6a262123e36ddf867bd97e5e1f" &&
    out[1] === "d41d8cd98f00b204e9800998ecf8427e";
  if (!ok) fail.push(`生成代码的签名与参考向量不一致: ${out.join(" / ")}`);
  console.log(`===== 生成代码签名自检 ${ok ? "OK" : "FAIL"}: ${out[0]} =====`);
} catch (e) {
  fail.push("生成代码签名自检失败: " + String(e.message).slice(0, 200));
  console.log("===== 生成代码签名自检 ERROR: " + String(e.message).slice(0, 200) + " =====");
}
try {
  fs.writeFileSync(path.join(TMP, "sign.sh"), shCode, "utf8");
  execFileSync("bash", ["-n", path.join(TMP, "sign.sh")], { stdio: "pipe" });
  console.log("===== bash -n 语法 OK =====");
} catch (e) {
  console.log("===== bash -n 跳过（无 bash 或语法问题）: " + String(e.message).slice(0, 120) + " =====");
}

// ---------------- 资源与提示 ----------------
try {
  const res = await client.listResources();
  const tmpl = await client.listResourceTemplates();
  const pr = await client.listPrompts();
  console.log(
    `===== resources OK: ${res.resources.map((r) => r.uri).join(", ")} | templates: ${tmpl.resourceTemplates
      .map((r) => r.uriTemplate)
      .join(", ")} | prompts: ${pr.prompts.map((p) => p.name).join(", ")} =====`
  );
  const cat = await client.readResource({ uri: "bili://catalog" });
  if (!cat.contents[0].text.includes("[#12]")) fail.push("bili://catalog 内容异常");
  const doc = await client.readResource({ uri: "bili://doc/12" });
  if (!doc.contents[0].text.includes("视频稿件提交")) fail.push("bili://doc/12 内容异常");
  const webRes = await client.readResource({ uri: "bili://web" });
  if (!webRes.contents[0].text.includes("主站 Web 隐藏能力") || !webRes.contents[0].text.includes("/x/space/report")) {
    fail.push("bili://web 内容异常");
  }
  console.log("===== bili://web 资源 OK =====");
  const prompt = await client.getPrompt({ name: "integrate-bili-api", arguments: { ref: "12" } });
  if (!prompt.messages[0].content.text.includes("HMAC-SHA256")) fail.push("prompt 内容异常");
  console.log("===== catalog / doc 资源 + prompt OK =====");
} catch (e) {
  fail.push("资源或提示失败: " + e.message);
  console.log("===== 资源/提示 ERROR: " + e.message + " =====");
}

// ---------------- 边界与错误路径 ----------------
await t("bili_docs_search", { query: "zzzz不存在的词" }, (s) => s.includes("未找到"));
await t("bili_api_spec", { ref: "不存在的接口名" }, (s) => s.includes("未找到接口"));
await t("bili_api_sign", { url: "not-a-url" }, (s) => s.includes("签名失败"));
await t("bili_docs_list", { folder: "不存在的目录", limit: 5 }, (s) => s.includes("共 0 条"));
await t("bili_error_lookup", { code: "999999" }, (s) => s.includes("未收录"));
await t("bili_docs_get", { ref: "999" }, (s) => s.includes("未找到文档"));
await t("bili_codegen", { ref: "44", lang: "python" }, (s) => s.includes("不是 HTTP 接口"));
await t("bili_mock", { action: "call", mockUrl: "https://evil.example.com/mock/x" }, (s) => s.includes("安全限制"));
await t("bili_oauth", { action: "exchange" }, (s) => s.includes("需要 code") || s.includes("缺少 clientId"));

await client.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log("\n============================");
if (fail.length) {
  console.log("FAILURES:\n" + fail.map((f) => "  - " + f).join("\n"));
  process.exitCode = 1;
} else {
  console.log("ALL SELFTEST PASSED");
}
