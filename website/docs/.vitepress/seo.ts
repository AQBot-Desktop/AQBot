import type { HeadConfig, PageData } from 'vitepress';
import { SITE_URL } from './theme/constants';

export const OG_IMAGE = `${SITE_URL}/logo.png`;

export type SeoLocale =
  | 'en'
  | 'zh'
  | 'zh-tw'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'de'
  | 'es'
  | 'ru'
  | 'hi'
  | 'ar';

export type PageKind =
  | 'home'
  | 'features'
  | 'download'
  | 'getting-started'
  | 'providers'
  | 'mcp'
  | 'gateway';

interface SeoEntry {
  title?: string;
  isHome?: boolean;
  description: string;
  keywords: string;
}

const LOCALE_PREFIXES: SeoLocale[] = [
  'zh-tw',
  'zh',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'ru',
  'hi',
  'ar',
];

const OG_LOCALE: Record<SeoLocale, string> = {
  en: 'en_US',
  zh: 'zh_CN',
  'zh-tw': 'zh_TW',
  ja: 'ja_JP',
  ko: 'ko_KR',
  fr: 'fr_FR',
  de: 'de_DE',
  es: 'es_ES',
  ru: 'ru_RU',
  hi: 'hi_IN',
  ar: 'ar_SA',
};

const HREFLANG: Record<SeoLocale, string> = {
  en: 'en',
  zh: 'zh-CN',
  'zh-tw': 'zh-TW',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  ru: 'ru',
  hi: 'hi',
  ar: 'ar',
};

const KIND_BY_SLUG: Record<string, PageKind> = {
  '': 'home',
  index: 'home',
  features: 'features',
  download: 'download',
  'guide/getting-started': 'getting-started',
  'guide/providers': 'providers',
  'guide/mcp': 'mcp',
  'guide/gateway': 'gateway',
};

function home(title: string, description: string, keywords: string): SeoEntry {
  return { title, description, keywords, isHome: true };
}

function page(title: string, description: string, keywords: string): SeoEntry {
  return { title, description, keywords };
}

function doc(description: string, keywords: string): SeoEntry {
  return { description, keywords };
}

const SEO: Record<SeoLocale, Record<PageKind, SeoEntry>> = {
  zh: {
    home: home(
      'AQBot — 开源 AI 桌面客户端与网关',
      'AQBot 是免费开源的 AI 桌面客户端，支持多模型对话、角色、Agent、MCP、Skills、本地知识库、备份和内置 AI 网关。',
      'AQBot, AI桌面客户端, AI网关, 多模型对话, MCP, Agent, 本地知识库, OpenAI, Claude, Gemini, DeepSeek, 开源AI',
    ),
    features: page(
      '功能特性',
      '了解 AQBot 的全部功能：多模型对话、本地 API 网关、自主 Agent、MCP、sqlite-vec 知识库、角色市场与本地加密备份。',
      'AQBot功能, 多模型对话, API网关, Agent, MCP, sqlite-vec, 本地知识库, 角色预设, AES-256',
    ),
    download: page(
      '下载',
      '免费下载 AQBot 桌面客户端。支持 macOS（Apple Silicon / Intel）、Windows 与 Linux，内置本地网关与知识库。',
      'AQBot下载, macOS, Windows, Linux, AI客户端安装包, Apple Silicon, 开源AI',
    ),
    'getting-started': doc(
      'AQBot 快速开始：安装桌面客户端、配置服务商、完成首次对话，并了解备份与快捷键。',
      'AQBot教程, 快速开始, 安装指南, 配置服务商, 首次对话',
    ),
    providers: doc(
      '在 AQBot 中配置 OpenAI、Claude、Gemini、DeepSeek、Ollama 等服务商，支持多密钥与自定义端点。',
      'AQBot服务商, OpenAI, Claude, Gemini, DeepSeek, Ollama, API Key',
    ),
    mcp: doc(
      '在 AQBot 中连接 MCP 服务器，为对话接入外部工具、文件系统与数据库。',
      'AQBot MCP, Model Context Protocol, MCP服务器, AI工具调用',
    ),
    gateway: doc(
      '使用 AQBot 内置 API 网关，把已配置模型以 OpenAI / Claude / Gemini 兼容接口提供给开发工具。',
      'AQBot网关, OpenAI兼容, Claude Code, Codex, Cursor, 本地API',
    ),
  },
  'zh-tw': {
    home: home(
      'AQBot — 開源 AI 桌面客戶端與閘道',
      'AQBot 是免費開源的 AI 桌面客戶端，支援多模型對話、角色、Agent、MCP、Skills、本地知識庫、備份與內建 AI 閘道。',
      'AQBot, AI桌面客戶端, AI閘道, 多模型對話, MCP, Agent, 本地知識庫, OpenAI, Claude, Gemini, 開源AI',
    ),
    features: page(
      '功能特性',
      '了解 AQBot 的全部功能：多模型對話、本地 API 閘道、自主 Agent、MCP、sqlite-vec 知識庫、角色市場與本地加密備份。',
      'AQBot功能, 多模型對話, API閘道, Agent, MCP, sqlite-vec, 本地知識庫, AES-256',
    ),
    download: page(
      '下載',
      '免費下載 AQBot 桌面客戶端。支援 macOS（Apple Silicon / Intel）、Windows 與 Linux，內建本地閘道與知識庫。',
      'AQBot下載, macOS, Windows, Linux, AI客戶端安裝包, Apple Silicon',
    ),
    'getting-started': doc(
      'AQBot 快速開始：安裝桌面客戶端、設定服務供應商、完成首次對話，並了解備份與快捷鍵。',
      'AQBot教學, 快速開始, 安裝指南, 設定服務供應商',
    ),
    providers: doc(
      '在 AQBot 中設定 OpenAI、Claude、Gemini、DeepSeek、Ollama 等服務供應商，支援多金鑰與自訂端點。',
      'AQBot服務供應商, OpenAI, Claude, Gemini, DeepSeek, Ollama',
    ),
    mcp: doc(
      '在 AQBot 中連接 MCP 伺服器，為對話接入外部工具、檔案系統與資料庫。',
      'AQBot MCP, Model Context Protocol, MCP伺服器',
    ),
    gateway: doc(
      '使用 AQBot 內建 API 閘道，將已設定模型以 OpenAI / Claude / Gemini 相容介面提供給開發工具。',
      'AQBot閘道, OpenAI相容, Claude Code, Codex, Cursor',
    ),
  },
  en: {
    home: home(
      'AQBot — Open-source AI Desktop Client & Gateway',
      'AQBot is a free open-source AI desktop client with multi-model chat, roles, Agent, MCP, Skills, local knowledge bases, backups, and a built-in AI gateway.',
      'AQBot, AI desktop client, AI gateway, multi-model chat, MCP, Agent, local knowledge base, OpenAI, Claude, Gemini, DeepSeek, open source AI',
    ),
    features: page(
      'Features',
      'Explore AQBot capabilities: multi-model chat, local API gateway, autonomous Agent, MCP, sqlite-vec knowledge base, roles, and encrypted local backups.',
      'AQBot features, multi-model chat, API gateway, Agent, MCP, sqlite-vec, local RAG, AES-256',
    ),
    download: page(
      'Download',
      'Download AQBot for macOS (Apple Silicon and Intel), Windows, and Linux. Free, open-source, with a built-in local gateway.',
      'AQBot download, macOS, Windows, Linux, AI client installer, Apple Silicon, open source',
    ),
    'getting-started': doc(
      'Get started with AQBot: install the desktop app, configure a provider, send your first message, and set up backups.',
      'AQBot tutorial, getting started, install guide, configure providers',
    ),
    providers: doc(
      'Connect OpenAI, Claude, Gemini, DeepSeek, Ollama, and custom endpoints in AQBot, with multi-key rotation.',
      'AQBot providers, OpenAI, Claude, Gemini, DeepSeek, Ollama, API key',
    ),
    mcp: doc(
      'Connect MCP servers in AQBot to give conversations external tools, filesystem access, and databases.',
      'AQBot MCP, Model Context Protocol, MCP servers, AI tools',
    ),
    gateway: doc(
      'Use AQBot’s built-in API gateway to expose configured models as OpenAI, Claude, and Gemini compatible endpoints.',
      'AQBot gateway, OpenAI compatible, Claude Code, Codex, Cursor, local API',
    ),
  },
  ja: {
    home: home(
      'AQBot — オープンソースの AI デスクトップクライアントとゲートウェイ',
      'AQBot は無料オープンソースの AI デスクトップクライアントです。マルチモデルチャット、Agent、MCP、ローカル知識ベース、内蔵 AI ゲートウェイに対応します。',
      'AQBot, AIデスクトップ, AIゲートウェイ, マルチモデル, MCP, Agent, ローカル知識ベース, OpenAI, Claude, Gemini',
    ),
    features: page(
      '機能',
      'AQBot の機能一覧：マルチモデル会話、ローカル API ゲートウェイ、自律 Agent、MCP、sqlite-vec 知識ベース、ロールと暗号化バックアップ。',
      'AQBot機能, マルチモデル, APIゲートウェイ, Agent, MCP, sqlite-vec',
    ),
    download: page(
      'ダウンロード',
      'AQBot を無料ダウンロード。macOS（Apple Silicon / Intel）、Windows、Linux に対応し、ローカルゲートウェイを内蔵しています。',
      'AQBotダウンロード, macOS, Windows, Linux, Apple Silicon',
    ),
    'getting-started': doc(
      'AQBot クイックスタート：インストール、プロバイダー設定、最初の会話、バックアップまで。',
      'AQBotガイド, クイックスタート, インストール, プロバイダー設定',
    ),
    providers: doc(
      'AQBot で OpenAI、Claude、Gemini、DeepSeek、Ollama などを設定。複数キーとカスタムエンドポイントに対応。',
      'AQBotプロバイダー, OpenAI, Claude, Gemini, DeepSeek, Ollama',
    ),
    mcp: doc(
      'AQBot で MCP サーバーを接続し、外部ツールやファイルシステム、データベースを会話に組み込みます。',
      'AQBot MCP, Model Context Protocol, MCPサーバー',
    ),
    gateway: doc(
      'AQBot 内蔵 API ゲートウェイで、設定済みモデルを OpenAI / Claude / Gemini 互換エンドポイントとして公開します。',
      'AQBotゲートウェイ, OpenAI互換, Claude Code, Codex, Cursor',
    ),
  },
  ko: {
    home: home(
      'AQBot — 오픈소스 AI 데스크톱 클라이언트와 게이트웨이',
      'AQBot은 무료 오픈소스 AI 데스크톱 클라이언트입니다. 멀티 모델 채팅, Agent, MCP, 로컬 지식 베이스, 내장 AI 게이트웨이를 제공합니다.',
      'AQBot, AI 데스크톱, AI 게이트웨이, 멀티 모델, MCP, Agent, 로컬 지식 베이스, OpenAI, Claude, Gemini',
    ),
    features: page(
      '기능',
      'AQBot 기능 살펴보기: 멀티 모델 대화, 로컬 API 게이트웨이, 자율 Agent, MCP, sqlite-vec 지식 베이스, 역할과 암호화 백업.',
      'AQBot 기능, 멀티 모델, API 게이트웨이, Agent, MCP, sqlite-vec',
    ),
    download: page(
      '다운로드',
      'AQBot을 무료로 다운로드하세요. macOS(Apple Silicon / Intel), Windows, Linux를 지원하며 로컬 게이트웨이가 내장되어 있습니다.',
      'AQBot 다운로드, macOS, Windows, Linux, Apple Silicon',
    ),
    'getting-started': doc(
      'AQBot 빠른 시작: 설치, 제공업체 설정, 첫 대화, 백업 방법까지.',
      'AQBot 가이드, 빠른 시작, 설치, 제공업체 설정',
    ),
    providers: doc(
      'AQBot에서 OpenAI, Claude, Gemini, DeepSeek, Ollama 등을 설정하고 다중 키와 사용자 지정 엔드포인트를 사용하세요.',
      'AQBot 제공업체, OpenAI, Claude, Gemini, DeepSeek, Ollama',
    ),
    mcp: doc(
      'AQBot에서 MCP 서버를 연결해 대화에 외부 도구, 파일 시스템, 데이터베이스를 추가하세요.',
      'AQBot MCP, Model Context Protocol, MCP 서버',
    ),
    gateway: doc(
      'AQBot 내장 API 게이트웨이로 설정한 모델을 OpenAI / Claude / Gemini 호환 엔드포인트로 제공합니다.',
      'AQBot 게이트웨이, OpenAI 호환, Claude Code, Codex, Cursor',
    ),
  },
  fr: {
    home: home(
      'AQBot — Client de bureau IA open-source et passerelle',
      'AQBot est un client de bureau IA gratuit et open-source : chat multi-modèles, Agent, MCP, base de connaissances locale et passerelle IA intégrée.',
      'AQBot, client IA bureau, passerelle IA, chat multi-modèles, MCP, Agent, OpenAI, Claude, Gemini',
    ),
    features: page(
      'Fonctionnalités',
      'Découvrez AQBot : chat multi-modèles, passerelle API locale, Agent autonome, MCP, base sqlite-vec, rôles et sauvegardes chiffrées.',
      'AQBot fonctionnalités, multi-modèles, passerelle API, Agent, MCP, sqlite-vec',
    ),
    download: page(
      'Télécharger',
      'Téléchargez AQBot gratuitement pour macOS (Apple Silicon / Intel), Windows et Linux, avec passerelle locale intégrée.',
      'AQBot télécharger, macOS, Windows, Linux, Apple Silicon',
    ),
    'getting-started': doc(
      'Démarrage rapide d’AQBot : installation, configuration d’un fournisseur, première conversation et sauvegardes.',
      'AQBot guide, démarrage rapide, installation, fournisseurs',
    ),
    providers: doc(
      'Configurez OpenAI, Claude, Gemini, DeepSeek, Ollama et des points de terminaison personnalisés dans AQBot.',
      'AQBot fournisseurs, OpenAI, Claude, Gemini, DeepSeek, Ollama',
    ),
    mcp: doc(
      'Connectez des serveurs MCP dans AQBot pour ajouter outils, fichiers et bases de données aux conversations.',
      'AQBot MCP, Model Context Protocol, serveurs MCP',
    ),
    gateway: doc(
      'La passerelle API d’AQBot expose vos modèles en endpoints compatibles OpenAI, Claude et Gemini.',
      'AQBot passerelle, compatible OpenAI, Claude Code, Codex, Cursor',
    ),
  },
  de: {
    home: home(
      'AQBot — Open-Source KI-Desktop-Client und Gateway',
      'AQBot ist ein kostenloser Open-Source-KI-Desktop-Client mit Multi-Modell-Chat, Agent, MCP, lokaler Wissensbasis und integriertem KI-Gateway.',
      'AQBot, KI Desktop Client, KI Gateway, Multi-Modell, MCP, Agent, OpenAI, Claude, Gemini',
    ),
    features: page(
      'Funktionen',
      'AQBot im Überblick: Multi-Modell-Chat, lokales API-Gateway, autonomer Agent, MCP, sqlite-vec-Wissensbasis, Rollen und verschlüsselte Backups.',
      'AQBot Funktionen, Multi-Modell, API-Gateway, Agent, MCP, sqlite-vec',
    ),
    download: page(
      'Download',
      'AQBot kostenlos herunterladen für macOS (Apple Silicon / Intel), Windows und Linux, inkl. lokalem Gateway.',
      'AQBot Download, macOS, Windows, Linux, Apple Silicon',
    ),
    'getting-started': doc(
      'AQBot Schnellstart: Installation, Anbieter einrichten, erste Unterhaltung und Backups.',
      'AQBot Anleitung, Schnellstart, Installation, Anbieter',
    ),
    providers: doc(
      'OpenAI, Claude, Gemini, DeepSeek, Ollama und eigene Endpunkte in AQBot konfigurieren.',
      'AQBot Anbieter, OpenAI, Claude, Gemini, DeepSeek, Ollama',
    ),
    mcp: doc(
      'MCP-Server in AQBot verbinden und Tools, Dateisystem und Datenbanken in Gespräche einbinden.',
      'AQBot MCP, Model Context Protocol, MCP-Server',
    ),
    gateway: doc(
      'Das integrierte API-Gateway stellt konfigurierte Modelle als OpenAI-/Claude-/Gemini-kompatible Endpunkte bereit.',
      'AQBot Gateway, OpenAI-kompatibel, Claude Code, Codex, Cursor',
    ),
  },
  es: {
    home: home(
      'AQBot — Cliente de escritorio IA de código abierto y pasarela',
      'AQBot es un cliente de escritorio IA gratuito y de código abierto, con chat multimodelo, Agent, MCP, base de conocimiento local y pasarela IA integrada.',
      'AQBot, cliente IA escritorio, pasarela IA, chat multimodelo, MCP, Agent, OpenAI, Claude, Gemini',
    ),
    features: page(
      'Características',
      'Conoce AQBot: chat multimodelo, pasarela API local, Agent autónomo, MCP, base sqlite-vec, roles y copias cifradas.',
      'AQBot características, multimodelo, pasarela API, Agent, MCP, sqlite-vec',
    ),
    download: page(
      'Descargar',
      'Descarga AQBot gratis para macOS (Apple Silicon / Intel), Windows y Linux, con pasarela local incluida.',
      'AQBot descargar, macOS, Windows, Linux, Apple Silicon',
    ),
    'getting-started': doc(
      'Inicio rápido de AQBot: instalación, configuración de un proveedor, primera conversación y copias de seguridad.',
      'AQBot guía, inicio rápido, instalación, proveedores',
    ),
    providers: doc(
      'Configura OpenAI, Claude, Gemini, DeepSeek, Ollama y endpoints personalizados en AQBot.',
      'AQBot proveedores, OpenAI, Claude, Gemini, DeepSeek, Ollama',
    ),
    mcp: doc(
      'Conecta servidores MCP en AQBot para añadir herramientas, archivos y bases de datos a las conversaciones.',
      'AQBot MCP, Model Context Protocol, servidores MCP',
    ),
    gateway: doc(
      'La pasarela API de AQBot expone tus modelos como endpoints compatibles con OpenAI, Claude y Gemini.',
      'AQBot pasarela, compatible OpenAI, Claude Code, Codex, Cursor',
    ),
  },
  ru: {
    home: home(
      'AQBot — открытый ИИ-клиент для рабочего стола и шлюз',
      'AQBot — бесплатный ИИ-клиент с открытым исходным кодом: чат с несколькими моделями, Agent, MCP, локальная база знаний и встроенный ИИ-шлюз.',
      'AQBot, ИИ клиент, ИИ шлюз, мультимодель, MCP, Agent, OpenAI, Claude, Gemini',
    ),
    features: page(
      'Возможности',
      'Возможности AQBot: мультимодельный чат, локальный API-шлюз, автономный Agent, MCP, база sqlite-vec, роли и шифрованные резервные копии.',
      'AQBot возможности, мультимодель, API-шлюз, Agent, MCP, sqlite-vec',
    ),
    download: page(
      'Скачать',
      'Скачайте AQBot бесплатно для macOS (Apple Silicon / Intel), Windows и Linux со встроенным локальным шлюзом.',
      'AQBot скачать, macOS, Windows, Linux, Apple Silicon',
    ),
    'getting-started': doc(
      'Быстрый старт AQBot: установка, настройка провайдера, первый чат и резервное копирование.',
      'AQBot руководство, быстрый старт, установка, провайдеры',
    ),
    providers: doc(
      'Подключите OpenAI, Claude, Gemini, DeepSeek, Ollama и свои эндпоинты в AQBot.',
      'AQBot провайдеры, OpenAI, Claude, Gemini, DeepSeek, Ollama',
    ),
    mcp: doc(
      'Подключайте MCP-серверы в AQBot, чтобы добавить в чат инструменты, файлы и базы данных.',
      'AQBot MCP, Model Context Protocol, MCP-серверы',
    ),
    gateway: doc(
      'Встроенный API-шлюз AQBot отдаёт настроенные модели как совместимые с OpenAI, Claude и Gemini эндпоинты.',
      'AQBot шлюз, OpenAI-совместимый, Claude Code, Codex, Cursor',
    ),
  },
  hi: {
    home: home(
      'AQBot — ओपन-सोर्स AI डेस्कटॉप क्लाइंट और गेटवे',
      'AQBot एक मुफ़्त ओपन-सोर्स AI डेस्कटॉप क्लाइंट है, जिसमें मल्टी-मॉडल चैट, Agent, MCP, लोकल नॉलेज बेस और बिल्ट-इन AI गेटवे है।',
      'AQBot, AI डेस्कटॉप, AI गेटवे, मल्टी-मॉडल, MCP, Agent, OpenAI, Claude, Gemini',
    ),
    features: page(
      'विशेषताएं',
      'AQBot की क्षमताएँ: मल्टी-मॉडल चैट, लोकल API गेटवे, स्वायत्त Agent, MCP, sqlite-vec नॉलेज बेस, भूमिकाएँ और एन्क्रिप्टेड बैकअप।',
      'AQBot विशेषताएं, मल्टी-मॉडल, API गेटवे, Agent, MCP, sqlite-vec',
    ),
    download: page(
      'डाउनलोड',
      'AQBot मुफ़्त डाउनलोड करें — macOS (Apple Silicon / Intel), Windows और Linux, लोकल गेटवे सहित।',
      'AQBot डाउनलोड, macOS, Windows, Linux, Apple Silicon',
    ),
    'getting-started': doc(
      'AQBot त्वरित प्रारंभ: इंस्टॉल करें, प्रदाता सेट करें, पहली बातचीत करें और बैकअप समझें।',
      'AQBot गाइड, त्वरित प्रारंभ, इंस्टॉल, प्रदाता',
    ),
    providers: doc(
      'AQBot में OpenAI, Claude, Gemini, DeepSeek, Ollama और कस्टम एंडपॉइंट कॉन्फ़िगर करें।',
      'AQBot प्रदाता, OpenAI, Claude, Gemini, DeepSeek, Ollama',
    ),
    mcp: doc(
      'AQBot में MCP सर्वर जोड़कर बातचीत में टूल, फ़ाइल सिस्टम और डेटाबेस जोड़ें।',
      'AQBot MCP, Model Context Protocol, MCP सर्वर',
    ),
    gateway: doc(
      'AQBot का बिल्ट-इन API गेटवे आपके मॉडल को OpenAI / Claude / Gemini संगत एंडपॉइंट के रूप में देता है।',
      'AQBot गेटवे, OpenAI संगत, Claude Code, Codex, Cursor',
    ),
  },
  ar: {
    home: home(
      'AQBot — عميل سطح مكتب للذكاء الاصطناعي مفتوح المصدر وبوابة',
      'AQBot عميل سطح مكتب مجاني ومفتوح المصدر للدردشة متعددة النماذج وAgent وMCP وقاعدة معرفة محلية وبوابة ذكاء اصطناعي مدمجة.',
      'AQBot, عميل ذكاء اصطناعي, بوابة AI, دردشة متعددة النماذج, MCP, Agent, OpenAI, Claude, Gemini',
    ),
    features: page(
      'الميزات',
      'استكشف قدرات AQBot: دردشة متعددة النماذج، بوابة API محلية، Agent ذاتي، MCP، قاعدة sqlite-vec، أدوار ونسخ احتياطي مشفّر.',
      'ميزات AQBot, نماذج متعددة, بوابة API, Agent, MCP, sqlite-vec',
    ),
    download: page(
      'تنزيل',
      'نزّل AQBot مجانًا لـ macOS (Apple Silicon / Intel) وWindows وLinux مع بوابة محلية مدمجة.',
      'تنزيل AQBot, macOS, Windows, Linux, Apple Silicon',
    ),
    'getting-started': doc(
      'البدء السريع مع AQBot: التثبيت، إعداد مزود، أول محادثة، والنسخ الاحتياطي.',
      'دليل AQBot, البدء السريع, التثبيت, المزودون',
    ),
    providers: doc(
      'اضبط OpenAI وClaude وGemini وDeepSeek وOllama ونقاط نهاية مخصصة في AQBot.',
      'مزودو AQBot, OpenAI, Claude, Gemini, DeepSeek, Ollama',
    ),
    mcp: doc(
      'اربط خوادم MCP في AQBot لإضافة أدوات وملفات وقواعد بيانات إلى المحادثات.',
      'AQBot MCP, Model Context Protocol, خوادم MCP',
    ),
    gateway: doc(
      'بوابة API المدمجة في AQBot تعرض نماذجك كنقاط نهاية متوافقة مع OpenAI وClaude وGemini.',
      'بوابة AQBot, متوافق OpenAI, Claude Code, Codex, Cursor',
    ),
  },
};

export function parsePagePath(relativePath: string): {
  locale: SeoLocale;
  kind: PageKind | 'other';
  slug: string;
} {
  let path = relativePath.replace(/\\/g, '/').replace(/\.md$/, '');
  if (path.endsWith('/index')) path = path.slice(0, -6);
  if (path === 'index') path = '';

  let locale: SeoLocale = 'en';
  for (const prefix of LOCALE_PREFIXES) {
    if (path === prefix) {
      locale = prefix;
      path = '';
      break;
    }
    if (path.startsWith(`${prefix}/`)) {
      locale = prefix;
      path = path.slice(prefix.length + 1);
      break;
    }
  }

  return {
    locale,
    kind: KIND_BY_SLUG[path] ?? 'other',
    slug: path,
  };
}

function localePrefix(locale: SeoLocale): string {
  return locale === 'en' ? '' : `/${locale}`;
}

function pageUrl(locale: SeoLocale, slug: string): string {
  const prefix = localePrefix(locale);
  if (!slug) return prefix ? `${SITE_URL}${prefix}/` : `${SITE_URL}/`;
  return `${SITE_URL}${prefix}/${slug}`;
}

const MANAGED_META = new Set([
  'keywords',
  'og:title',
  'og:description',
  'og:url',
  'og:locale',
  'og:locale:alternate',
  'twitter:title',
  'twitter:description',
]);

function isManagedHead(tag: HeadConfig): boolean {
  if (!Array.isArray(tag) || tag.length < 2) return false;
  const [name, attrs] = tag;
  if (!attrs || typeof attrs !== 'object') return false;
  const record = attrs as Record<string, string>;
  if (name === 'link' && (record.rel === 'canonical' || record.rel === 'alternate')) {
    return true;
  }
  if (name !== 'meta') return false;
  const key = record.name || record.property;
  return Boolean(key && MANAGED_META.has(key));
}

export function applyPageSeo(pageData: PageData): void {
  const parsed = parsePagePath(pageData.relativePath);
  const entry = parsed.kind === 'other' ? undefined : SEO[parsed.locale][parsed.kind];

  if (entry?.isHome && entry.title) {
    pageData.title = entry.title;
    pageData.titleTemplate = false;
    pageData.frontmatter.title = entry.title;
    pageData.frontmatter.titleTemplate = false;
  } else if (entry?.title) {
    pageData.title = entry.title;
    pageData.titleTemplate = ':title - AQBot';
    pageData.frontmatter.title = entry.title;
    pageData.frontmatter.titleTemplate = ':title - AQBot';
  } else {
    pageData.titleTemplate = ':title - AQBot';
    delete pageData.frontmatter.titleTemplate;
  }

  if (entry?.description) {
    pageData.description = entry.description;
    pageData.frontmatter.description = entry.description;
  }

  const fullTitle = entry?.isHome
    ? pageData.title
    : `${pageData.title} - AQBot`;
  const description = pageData.description;
  const canonical = pageUrl(parsed.locale, parsed.slug);
  const keywords =
    entry?.keywords ??
    SEO[parsed.locale].home.keywords;

  const extra: HeadConfig[] = [
    ['meta', { name: 'keywords', content: keywords }],
    ['link', { rel: 'canonical', href: canonical }],
    ['meta', { property: 'og:title', content: fullTitle }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:url', content: canonical }],
    ['meta', { property: 'og:locale', content: OG_LOCALE[parsed.locale] }],
    ['meta', { name: 'twitter:title', content: fullTitle }],
    ['meta', { name: 'twitter:description', content: description }],
  ];

  for (const loc of Object.keys(HREFLANG) as SeoLocale[]) {
    extra.push([
      'link',
      {
        rel: 'alternate',
        hreflang: HREFLANG[loc],
        href: pageUrl(loc, parsed.slug),
      },
    ]);
    if (loc !== parsed.locale) {
      extra.push([
        'meta',
        { property: 'og:locale:alternate', content: OG_LOCALE[loc] },
      ]);
    }
  }
  extra.push([
    'link',
    { rel: 'alternate', hreflang: 'x-default', href: pageUrl('en', parsed.slug) },
  ]);

  const existing = ((pageData.frontmatter.head as HeadConfig[] | undefined) ?? []).filter(
    (tag) => !isManagedHead(tag),
  );
  pageData.frontmatter.head = [...existing, ...extra];
}
