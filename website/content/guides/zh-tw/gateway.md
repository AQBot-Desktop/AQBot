# API 閘道

## 什麼是 API 閘道？

AQBot 內建了一個本機 API 閘道伺服器，可以將您在 AQBot 中設定的 AI 服務供應商統一暴露為標準 API 介面。其他工具和客戶端（如 Claude Code、Codex CLI、Cursor 等）可以透過這個閘道存取您的所有模型，無需為每個工具分別設定 API 金鑰。

閘道支援以下相容格式：

- **OpenAI 相容** — `/v1/chat/completions`
- **Claude 原生** — Anthropic API 格式
- **Gemini 原生** — Google AI API 格式

::: tip 使用場景
如果您已經在 AQBot 中設定了多個服務供應商和金鑰，API 閘道可以讓其他開發工具直接復用這些設定，省去重複設定的麻煩。同時，閘道提供統一的用量統計和存取控制。
:::

## 快速上手

### 啟用閘道

1. 進入 **設定 → API 閘道**
2. 開啟閘道開關
3. 設定監聽參數：
   - **連接埠** — 閘道監聽的連接埠號，預設 `8080`
   - **主機** — 監聽位址，預設 `127.0.0.1`（僅本機存取）

::: warning 網路安全
如果將主機設定為 `0.0.0.0`，閘道將對所有網路介面開放。請確保您了解其安全風險，並配合 API 金鑰和防火牆使用。
:::

### 測試連通性

閘道啟動後，可以用 `curl` 快速驗證：

```bash
curl http://127.0.0.1:8080/v1/models \
  -H "Authorization: Bearer your-gateway-api-key"
```

如果回傳了模型清單，說明閘道執行正常。

## API 金鑰管理

閘道使用獨立的 API 金鑰體系來控制存取權限。

### 產生新金鑰

1. 在 **API 閘道** 頁面中找到 **金鑰管理** 區域
2. 點擊 **產生金鑰**
3. 為金鑰新增描述備注（如「Claude Code 專用」、「團隊共享」）
4. 複製並妥善儲存產生的金鑰

::: danger 金鑰安全
金鑰僅在建立時完整顯示一次。請立即複製儲存，之後只能看到金鑰前綴。
:::

### 撤銷 / 停用金鑰

- **停用** — 暫時停用金鑰，可隨時重新啟用
- **刪除** — 永久撤銷金鑰，使用該金鑰的所有客戶端將立即失去存取權限

### 描述備注

為每個金鑰新增描述可以幫助您管理多個客戶端的存取。例如區分不同工具或團隊成員使用的金鑰。

## SSL/TLS

閘道支援 HTTPS 加密通訊，部分工具（如 Claude Code）要求使用 HTTPS 連線。

### 自動自簽憑證

啟用 SSL 後，AQBot 會自動產生自簽憑證，無需手動操作。憑證檔案儲存在：

```
~/.aqbot/ssl/
├── cert.pem    # 自簽憑證
└── key.pem     # 私鑰（Unix 系統權限 0600）
```

### 自訂憑證

如果您有自己的 SSL 憑證（如 Let's Encrypt 簽發的憑證），可以在閘道設定中指定憑證和私鑰的路徑。

### 設定選項

| 選項 | 說明 |
|------|------|
| 啟用 SSL | 是否開啟 HTTPS |
| SSL 連接埠 | HTTPS 監聽連接埠 |
| 憑證路徑 | cert.pem 檔案路徑 |
| 私鑰路徑 | key.pem 檔案路徑 |
| 強制 SSL | 是否將所有 HTTP 請求重新導向到 HTTPS |

::: info 自簽憑證信任
使用自簽憑證時，客戶端可能會回報憑證不受信任的警告。大部分 CLI 工具可以透過設定環境變數來跳過憑證驗證（見下方設定範本）。
:::

## 用量統計

閘道提供詳細的用量統計面板，幫助您了解 API 的使用情況。

### 請求量面板

即時顯示閘道處理的請求總量、成功率和錯誤率。

### Token 用量

依不同維度查看 Token 消耗：

- **依金鑰** — 每個 API 金鑰使用了多少 Token
- **依服務供應商** — 每個後端服務供應商處理了多少請求和 Token
- **依日期** — 每日的 Token 使用趨勢

::: tip
透過用量統計，您可以了解哪個工具消耗最多資源，合理分配 API 配額。
:::

## 請求日誌

閘道記錄所有經過它的 API 請求，方便除錯和稽核。

每條日誌包含以下資訊：

| 欄位 | 說明 |
|------|------|
| 時間 | 請求的時間戳記 |
| 方法 | HTTP 方法（GET、POST 等） |
| 路徑 | 請求路徑 |
| 模型 | 請求使用的模型 |
| 服務供應商 | 轉發到的後端服務供應商 |
| 狀態碼 | HTTP 回應狀態碼 |
| Token | 輸入/輸出 Token 數量 |
| 延遲 | 請求處理耗時 |

支援依時間範圍、狀態碼、模型等條件篩選日誌。

## 設定範本

AQBot 內建了常見開發工具的設定範本，幫助您快速接入。以下是一些常用工具的設定方式：

### Claude Code CLI

```bash
export ANTHROPIC_BASE_URL=https://127.0.0.1:8443
export ANTHROPIC_API_KEY=your-gateway-api-key
export NODE_TLS_REJECT_UNAUTHORIZED=0

claude
```

::: tip
`NODE_TLS_REJECT_UNAUTHORIZED=0` 用於跳過自簽憑證驗證。如果您使用了受信任的憑證，可以移除此設定。
:::

### OpenAI Codex CLI

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=your-gateway-api-key

codex
```

### OpenCode

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=your-gateway-api-key

opencode
```

### Gemini CLI

```bash
export GEMINI_API_KEY=your-gateway-api-key
export GEMINI_BASE_URL=http://127.0.0.1:8080

gemini
```

### 自訂客戶端

對於任何支援 OpenAI 相容 API 的客戶端，使用以下設定：

- **Base URL**: `http://127.0.0.1:8080/v1`
- **API Key**: 您的閘道 API 金鑰
- **模型**: 透過 `/v1/models` 介面查詢可用模型

## 接入外部工具

除 CLI 工具外，許多圖形化工具也支援自訂 API 端點。通用設定方式：

1. 在工具的設定中找到 API 設定或自訂端點選項
2. 將 Base URL 設定為 AQBot 閘道位址
3. 將 API Key 設定為閘道金鑰
4. 儲存後即可使用 AQBot 設定的所有模型

::: tip 統一管理的優勢
透過 API 閘道統一管理，您可以：
- 在 AQBot 中集中管理所有服務供應商金鑰，其他工具只需一個閘道金鑰
- 在用量統計中查看所有工具的使用情況
- 利用多金鑰輪詢提高可靠性
:::
