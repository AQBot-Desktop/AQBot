# MCP サーバー

## MCP とは？

[Model Context Protocol（MCP）](https://modelcontextprotocol.io/)は、AI モデルが外部ツールやデータソースと対話できるようにするオープンスタンダードです。AQBot は MCP クライアントとして機能します — MCP サーバーを追加すると、AI は会話中にそのサーバーが公開するツールを呼び出せます。

---

## トランスポートプロトコル

AQBot は MCP サーバーとの通信に 3 つのトランスポートプロトコルをサポートしています：

| プロトコル | 接続 | ユースケース | 設定 |
|-----------|------|------------|------|
| **Stdio** | ローカルプロセス | `npx`、`uvx`、`python` などで起動するマシン上にインストールされたツール | `command` + `args` + オプション `env` |
| **SSE** | リモートサーバー | リモートマシンまたはクラウドサービスでホストされる Server-Sent Events エンドポイント | `url` |
| **StreamableHTTP** | リモートサーバー | HTTP ストリーミングエンドポイント（SSE の新しい代替） | `url` |

---

## MCP サーバーの追加

### フォームで作成

1. **設定 → MCP サーバー**に移動します。
2. **MCP サーバーを追加**をクリックします。
3. 名前を入力してトランスポートプロトコルを選択します。
4. 選択したプロトコルのフィールドを入力します：
   - **Stdio** — 実行するコマンド、引数（JSON 配列）、環境変数（JSON オブジェクト）、タイムアウト。
   - **SSE** — エンドポイント URL、タイムアウト。
   - **StreamableHTTP** — エンドポイント URL、タイムアウト。
5. **保存**をクリックします。

### JSON インポート

**JSON インポート**をクリックして設定オブジェクトを貼り付けます。AQBot は標準の MCP JSON 形式を受け入れます：

#### Stdio サーバー

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

#### SSE サーバー

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

#### StreamableHTTP サーバー

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

#### 複数のサーバーを一度に

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

## 設定例

### ウェブフェッチ — `mcp-server-fetch`

ウェブページを取得して AI のために読みやすいテキストに変換します。

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

### ファイル操作 — `@modelcontextprotocol/server-filesystem`

AI にマシン上の特定のディレクトリへの読み書きアクセスを与えます。

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

### リモート SSE サーバー

Server-Sent Events を介してリモートツールサーバーに接続します。

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

### 環境変数付き Stdio

環境変数を介して API キーや設定をサーバープロセスに渡します。

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

## ビルトインツール

AQBot には、外部 MCP サーバーを追加せずに使用できるビルトインツールが付属しています：

| ツール | 説明 |
|--------|------|
| **@aqbot/fetch** | ウェブページと HTTP リソースの取得 |
| **@aqbot/search-file** | ローカルファイルシステムでのファイル検索 |

ビルトインツールは、カスタムサーバーと並んで MCP サーバー設定に一覧表示され、個別に有効化・無効化できます。

---

## ツール実行パネル

AI が会話中に MCP ツールを呼び出すと、AQBot はチャット内にインラインで**ツール実行パネル**を表示します。パネルには以下が表示されます：

- **ツール名**とそれが属する**サーバー**。
- ツールに送信された**入力引数**。
- ツールによって返された**出力**。
- 実行ステータス（実行中、成功、または失敗）。

会話内の任意のツール呼び出しをクリックして詳細を展開します。これにより、AI が何をしたかを確認し、予期しない結果をデバッグするのが簡単になります。

---

## ツールループ上限

Settings -> MCP で、MCP 対応応答が連続して実行できるツール呼び出し回数の上限を設定できます。未知のサーバーを試すときは低めに、複数ツールを意図的に連鎖させるワークフローでは高めに設定できます。

## 次のステップ

- [API ゲートウェイ](./gateway) — プロバイダーをローカル API サーバーとして公開
- [クイックスタート](./getting-started) — クイックスタートガイドに戻る
