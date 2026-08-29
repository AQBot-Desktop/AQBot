# MCP Servers

## What is MCP?

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open standard that lets AI models interact with external tools and data sources. AQBot acts as an MCP client — you add MCP servers, and the AI can call the tools they expose during a conversation.

---

## Transport Protocols

AQBot supports three transport protocols for communicating with MCP servers:

| Protocol | Connection | Use Case | Configuration |
|----------|-----------|----------|---------------|
| **Stdio** | Local process | Tools installed on your machine, launched via `npx`, `uvx`, `python`, etc. | `command` + `args` + optional `env` |
| **SSE** | Remote server | Server-Sent Events endpoint hosted on a remote machine or cloud service | `url` |
| **StreamableHTTP** | Remote server | HTTP streaming endpoint, the newer alternative to SSE | `url` |

---

## Adding MCP Servers

### Form Creation

1. Go to **Settings → MCP Servers**.
2. Click **Add MCP Server**.
3. Enter a name and select the transport protocol.
4. Fill in the fields for your chosen protocol:
   - **Stdio** — command to run, arguments (JSON array), environment variables (JSON object), timeout.
   - **SSE** — endpoint URL, timeout.
   - **StreamableHTTP** — endpoint URL, timeout.
5. Click **Save**.

### JSON Import

Click **JSON Import** and paste a configuration object. AQBot accepts the standard MCP JSON format:

#### Stdio server

```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```

#### SSE server

```json
{
  "mcpServers": {
    "remote-tools": {
      "type": "sse",
      "url": "https://example.com/sse"
    }
  }
}
```

#### StreamableHTTP server

```json
{
  "mcpServers": {
    "remote-http": {
      "type": "streamablehttp",
      "url": "https://example.com/mcp"
    }
  }
}
```

#### Multiple servers at once

```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
    },
    "remote": {
      "type": "sse",
      "url": "https://example.com/sse"
    }
  }
}
```

---

## Configuration Examples

### Web Fetching — `mcp-server-fetch`

Fetches web pages and converts them to readable text for the AI.

```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```

### File Operations — `@modelcontextprotocol/server-filesystem`

Gives the AI read/write access to specific directories on your machine.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/me/documents",
        "/Users/me/projects"
      ]
    }
  }
}
```

### Remote SSE Server

Connect to a remote tool server over Server-Sent Events.

```json
{
  "mcpServers": {
    "cloud-tools": {
      "type": "sse",
      "url": "https://mcp.example.com/sse"
    }
  }
}
```

### Stdio with Environment Variables

Pass API keys or configuration to the server process via environment variables.

```json
{
  "mcpServers": {
    "weather": {
      "command": "python",
      "args": ["-m", "weather_server"],
      "env": {
        "WEATHER_API_KEY": "your-api-key"
      }
    }
  }
}
```

---

## Built-in Tools

AQBot ships with built-in tools that are available without adding any external MCP server:

| Tool | Description |
|------|-------------|
| **@aqbot/fetch** | Fetch web pages and HTTP resources |
| **@aqbot/search-file** | Search for files on your local file system |

Built-in tools are listed in the MCP Servers settings alongside your custom servers and can be enabled or disabled individually.

Ordinary Chat MCP does not run terminal commands. Local shell access is provided by Agent mode in the conversation: switch modes to reuse the existing approval card, starting working directory, timeout and cancel flow. The selected directory is the process starting CWD, not a filesystem sandbox. Agent mode also does not inject the MCP servers selected in Chat.

---

## Tool Execution Panel

When the AI calls an MCP tool during a conversation, AQBot displays a **tool execution panel** inline in the chat. The panel shows:

- The **tool name** and the **server** it belongs to.
- The **input arguments** sent to the tool.
- The **output** returned by the tool.
- Execution status (running, succeeded, or failed).

Click on any tool call in the conversation to expand its details. This makes it easy to verify what the AI did and debug unexpected results.

---

## Tool Loop Limit

In Settings -> Conversation, MCP Tool Loop Max Iterations limits how many consecutive tool-call rounds one model response may run. Lower values reduce latency and cost; higher values allow longer autonomous tool workflows.

## Next Steps

- [API Gateway](./gateway) — expose your providers as a local API server
- [Getting Started](./getting-started) — return to the quick start guide
