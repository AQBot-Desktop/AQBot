# MCP 服务器

## 什么是 MCP？

[Model Context Protocol（MCP）](https://modelcontextprotocol.io/)是一种开放协议，让 AI 模型能够与外部工具和数据源交互。通过 MCP，模型可以在对话中调用文件操作、网页抓取、数据库查询等各种工具，大幅扩展 AI 的实际能力。

AQBot 内置了 MCP 客户端，你可以连接各种 MCP 服务器来为 AI 对话增加工具调用能力。

## 传输协议

AQBot 支持三种 MCP 传输协议，适用于不同的部署场景：

| 协议 | 连接方式 | 适用场景 | 配置参数 |
|------|---------|---------|---------|
| **Stdio** | 本地子进程 | 通过 `npx`、`uvx`、自定义命令启动的本地工具 | `command` + `args` |
| **SSE** | Server-Sent Events | 远程托管的 MCP 服务器 | `url` |
| **StreamableHTTP** | HTTP 流式传输 | 远程 HTTP 服务器，支持双向流 | `url` |

::: info Stdio vs 远程
大部分 MCP 服务器以 Stdio 模式运行——AQBot 在本地启动一个进程并通过标准输入/输出通信。如果你连接的是远程部署的服务器，则使用 SSE 或 StreamableHTTP 协议。
:::

## 添加 MCP 服务器

### 表单创建

1. 进入 **设置 → MCP 服务器**
2. 点击 **添加 MCP 服务器**
3. 填写基本信息：
   - **名称** — 为服务器取一个易识别的名称
   - **传输协议** — 选择 Stdio、SSE 或 StreamableHTTP
4. 根据所选协议填写相应配置：
   - **Stdio**：填写启动命令（如 `npx`、`uvx`）和参数
   - **SSE / StreamableHTTP**：填写服务器 URL
5. 保存后 AQBot 会自动连接并获取可用工具列表

### JSON 导入

如果你有现成的 MCP 配置（如从其他工具导出），可以直接粘贴 JSON 快速导入。AQBot 支持标准的 `mcpServers` 配置格式。

#### Stdio 协议格式

```json
{
  "mcpServers": {
    "my-tool": {
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": {
        "API_KEY": "your-key"
      }
    }
  }
}
```

#### SSE 协议格式

```json
{
  "mcpServers": {
    "remote-server": {
      "type": "sse",
      "url": "https://example.com/sse"
    }
  }
}
```

#### StreamableHTTP 协议格式

```json
{
  "mcpServers": {
    "http-server": {
      "type": "streamablehttp",
      "url": "https://example.com/mcp"
    }
  }
}
```

::: tip 批量导入
你可以在一个 JSON 中包含多个服务器，AQBot 会一次性全部导入。
:::

## 配置示例

以下是一些常用 MCP 服务器的配置示例。

### 网页抓取 — mcp-server-fetch

使用 `uvx` 启动网页抓取工具，让 AI 能够读取网页内容：

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

### 文件系统操作 — filesystem server

使用 `npx` 启动文件系统服务器，允许 AI 读写指定目录的文件：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/你的用户名/Documents"
      ]
    }
  }
}
```

::: warning 安全提示
文件系统服务器会授予 AI 对指定目录的读写权限。请只暴露必要的目录路径，避免将根目录或敏感目录暴露给模型。
:::

### 远程 SSE 服务器

连接远程部署的 MCP 服务器：

```json
{
  "mcpServers": {
    "remote-tools": {
      "type": "sse",
      "url": "https://mcp.example.com/sse"
    }
  }
}
```

### 自定义 Stdio 服务器（带环境变量）

运行自定义的 MCP 服务器，通过环境变量传递配置：

```json
{
  "mcpServers": {
    "custom-tool": {
      "command": "python",
      "args": ["/path/to/your/server.py"],
      "env": {
        "DATABASE_URL": "postgres://localhost:5432/mydb",
        "API_TOKEN": "your-token"
      }
    }
  }
}
```

## 内置工具

AQBot 开箱即用地提供了一些内置 MCP 工具服务器，无需额外安装：

### @aqbot/fetch — 网页抓取

| 工具 | 说明 |
|------|------|
| `fetch_url` | 抓取指定 URL 的页面内容，提取文本 |
| `fetch_markdown` | 抓取指定 URL 并转换为 Markdown 格式 |

### @aqbot/search-file — 文件操作

| 工具 | 说明 |
|------|------|
| `read_file` | 读取指定路径的文件内容 |
| `list_directory` | 列出指定目录下的文件和文件夹 |
| `search_files` | 按模式搜索匹配的文件 |

::: tip
内置工具服务器在 MCP 服务器列表中默认显示，可以直接在对话中启用使用，无需任何额外配置。
:::

普通 Chat 的 MCP 链路不会执行终端命令。本地 Shell 由对话内的 Agent 模式提供：切换后使用已有的审批卡片、起始工作目录、超时和取消。所选工作目录只是进程起始 CWD，不是文件系统沙箱。Agent 模式也不会注入当前对话勾选的 MCP 服务器。

## 工具循环上限

在 设置 -> 对话 中，MCP 工具调用最大轮次 用于限制单次回复中模型连续调用工具的轮数。较低数值可减少耗时和成本，较高数值适合更长的自动化工具流程。

## 工具执行面板

当模型在对话中调用 MCP 工具时，AQBot 会在消息中显示工具执行面板，其中包含：

- **工具名称** — 被调用的工具和所属服务器
- **输入参数** — 模型传给工具的参数
- **执行状态** — 等待确认、执行中、已完成或失败
- **返回结果** — 工具执行后返回的数据

点击面板可以展开查看完整的输入和输出信息，方便调试和了解 AI 的工具使用行为。
