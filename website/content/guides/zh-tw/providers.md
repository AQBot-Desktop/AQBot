# 設定服務供應商

AQBot 支援接入多種 AI 服務供應商，您可以同時設定多個服務供應商並在對話中自由切換。

## 支援的服務供應商

AQBot 內建以下服務供應商類型，並支援任何相容 OpenAI API 格式的自訂端點：

| 服務供應商 | 代表模型 | 說明 |
|-----------|---------|------|
| **OpenAI** | GPT-4o、GPT-4、o3、o4-mini | 最廣泛支援的 API 格式 |
| **Anthropic** | Claude 4 Sonnet/Opus、Claude 3.5 Sonnet | 原生 Claude API |
| **Google** | Gemini 2.5 Pro/Flash、Gemini 2.0 | Google AI Studio 或 Vertex |
| **DeepSeek** | DeepSeek-V3、DeepSeek-R1 | 高性價比推理模型 |
| **阿里雲通義千問** | Qwen-Max、Qwen-Plus、Qwen-Turbo | 相容 OpenAI 格式 |
| **智譜 GLM** | GLM-4、GLM-4-Flash | 國產大模型 |
| **xAI** | Grok-3、Grok-3-mini | xAI 出品 |
| **OpenAI 相容** | 任意模型 | 適配所有相容 OpenAI 格式的第三方服務 |

## 新增服務供應商

### 基本步驟

1. 進入 **設定 → 服務供應商**
2. 點擊左下角的 **+** 按鈕
3. 填寫以下資訊：
   - **名稱** — 自訂名稱，用於在介面中區分不同服務供應商
   - **類型** — 選擇對應的服務供應商類型（如 OpenAI、Anthropic 等）
   - **圖示** — 可選，為服務供應商選擇一個顯示圖示
4. 點擊確認建立

### 設定 API

建立服務供應商後，需要填寫 API 連線資訊：

#### API 金鑰

填入從服務供應商處取得的 API 金鑰。例如 OpenAI 的金鑰格式為 `sk-...`。

::: tip 金鑰安全
AQBot 使用 AES-256 加密儲存所有 API 金鑰，金鑰資料儲存在本機 `~/.aqbot/aqbot.db` 中，不會上傳到任何外部伺服器。
:::

#### Base URL

API 的基礎位址。各服務供應商的官方位址：

| 服務供應商 | 官方 Base URL |
|-----------|--------------|
| OpenAI | `https://api.openai.com` |
| Anthropic | `https://api.anthropic.com` |
| Google | `https://generativelanguage.googleapis.com` |
| DeepSeek | `https://api.deepseek.com` |
| 阿里雲通義 | `https://dashscope.aliyuncs.com/compatible-mode` |
| 智譜 GLM | `https://open.bigmodel.cn` |
| xAI | `https://api.x.ai` |

如果您使用第三方中繼服務或自建代理，將 Base URL 替換為中繼位址即可。

#### API 路徑

API 請求的路徑部分，預設為 `/v1/chat/completions`。一般情況下無需修改，除非服務供應商使用了非標準路徑。

## 從網頁連結匯入服務供應商

服務供應商官網、中繼服務後台、私有模型平台或本機閘道頁面，可以提供一個 **在 AQBot 中開啟** 的連結。使用者點擊後，瀏覽器會喚起 AQBot 桌面端，AQBot 會進入 **設定 → 服務供應商**，顯示確認視窗，並在使用者確認後匯入服務供應商設定。

### 使用流程

1. 安裝並開啟支援服務供應商連結匯入的 AQBot 版本。
2. 在瀏覽器中點擊服務頁面提供的 **在 AQBot 中開啟** 連結。
3. 在 AQBot 確認視窗中檢查服務供應商名稱、Base URL、服務供應商類型和 API Key 前綴。
4. 確認後，AQBot 會按 **Base URL + 類型** 重用既有服務供應商；如果不存在則建立新服務供應商，並在金鑰不存在時追加 API Key。

AQBot 不會自動驗證 API Key，也不會自動同步模型清單。匯入後可點擊 **取得模型**，或手動新增模型 ID。

### 連結格式

```text
aqbot://providers?name=<name>&baseurl=<base-url>&apikey=<api-key>&type=<provider-type>
```

範例：

```text
aqbot://providers?name=OpenAI&baseurl=https%3A%2F%2Fapi.openai.com&apikey=sk-xxx&type=openai
```

### 參數說明

| 參數 | 必填 | 說明 |
|------|------|------|
| `name` | 是 | 服務供應商顯示名稱，例如 `OpenAI`、`我的中繼服務` |
| `baseurl` | 是 | 服務供應商 Base URL，需 URL 編碼；僅允許 `http` / `https`，不允許 query 或 hash |
| `apikey` | 是 | 要儲存到 AQBot 的 API Key；確認視窗只顯示前綴，不顯示完整金鑰 |
| `type` | 是 | 服務供應商類型；可選值：`openai`、`openai_responses`、`anthropic`、`gemini`、`custom` |

`baseurl` 支援 AQBot 既有的強制後綴語義，例如 `https://example.com!`。透過連結匯入時不會設定 `api_path`，AQBot 會繼續按所選服務供應商類型使用預設路徑邏輯。

### 官網/後台頁面如何設定連結

對所有動態值使用 `encodeURIComponent` 或 `URLSearchParams` 進行編碼：

```html
<a id="open-aqbot" href="#">在 AQBot 中開啟</a>

<script>
  const provider = {
    name: '我的中繼服務',
    baseurl: 'https://api.example.com',
    apikey: 'sk-user-key',
    type: 'openai',
  };

  const params = new URLSearchParams({
    name: provider.name,
    baseurl: provider.baseurl,
    apikey: provider.apikey,
    type: provider.type,
  });

  document.getElementById('open-aqbot').href = `aqbot://providers?${params.toString()}`;
</script>
```

如果您的服務支援線上產生 API Key，建議只在使用者登入後，且明確選擇或建立金鑰後再產生此連結。

::: warning 安全提醒
URL 中攜帶 API Key 可能被瀏覽器歷史、日誌、瀏覽器擴充套件或統計腳本記錄。不要把真實金鑰寫在公開頁面、靜態 HTML 或第三方跳轉連結中；建議在使用者私有後台頁面中按需產生，並讓使用者主動點擊。
:::

::: tip 測試提示
`aqbot://` 是桌面應用註冊到系統的自訂協定。僅執行官網或 Vite 開發服務不會註冊協定；如果點擊後沒有喚起 AQBot，請先安裝或重新建置最新 AQBot 桌面端。
:::

## 從 CC Switch 匯入

在 設定 -> 服務供應商 中，AQBot 可以掃描 CC Switch 的服務供應商設定。你可以逐條檢查候選項，選擇可匯入記錄後，把服務供應商、Base URL、API Key 和模型列表匯入 AQBot。OAuth-only 或沒有可復用金鑰的記錄會被跳過並顯示原因。

## 進階模型請求體

每個模型都可以設定 extra_body，這是一個 JSON 物件，會平鋪追加到 OpenAI 相容 Chat Completions 請求體中。它適合 enable_thinking 等廠商私有參數。AQBot 會校驗 JSON，並阻止覆蓋 model、messages、stream、tools 和基礎採樣欄位。

## 多金鑰輪詢

AQBot 支援為同一個服務供應商設定多個 API 金鑰，實現自動輪換：

### 新增多個金鑰

在服務供應商設定頁面的 API 金鑰區域，可以新增多個金鑰。所有金鑰共享同一個 Base URL 和設定。

### 自動輪換機制

當設定了多個金鑰時，AQBot 會在每次請求時自動輪換使用不同的金鑰。

### 限流分散

多金鑰輪詢的一個重要用途是分散 API 限流。每個金鑰有獨立的速率配額，使用多個金鑰可以有效提高整體吞吐量，降低單個金鑰觸發限流的概率。

::: tip 適用場景
如果您有團隊共享的多個 API 金鑰，或者單個金鑰的速率限制無法滿足需求，多金鑰輪詢是一個簡單高效的解決方案。
:::

## 模型管理

### 遠端拉取模型清單

點擊 **取得模型** 按鈕，AQBot 會呼叫服務供應商的模型清單 API，自動拉取目前可用的全部模型。拉取後的模型會顯示在清單中供您選擇。

### 手動新增模型

如果服務供應商的模型清單 API 不完整或您需要新增特定模型，可以手動輸入模型 ID 進行新增。例如：

- `gpt-4o`
- `claude-sonnet-4-20250514`
- `gemini-2.5-pro`

### 模型參數

每個模型可以獨立設定以下預設參數：

| 參數 | 說明 | 典型範圍 |
|-----|------|---------|
| **溫度 (Temperature)** | 控制輸出的隨機性，值越高越有創意 | 0 – 2 |
| **最大 Token (Max Tokens)** | 限制單次回覆的最大長度 | 1 – 模型上限 |
| **Top-P** | 核採樣概率閾值，與溫度配合使用 | 0 – 1 |
| **頻率懲罰 (Frequency Penalty)** | 降低已出現詞彙的重複概率 | -2 – 2 |
| **存在懲罰 (Presence Penalty)** | 鼓勵模型討論新話題 | -2 – 2 |

::: info 參數建議
對於日常對話，保持預設參數即可。如果需要更有創意的輸出，可以適當提高溫度；需要精確回答時，降低溫度到 0–0.3。
:::

## 自訂/本機端點

AQBot 支援連接任何相容 OpenAI API 格式的服務，以下是常見場景的設定範例。

### Ollama

[Ollama](https://ollama.ai/) 可以在本機執行開源大模型。設定方法：

1. 新增服務供應商，類型選擇 **OpenAI**
2. Base URL 填寫 `http://localhost:11434`
3. API 金鑰留空或填寫任意值
4. 點擊 **取得模型** 拉取本機已下載的模型

::: warning 注意
請確保 Ollama 服務已啟動。部分 Ollama 版本可能需要設定 `OLLAMA_ORIGINS=*` 環境變數以允許跨域請求。
:::

### vLLM / TGI

如果您使用 vLLM 或 Text Generation Inference 部署了自己的模型：

1. 新增服務供應商，類型選擇 **OpenAI**
2. Base URL 填寫您的部署位址，如 `http://your-server:8000`
3. API 金鑰根據您的服務設定填寫
4. 手動新增您部署的模型 ID

### API 中繼服務

很多第三方提供 OpenAI 相容的 API 中繼服務，設定方法相同：

1. 新增服務供應商，類型選擇 **OpenAI**
2. Base URL 填寫中繼服務提供的位址
3. API 金鑰填寫中繼服務提供的金鑰
4. 取得或手動新增模型

## 預設模型設定

AQBot 支援為不同用途設定預設模型，在 **設定 → 預設模型** 中設定：

### 全域預設助手模型

新建對話時自動使用的模型。建議選擇您最常用的模型，例如 `gpt-4o` 或 `claude-sonnet-4-20250514`。

### 預設話題命名模型

用於自動為對話生成標題的模型。這個模型不需要很強大，選擇一個回應快且便宜的模型即可，如 `gpt-4o-mini` 或 `gemini-2.0-flash`。

::: tip
預設模型設定是可選的。如果不設定，每次新建對話時需要手動選擇模型。
:::
