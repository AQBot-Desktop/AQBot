[简体中文](./README.md) | **繁體中文** | [English](./README-EN.md) | [日本語](./README-JA.md) | [한국어](./README-KO.md) | [Français](./README-FR.md) | [Deutsch](./README-DE.md) | [Español](./README-ES.md) | [Русский](./README-RU.md) | [हिन्दी](./README-HI.md) | [العربية](./README-AR.md)

[![AQBot](https://socialify.git.ci/AQBot-Desktop/AQBot/image?description=1&font=JetBrains+Mono&forks=1&issues=1&logo=https%3A%2F%2Fgithub.com%2FAQBot-Desktop%2FAQBot%2Fblob%2Fmain%2Fsrc%2Fassets%2Fimage%2Flogo.png%3Fraw%3Dtrue&name=1&owner=1&pattern=Floating+Cogs&pulls=1&stargazers=1&theme=Auto)](https://github.com/AQBot-Desktop/AQBot)

<p align="center">
    <a href="https://www.producthunt.com/products/aqbot?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-aqbot" target="_blank" rel="noopener noreferrer"><img alt="AQBot - Lightweight, high-perf cross-platform AI desktop client | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1118403&amp;theme=light&amp;t=1775627359538"></a>
</p>

## 執行截圖

| 對話圖表渲染 | 服務商與模型 |
|:---:|:---:|
| ![](.github/images/s1.png) | ![](.github/images/s2.png) |

| 知識庫 | 記憶 |
|:---:|:---:|
| ![](.github/images/s3.png) | ![](.github/images/s4.png) |

| Agent-詢問 | API閘道一鍵接入 |
|:---:|:---:|
| ![](.github/images/s5.png) | ![](.github/images/s6.png) |

| 對話模型選擇 | 對話導航 |
|:---:|:---:|
| ![](.github/images/s7.png) | ![](.github/images/s8.png) |

| Agent-權限審批 | API閘道概覽 |
|:---:|:---:|
| ![](.github/images/s9.png) | ![](.github/images/s10.png) |

## 功能特性

### 對話與模型

- **多供應商支援** — 相容 OpenAI、Anthropic Claude、Google Gemini 等所有 OpenAI 相容 API
- **模型管理** — 支援遠端拉取模型列表、自訂參數（溫度、最大 Token、Top-P 等）
- **多金鑰輪詢** — 每個供應商可設定多個 API Key，自動輪換以分散限流壓力
- **串流輸出** — 即時逐 Token 渲染，thinking 區塊可折疊展開
- **訊息版本** — 每條回覆支援多版本切換，方便對比不同模型或參數的效果
- **對話分支** — 從任意訊息節點派生新分支，支援分支間對比
- **對話管理** — 支援置頂、封存、按時間分組、批次操作
- **對話壓縮** — 自動壓縮冗長對話，保留關鍵資訊以節省上下文空間
- **多模型同答案** — 同一問題同時向多個模型提問，支援答案間對比分析

### AI Agent

- **Agent 模式** — 切換至 Agent 模式，AI 可自主執行多步驟任務：讀寫檔案、執行命令、分析程式碼等
- **三級權限** — 預設模式（寫入需審批）、接受編輯（自動批准修改）、完全存取（無提示），安全可控
- **工作目錄沙箱** — Agent 操作嚴格限制在指定工作目錄內，防止越權存取
- **工具審批面板** — 即時展示工具呼叫請求，支援逐條審核、一鍵始終允許或拒絕
- **成本追蹤** — 每次對話即時統計 Token 用量與費用

### 內容渲染

- **Markdown 渲染** — 完整支援程式碼高亮、LaTeX 數學公式、表格、任務清單
- **Monaco 程式碼編輯器** — 程式碼區塊內嵌 Monaco Editor，支援語法高亮、複製、diff 預覽
- **圖表渲染** — 內建 Mermaid 流程圖與 D2 架構圖渲染
- **Artifact 面板** — 程式碼片段、HTML 草稿、Markdown 筆記、報告可在獨立面板中預覽
- **即時語音對話** — (即將推出) 基於 WebRTC 的即時語音，相容 OpenAI Realtime API

### 搜尋與知識

- **聯網搜尋** — 整合 Tavily、智譜 WebSearch、Bocha 等，搜尋結果附帶引用來源標注
- **本地知識庫（RAG）** — 支援多知識庫，上傳文件後自動解析分段並建立索引，對話時語意檢索相關段落
- **記憶系統** — 支援對話多命名空間記憶，可手動新增或由 AI 自動提取（AI 自動提取部分即將支援）
- **上下文管理** — 彈性掛載檔案附件、搜尋結果、知識庫片段、記憶條目、工具輸出

### 工具與擴充

- **MCP 協議** — 完整實作 Model Context Protocol，支援 stdio 和 HTTP 兩種傳輸方式
- **內建工具** — 提供 `@aqbot/fetch` 等開箱即用的內建 MCP 工具
- **工具執行面板** — 可視化展示工具呼叫請求與回傳結果

### API 閘道

- **本地 API 閘道** — 內建 OpenAI 相容、Claude、Gemini 等原生介面的本地 API 伺服器，可作為任意相容用戶端的後端
- **API 金鑰管理** — 產生、撤銷、啟停存取金鑰，支援描述備注
- **用量統計** — 依金鑰、供應商、日期維度的請求量與 Token 用量分析
- **SSL/TLS 支援** — 內建自簽憑證產生，也支援掛載自訂憑證
- **請求日誌** — 完整記錄所有經過閘道的 API 請求與回應
- **設定範本** — 預置 Claude、Codex、OpenCode、Gemini 等常見 CLI 工具的接入設定範本

### 資料與安全

- **AES-256 加密** — API Key 等敏感資料使用 AES-256 加密存儲於本地，主金鑰權限 0600
- **資料目錄隔離** — 應用程式狀態存儲於 `~/.aqbot/`，使用者檔案存儲於 `~/Documents/aqbot/`
- **自動備份** — 支援定時自動備份到本地目錄、WebDAV 存儲
- **備份還原** — 一鍵從歷史備份還原完整資料
- **對話匯出** — 支援將對話匯出為 PNG 截圖、Markdown、純文字或 JSON 格式

### 桌面體驗

- **主題切換** — 深色/淺色主題，可跟隨系統或手動指定
- **介面語言** — 完整支援簡體中文、繁體中文、英文、日文、韓文、法文、德文、西班牙文、俄文、印地文與阿拉伯文，可在設定中隨時切換
- **系統托盤** — 關閉視窗時最小化到系統托盤，不中斷後台服務
- **視窗置頂** — 可將主視窗常駐最頂層
- **全局快捷鍵** — 自訂全局快捷鍵，隨時喚起主視窗
- **開機自啟** — 可選擇隨系統自動啟動
- **代理支援** — 支援 HTTP 和 SOCKS5 代理設定
- **自動更新** — 啟動時自動偵測新版本並提示更新

## 平台支援

| 平台 | 架構 |
|------|------|
| macOS | Apple Silicon (arm64), Intel (x86_64) |
| Windows 10/11 | x86_64, arm64 |
| Linux | x86_64 (AppImage/deb/rpm), arm64 (AppImage/deb/rpm) |

## 快速開始

前往 [Releases](https://github.com/AQBot-Desktop/AQBot/releases) 頁面下載適合您平台的安裝包。

## 常見問題

### macOS 提示「已損毀」或「無法驗證開發者」

由於應用程式未經 Apple 簽名，macOS 可能會彈出以下提示之一：

- 「AQBot」已損毀，無法開啟
- 無法開啟「AQBot」，因為無法驗證開發者

**解決步驟：**

**1. 允許「任何來源」的應用程式執行**

```bash
sudo spctl --master-disable
```

執行後前往「系統設定 → 隱私權與安全性 → 安全性」，確認已勾選「任何來源」。

**2. 移除應用程式的安全隔離屬性**

```bash
sudo xattr -dr com.apple.quarantine /Applications/AQBot.app
```

> 如果不確定路徑，可將應用程式圖示拖曳到 `sudo xattr -dr com.apple.quarantine ` 後面。

**3. macOS Ventura 及以上版本的額外步驟**

完成上述步驟後，首次開啟時仍可能被攔截。前往 **「系統設定 → 隱私權與安全性」**，在安全性區域點擊 **「仍要開啟」** 即可，後續無需重複操作。

## 社群支援
- [LinuxDO](https://linux.do)

## 授權條款

本專案採用 [AGPL-3.0](LICENSE) 授權條款。
