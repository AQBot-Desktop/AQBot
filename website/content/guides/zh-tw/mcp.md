# MCP 伺服器

## 什麼是 MCP？

[Model Context Protocol（MCP）](https://modelcontextprotocol.io/)是一種開放協定，讓 AI 模型能夠與外部工具和資料來源互動。透過 MCP，模型可以在對話中呼叫檔案操作、網頁擷取、資料庫查詢等各種工具，大幅擴展 AI 的實際能力。

AQBot 內建了 MCP 客戶端，您可以連接各種 MCP 伺服器來為 AI 對話增加工具呼叫能力。

## 傳輸協定

AQBot 支援三種 MCP 傳輸協定，適用於不同的部署場景：

| 協定 | 連線方式 | 適用場景 | 設定參數 |
|------|---------|---------|---------|
| **Stdio** | 本機子程序 | 透過 `npx`、`uvx`、自訂指令啟動的本機工具 | `command` + `args` |
| **SSE** | Server-Sent Events | 遠端託管的 MCP 伺服器 | `url` |
| **StreamableHTTP** | HTTP 串流傳輸 | 遠端 HTTP 伺服器，支援雙向串流 | `url` |

::: info Stdio vs 遠端
大部分 MCP 伺服器以 Stdio 模式執行——AQBot 在本機啟動一個程序並透過標準輸入/輸出通訊。如果您連接的是遠端部署的伺服器，則使用 SSE 或 StreamableHTTP 協定。
:::

## 新增 MCP 伺服器

### 表單建立

1. 進入 **設定 → MCP 伺服器**
2. 點擊 **新增 MCP 伺服器**
3. 填寫基本資訊：
   - **名稱** — 為伺服器取一個易識別的名稱
   - **傳輸協定** — 選擇 Stdio、SSE 或 StreamableHTTP
4. 根據所選協定填寫相應設定：
   - **Stdio**：填寫啟動指令（如 `npx`、`uvx`）和參數
   - **SSE / StreamableHTTP**：填寫伺服器 URL
5. 儲存後 AQBot 會自動連接並取得可用工具清單

### JSON 匯入

如果您有現成的 MCP 設定（如從其他工具匯出），可以直接貼上 JSON 快速匯入。AQBot 支援標準的 `mcpServers` 設定格式。

#### Stdio 協定格式

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

#### SSE 協定格式

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

#### StreamableHTTP 協定格式

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

::: tip 批次匯入
您可以在一個 JSON 中包含多個伺服器，AQBot 會一次性全部匯入。
:::

## 設定範例

以下是一些常用 MCP 伺服器的設定範例。

### 網頁擷取 — mcp-server-fetch

使用 `uvx` 啟動網頁擷取工具，讓 AI 能夠讀取網頁內容：

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

### 檔案系統操作 — filesystem server

使用 `npx` 啟動檔案系統伺服器，允許 AI 讀寫指定目錄的檔案：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/您的使用者名稱/Documents"
      ]
    }
  }
}
```

::: warning 安全提示
檔案系統伺服器會授予 AI 對指定目錄的讀寫權限。請只暴露必要的目錄路徑，避免將根目錄或敏感目錄暴露給模型。
:::

### 遠端 SSE 伺服器

連接遠端部署的 MCP 伺服器：

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

### 自訂 Stdio 伺服器（帶環境變數）

執行自訂的 MCP 伺服器，透過環境變數傳遞設定：

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

## 內建工具

AQBot 開箱即用地提供了一些內建 MCP 工具伺服器，無需額外安裝：

### @aqbot/fetch — 網頁擷取

| 工具 | 說明 |
|------|------|
| `fetch_url` | 擷取指定 URL 的頁面內容，提取文字 |
| `fetch_markdown` | 擷取指定 URL 並轉換為 Markdown 格式 |

### @aqbot/search-file — 檔案操作

| 工具 | 說明 |
|------|------|
| `read_file` | 讀取指定路徑的檔案內容 |
| `list_directory` | 列出指定目錄下的檔案和資料夾 |
| `search_files` | 依模式搜尋相符的檔案 |

::: tip
內建工具伺服器在 MCP 伺服器清單中預設顯示，可以直接在對話中啟用使用，無需任何額外設定。
:::

## 工具循環上限

在 設定 -> 對話 中，MCP 工具呼叫最大輪次 用於限制單次回覆中模型連續呼叫工具的輪數。較低數值可減少耗時和成本，較高數值適合更長的自動化工具流程。

## 工具執行面板

當模型在對話中呼叫 MCP 工具時，AQBot 會在訊息中顯示工具執行面板，其中包含：

- **工具名稱** — 被呼叫的工具和所屬伺服器
- **輸入參數** — 模型傳給工具的參數
- **執行狀態** — 等待確認、執行中、已完成或失敗
- **回傳結果** — 工具執行後回傳的資料

點擊面板可以展開查看完整的輸入和輸出資訊，方便除錯和了解 AI 的工具使用行為。
