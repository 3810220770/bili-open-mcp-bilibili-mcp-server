# 接入 MCP 客户端

> 完整操作手册（含 19 个工具的入参、真实输出、排查表）在仓库根目录的 [**USAGE.md**](../USAGE.md)。
> 本文件只给各客户端的配置片段。**下面所有路径都要换成你自己 clone 的实际路径。**

服务入口：`node <仓库路径>/src/server.mjs`（stdio）
`data/` 是相对脚本解析的，**不依赖 cwd**；
`secrets/` 的查找顺序是 **显式参数 → 环境变量 → 包目录 → 启动方 cwd**
（MCP 客户端会用它自己的项目目录当 cwd 拉起服务，所以凭据放包目录下 `secrets/` 最稳）。

凭据通过环境变量注入：

| 变量 | 含义 |
| --- | --- |
| `BILI_CLIENT_ID` | 应用 client_id（= `x-bili-accesskeyid`） |
| `BILI_APP_SECRET` | 应用 secret |
| `BILI_ACCESS_TOKEN` | OAuth2 换来的 access_token |
| `BILI_COOKIE_FILE` | 主站 Cookie jar 路径（可选，覆盖默认解析） |
| `BILI_CRED_FILE` | 开放平台凭据文件路径（可选，覆盖默认解析） |

没有凭据也能跑：`bili_docs_*`、`bili_api_spec`、`bili_api_sign`、`bili_api_call {dryRun:true}` 都可以用，只是签名会用 `YOUR_CLIENT_ID` 占位。
**哪些能用 / 哪些不能用，见 [USAGE.md §0](../USAGE.md#0-先确认你能用哪些功能)。**

---

## Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json`

> 改完**完全退出**客户端再启动（托盘图标也要退），否则不会重读配置。

```json
{
  "mcpServers": {
    "bili-open": {
      "command": "node",
      "args": ["C:\\path\\to\\bili-open-mcp\\src\\server.mjs"],
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
claude mcp add bili-open -- node "C:/path/to/bili-open-mcp/src/server.mjs"
```

带凭据：

```bash
claude mcp add bili-open -e BILI_CLIENT_ID=xxx -e BILI_APP_SECRET=yyy -e BILI_ACCESS_TOKEN=zzz \
  -- node "C:/path/to/bili-open-mcp/src/server.mjs"
```

## Codex / 通用 `~/.codex/config.toml`

```toml
[mcp_servers.bili-open]
command = "node"
args = ["C:/path/to/bili-open-mcp/src/server.mjs"]
env = { BILI_CLIENT_ID = "your_client_id", BILI_APP_SECRET = "your_app_secret", BILI_ACCESS_TOKEN = "your_access_token" }
```

## Cursor

`~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "bili-open": {
      "command": "node",
      "args": ["C:/path/to/bili-open-mcp/src/server.mjs"],
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

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bili-open": {
      "type": "local",
      "command": ["node", "C:/path/to/bili-open-mcp/src/server.mjs"],
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

查本机已装的服务是否真的拉得起来（用你自己的 `opencode.json`）：

```bash
npm run check-config -- C:/path/to/your/project/opencode.json
```

脚本会**故意用那份配置所在的目录当 cwd** 启动服务，然后断言 `secrets/` 被解析到了**包目录**
—— 这正是 MCP 客户端场景下最容易出问题的地方。缺参数时默认取当前目录的 `opencode.json`，
也可以用环境变量 `OPENCODE_CONFIG` 指定。

---

## 手动验证

```bash
# 1. 装依赖
cd C:/path/to/bili-open-mcp
npm ci

# 2. 自检（起服务 → 逐个调工具）
npm run selftest

# 3. 直接起服务（stdio，等客户端发 JSON-RPC）
node src/server.mjs
```

期望输出结尾：

```
tools(19):
  bili_quickstart
  bili_docs_search
  …
===== resources OK: bili://catalog | templates: bili://doc/{ref} | prompts: integrate-bili-api =====
===== catalog / doc 资源 + prompt OK =====
ALL SELFTEST PASSED
```