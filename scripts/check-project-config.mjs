// 校验「一份真实的 MCP 客户端项目配置能否真正拉起本服务」。
//
// 模拟真实场景：客户端用它**自己的项目目录**当 cwd 启动 server.mjs，
// 而凭据放在**包目录**的 secrets/ 下 —— 验证这条路走得通（这是最容易踩的坑）。
//
// 用法：
//   node scripts/check-project-config.mjs [opencode.json 路径]
// 默认取当前目录下的 opencode.json，也可用 OPENCODE_CONFIG 指定。
// opencode.json 里需要有一条名为 bili-open 的 local MCP 配置。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");

const cfgPath = path.resolve(
  process.argv[2] || process.env.OPENCODE_CONFIG || path.join(process.cwd(), "opencode.json")
);
if (!fs.existsSync(cfgPath)) {
  console.error(`找不到 ${cfgPath}`);
  console.error("用法: node scripts/check-project-config.mjs <opencode.json 路径>");
  process.exit(1);
}
const projectDir = path.dirname(cfgPath);

const raw = fs.readFileSync(cfgPath, "utf8");
const cfg = JSON.parse(raw);
console.log("配置文件:", cfgPath);
console.log("JSON 合法, 字节:", Buffer.byteLength(raw));
if (raw.charCodeAt(0) === 0xfeff) console.log("!! 存在 BOM");
const entry = cfg.mcp["bili-open"];
console.log("entry:", JSON.stringify(entry, null, 1));

const [cmd, ...args] = entry.command;
const transport = new StdioClientTransport({
  command: cmd,
  args,
  cwd: projectDir, // ← 故意用「客户端项目目录」，不是包目录
  env: { ...process.env, ...entry.environment },
});
const client = new Client({ name: "cfgcheck", version: "0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log(`从 ${projectDir} 启动 OK, tools:`, tools.tools.length);
const tool = new Set(tools.tools.map((t) => t.name));
console.log("有 bili_quickstart:", tool.has("bili_quickstart"), "| 有 bili_codegen:", tool.has("bili_codegen"));

const res = await client.listResources().catch(() => ({ resources: [] }));
const prm = await client.listPrompts().catch(() => ({ prompts: [] }));
console.log(
  "resources:",
  res.resources.map((r) => r.uri).join(","),
  "| prompts:",
  prm.prompts.map((p) => p.name).join(",")
);

// 关键回归：cwd 是别处时，secrets/ 必须解析到包目录，
// 而不是让用户看到一个「文件不存在」的路径。
const cred = await client.callTool({ name: "bili_oauth", arguments: { action: "status" } });
const credLine = cred.content[0].text.split("\n").find((l) => l.startsWith("凭据文件:"));
console.log(credLine);
const expected = path.join(PKG_ROOT, "secrets", "open-platform.json");
const norm = (s) => s.replace(/[\\/]+/g, "/").toLowerCase();
if (credLine && !norm(credLine).includes(norm(expected))) {
  console.log(`!! 凭据路径没解析到包目录，期望包含 ${expected}`);
  process.exitCode = 1;
} else {
  console.log("OK: 凭据路径解析到包目录，不受启动 cwd 影响");
}

const r = await client.callTool({ name: "bili_endpoints", arguments: { method: "GET", limit: 2 } });
console.log("调用结果首行:", r.content[0].text.split("\n")[0]);
await client.close();
