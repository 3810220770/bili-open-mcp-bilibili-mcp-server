# 接入 MCP 客户端

服务入口：`node D:\Documents\bilibili-open-docs\bili-open-mcp\src\server.mjs`（stdio）
工作目录随意，数据路径是相对脚本解析的，不依赖 cwd。

凭据通过环境变量注入：

| 变量 | 含义 |
| --- | --- |
| `BILI_CLIENT_ID` | 应用 client_id（= `x-bili-accesskeyid`） |
| `BILI_APP_SECRET` | 应用 secret |
| `BILI_ACCESS_TOKEN` | OAuth2 换来的 access_token |

没有凭据也能跑：`bili_docs_*`、`bili_api_spec`、`bili_api_sign`、`bili_api_call {dryRun:true}` 都可以用，只是签名会用 `YOUR_CLIENT_ID` 占位。

---

## Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bili-open": {
      "command": "node",
      "args": ["D:\\Documents\\bilibili-open-docs\\bili-open-mcp\\src\\server.mjs"],
      "env": {
        "BILI_CLIENT_ID": "your_client_id",
        "BILI_APP_SECRET": "your_app_secret",
        "BILI_ACCESS_TOKEN": "your_access_token"
      }
    }
  }
}
```

## Claude Code

```bash
claude mcp add bili-open -- node "D:/Documents/bilibili-open-docs/bili-open-mcp/src/server.mjs"
```

带凭据：

```bash
claude mcp add bili-open -e BILI_CLIENT_ID=xxx -e BILI_APP_SECRET=yyy -e BILI_ACCESS_TOKEN=zzz \
  -- node "D:/Documents/bilibili-open-docs/bili-open-mcp/src/server.mjs"
```

## Codex / 通用 `~/.codex/config.toml`

```toml
[mcp_servers.bili-open]
command = "node"
args = ["D:/Documents/bilibili-open-docs/bili-open-mcp/src/server.mjs"]
env = { BILI_CLIENT_ID = "your_client_id", BILI_APP_SECRET = "your_app_secret", BILI_ACCESS_TOKEN = "your_access_token" }
```

## Cursor

`~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "bili-open": {
      "command": "node",
      "args": ["D:/Documents/bilibili-open-docs/bili-open-mcp/src/server.mjs"],
      "env": {
        "BILI_CLIENT_ID": "your_client_id",
        "BILI_APP_SECRET": "your_app_secret",
        "BILI_ACCESS_TOKEN": "your_access_token"
      }
    }
  }
}
```

## OpenCode

**项目级**（推荐，只对该项目生效）：项目根目录的 `opencode.json`。
本机已写入 `D:\CYSOEditor\locales\opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bili-open": {
      "type": "local",
      "command": ["node", "D:/Documents/bilibili-open-docs/bili-open-mcp/src/server.mjs"],
      "enabled": true,
      "timeout": 60000,
      "environment": {
        "BILI_CLIENT_ID": "",
        "BILI_APP_SECRET": "",
        "BILI_ACCESS_TOKEN": ""
      }
    }
  }
}
```

**全局级**（所有项目都能用）：`%USERPROFILE%\.config\opencode\opencode.json`，把上面 `mcp` 那段合并进去即可。

字段说明（来自 `https://opencode.ai/config.json` 的 `McpLocalConfig`）：
`type` 必填 `local`，`command` 必填字符串数组，另有可选 `cwd` / `environment` / `enabled` / `timeout`（默认 5000ms，本服务建议 60000）。

查本机已装的服务是否真的拉得起来：

```bash
npm run check-config
```

---

## 手动验证

```bash
# 1. 装依赖
cd D:/Documents/bilibili-open-docs/bili-open-mcp
npm install

# 2. 自检（起服务 → 逐个调工具）
npm run selftest

# 3. 直接起服务（stdio，等客户端发 JSON-RPC）
node src/server.mjs
```

期望输出结尾：

```
tools(17):
  bili_quickstart
  bili_docs_search
  …
===== catalog / doc 资源 + prompt OK =====
ALL SELFTEST PASSED
```