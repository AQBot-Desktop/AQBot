[简体中文](./README.md) | [繁體中文](./README-ZH-TW.md) | [English](./README-EN.md) | **日本語** | [한국어](./README-KO.md) | [Français](./README-FR.md) | [Deutsch](./README-DE.md) | [Español](./README-ES.md) | [Русский](./README-RU.md) | [हिन्दी](./README-HI.md) | [العربية](./README-AR.md)

[![AQBot](https://socialify.git.ci/AQBot-Desktop/AQBot/image?description=1&font=JetBrains+Mono&forks=1&issues=1&logo=https%3A%2F%2Fgithub.com%2FAQBot-Desktop%2FAQBot%2Fblob%2Fmain%2Fsrc%2Fassets%2Fimage%2Flogo.png%3Fraw%3Dtrue&name=1&owner=1&pattern=Floating+Cogs&pulls=1&stargazers=1&theme=Auto)](https://github.com/AQBot-Desktop/AQBot)

<p align="center">
    <a href="https://www.producthunt.com/products/aqbot?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-aqbot" target="_blank" rel="noopener noreferrer"><img alt="AQBot - Lightweight, high-perf cross-platform AI desktop client | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1118403&amp;theme=light&amp;t=1775627359538"></a>
</p>

## スクリーンショット

| チャットチャートレンダリング | プロバイダーとモデル |
|:---:|:---:|
| ![](.github/images/s1.png) | ![](.github/images/s2.png) |

| ナレッジベース | メモリー |
|:---:|:---:|
| ![](.github/images/s3.png) | ![](.github/images/s4.png) |

| Agent - 質問 | APIゲートウェイ ワンクリック接続 |
|:---:|:---:|
| ![](.github/images/s5.png) | ![](.github/images/s6.png) |

| チャットモデル選択 | チャットナビゲーション |
|:---:|:---:|
| ![](.github/images/s7.png) | ![](.github/images/s8.png) |

| Agent - 権限承認 | APIゲートウェイ概要 |
|:---:|:---:|
| ![](.github/images/s9.png) | ![](.github/images/s10.png) |

## 機能一覧

### チャットとモデル

- **マルチプロバイダー対応** — OpenAI、Anthropic Claude、Google Gemini、およびすべての OpenAI 互換 API に対応
- **モデル管理** — リモートモデルリストの取得、パラメーター（温度、最大トークン数、Top-P など）のカスタマイズ
- **マルチキーローテーション** — プロバイダーごとに複数の API キーを設定し、レートリミットの圧力を分散するために自動ローテーション
- **ストリーミング出力** — リアルタイムのトークン単位レンダリング、thinking ブロックの折りたたみ表示
- **メッセージバージョン** — 各メッセージで複数の応答バージョンを切り替え、モデルやパラメーターの効果を比較
- **会話ブランチ** — 任意のメッセージノードから新しいブランチを作成、ブランチ間の並列比較をサポート
- **会話管理** — ピン留め、アーカイブ、時系列グループ表示、一括操作
- **会話圧縮** — 長い会話を自動的に圧縮し、重要な情報を保持しながらコンテキストスペースを節約
- **マルチモデル同時応答** — 同じ質問を複数のモデルに同時に送信し、回答を並べて比較

### AI Agent

- **Agent モード** — Agent モードに切り替えて、マルチステップタスクの自律実行が可能：ファイルの読み書き、コマンド実行、コード分析など
- **3段階の権限** — デフォルト（書き込みに承認が必要）、編集を許可（ファイル変更を自動承認）、フルアクセス（プロンプトなし） — 安全で制御可能
- **作業ディレクトリサンドボックス** — Agent の操作は指定された作業ディレクトリに厳密に制限され、不正アクセスを防止
- **ツール承認パネル** — ツールコールリクエストのリアルタイム表示、個別レビュー、ワンクリック「常に許可」、または拒否
- **コスト追跡** — セッションごとのリアルタイムトークン使用量とコスト統計

### コンテンツレンダリング

- **Markdown レンダリング** — コードハイライト、LaTeX 数式、テーブル、タスクリストの完全サポート
- **Monaco コードエディタ** — コードブロックに Monaco Editor を内蔵、シンタックスハイライト・コピー・diff プレビューをサポート
- **ダイアグラムレンダリング** — Mermaid フローチャートと D2 アーキテクチャ図のレンダリングを内蔵
- **Artifact パネル** — コードスニペット、HTML ドラフト、Markdown ノート、レポートを専用パネルで表示
- **リアルタイム音声チャット** — (近日公開) WebRTC ベースのリアルタイム音声、OpenAI Realtime API 対応

### 検索とナレッジ

- **Web 検索** — Tavily、Zhipu WebSearch、Bocha などと統合、引用ソースのアノテーション付き
- **ローカルナレッジベース（RAG）** — 複数のナレッジベースをサポート、ドキュメントをアップロードすると自動解析・チャンク分割・インデックス構築し、会話中に関連段落をセマンティック検索
- **メモリーシステム** — マルチネームスペース会話メモリーをサポート、手動入力または AI 自動抽出（自動抽出は近日公開）
- **コンテキスト管理** — ファイル添付、検索結果、ナレッジベースの段落、メモリーエントリ、ツール出力を柔軟に添付

### ツールと拡張機能

- **MCP プロトコル** — stdio と HTTP トランスポートの両方をサポートする完全な Model Context Protocol 実装
- **組み込みツール** — `@aqbot/fetch` など、すぐに使える組み込み MCP ツールを提供
- **ツール実行パネル** — ツール呼び出しリクエストと返り値の結果をビジュアル表示

### API ゲートウェイ

- **ローカル API ゲートウェイ** — OpenAI 互換、Claude、Gemini インターフェースをネイティブサポートする組み込みローカル API サーバー、任意の互換クライアントのバックエンドとして使用可能
- **API キー管理** — アクセスキーの生成、失効、有効化/無効化、説明メモのサポート
- **使用状況分析** — キー、プロバイダー、日付ごとのリクエスト数とトークン使用量の分析
- **SSL/TLS サポート** — 自己署名証明書の生成を内蔵、カスタム証明書のサポート
- **リクエストログ** — ゲートウェイを通過するすべての API リクエストと応答の完全な記録
- **設定テンプレート** — Claude、Codex、OpenCode、Gemini などの人気 CLI ツール向けの統合テンプレートをプリセット

### データとセキュリティ

- **AES-256 暗号化** — API キーなどの機密データは AES-256 でローカルに暗号化、マスターキーは 0600 権限で保存
- **データディレクトリ分離** — アプリケーション状態は `~/.aqbot/`、ユーザーファイルは `~/Documents/aqbot/` に保存
- **自動バックアップ** — ローカルディレクトリまたは WebDAV ストレージへの定期自動バックアップ
- **バックアップ復元** — 過去のバックアップからワンクリックで完全復元
- **会話エクスポート** — PNG スクリーンショット、Markdown、プレーンテキスト、JSON 形式で会話をエクスポート

### デスクトップ体験

- **テーマ切り替え** — システム設定に追従するか手動設定できるダーク/ライトテーマ
- **インターフェース言語** — 簡体字中国語、繁体字中国語、英語、日本語、韓国語、フランス語、ドイツ語、スペイン語、ロシア語、ヒンディー語、アラビア語を完全サポート、設定でいつでも切り替え可能
- **システムトレイ** — ウィンドウを閉じるとシステムトレイに最小化、バックグラウンドサービスを中断しない
- **常に最前面** — メインウィンドウをすべてのウィンドウの前面に固定
- **グローバルショートカット** — カスタマイズ可能なグローバルキーボードショートカットでいつでもメインウィンドウを呼び出し
- **自動起動** — システム起動時の自動起動をオプションで設定
- **プロキシサポート** — HTTP および SOCKS5 プロキシ設定
- **自動更新** — 起動時に新バージョンを自動確認してアップデートを促す

## プラットフォームサポート

| プラットフォーム | アーキテクチャ |
|-----------------|---------------|
| macOS | Apple Silicon (arm64), Intel (x86_64) |
| Windows 10/11 | x86_64, arm64 |
| Linux | x86_64 (AppImage/deb/rpm), arm64 (AppImage/deb/rpm) |

## はじめに

[Releases](https://github.com/AQBot-Desktop/AQBot/releases) ページにアクセスして、お使いのプラットフォーム向けのインストーラーをダウンロードしてください。

## よくある質問

### macOS：「アプリが壊れています」または「開発元を確認できません」

アプリケーションが Apple によって署名されていないため、macOS は次のいずれかのプロンプトを表示する場合があります：

- 「AQBot」は壊れているため開けません
- 悪意のあるソフトウェアがないか確認できないため、「AQBot」を開けません

**解決手順：**

**1. 「すべてのアプリケーションを許可」する**

```bash
sudo spctl --master-disable
```

次に **「システム設定 → プライバシーとセキュリティ → セキュリティ」** に移動し、**「すべてのアプリケーションを許可」** を選択してください。

**2. 検疫属性を削除する**

```bash
sudo xattr -dr com.apple.quarantine /Applications/AQBot.app
```

> ヒント：ターミナルに `sudo xattr -dr com.apple.quarantine ` と入力した後、アプリアイコンをドラッグ＆ドロップできます。

**3. macOS Ventura 以降の追加手順**

上記の手順を完了した後も、初回起動時にブロックされる場合があります。**「システム設定 → プライバシーとセキュリティ」** に移動し、セキュリティセクションの **「このまま開く」** をクリックしてください。この操作は一度だけ必要です。

## コミュニティ
- [LinuxDO](https://linux.do)

## ライセンス

このプロジェクトは [AGPL-3.0](LICENSE) ライセンスの下でライセンスされています。
