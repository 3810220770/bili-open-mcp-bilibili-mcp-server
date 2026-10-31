// 校验项目配置能否真正拉起 MCP 服务：以 D:/CYSOEditor/locales 为 cwd 启动 server.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";

const cfgPath = "D:/CYSOEditor/locales/opencode.json";
const raw = fs.readFileSync(cfgPath, "utf8");
const cfg = JSON.parse(raw);
console.log("JSON 合法, 字节:", Buffer.byteLength(raw));
if (raw.charCodeAt(0) === 0xfeff) console.log("!! 存在 BOM");
const entry = cfg.mcp["bili-open"];
console.log("entry:", JSON.stringify(entry, null, 1));

const [cmd, ...args] = entry.command;
const transport = new StdioClientTransport({
  command: cmd,
  args,
  cwd: "D:/CYSOEditor/locales",
  env: { ...process.env, ...entry.environment },
});
const client = new Client({ name: "cfgcheck", version: "0" }, { capabilities: {} });
await client.connect(transport);
const tools = await client.listTools();
console.log("从 locales 目录启动 OK, tools:", tools.tools.length);
const tool = new Set(tools.tools.map((t) => t.name));
console.log("有 bili_quickstart:", tool.has("bili_quickstart"), "| 有 bili_codegen:", tool.has("bili_codegen"));
const res = await client.listResources().catch(() => ({ resources: [] }));
const prm = await client.listPrompts().catch(() => ({ prompts: [] }));
console.log("resources:", res.resources.map((r) => r.uri).join(","), "| prompts:", prm.prompts.map((p) => p.name).join(","));
const r = await client.callTool({ name: "bili_endpoints", arguments: { method: "GET", limit: 2 } });
console.log("调用结果首行:", r.content[0].text.split("\n")[0]);
await client.close();
