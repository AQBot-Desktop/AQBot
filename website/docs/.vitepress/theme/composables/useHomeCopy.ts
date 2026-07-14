import { computed } from 'vue';
import { useData } from 'vitepress';

type LocaleKey =
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

export interface HomeCopy {
  badge: string;
  title: string;
  titleHighlight: string;
  subtitle: string;
  download: string;
  docs: string;
  github: string;
  marquee: string[];
  showcaseLabel: string;
  showcaseTitle: string;
  showcaseDesc: string;
  deepDives: Array<{
    label: string;
    title: string;
    desc: string;
    points: string[];
    image: string;
  }>;
  bentoLabel: string;
  bentoTitle: string;
  bento: Array<{ title: string; desc: string; icon: string }>;
  platformLabel: string;
  platforms: Array<{ title: string; desc: string; icon: 'macos' | 'windows' | 'linux' }>;
  ctaTitle: string;
  ctaDesc: string;
  ctaDownload: string;
  ctaGithub: string;
  footerTagline: string;
  footerFeatures: string;
  footerDownload: string;
  footerDocs: string;
  footerRights: string;
  docCtaTitle: string;
  docCtaDesc: string;
  docCtaBtn: string;
}

const en: HomeCopy = {
  badge: 'Open-source · Local-first · Multi-model',
  title: 'Your AI desktop',
  titleHighlight: 'workspace',
  subtitle:
    'Multi-model chat, Agent, MCP tools, Skills, knowledge base and a built-in API gateway — one local-first client for OpenAI, Claude, Gemini and more.',
  download: 'Download',
  docs: 'Documentation',
  github: 'GitHub',
  marquee: [
    'OpenAI',
    'Claude',
    'Gemini',
    'DeepSeek',
    'Qwen',
    'MCP',
    'Agent',
    'Skills',
    'RAG',
    'API Gateway',
    'AES-256',
    'WebDAV / S3',
  ],
  showcaseLabel: 'Product',
  showcaseTitle: 'Built for real desktop workflows',
  showcaseDesc: 'Streaming chat, diagrams, agent approvals and gateway setup — without leaving your machine.',
  deepDives: [
    {
      label: 'Chat',
      title: 'Multi-model conversations that stay under your control',
      desc: 'Connect any OpenAI-compatible API. Branch chats, compress long threads and answer with multiple models in parallel.',
      points: ['Key rotation & custom headers', 'Thinking blocks & branches', 'Markdown · LaTeX · Mermaid · D2'],
      image: '/screenshots/s1-0412.png',
    },
    {
      label: 'Agent',
      title: 'Agents with permissions, not blank checks',
      desc: 'Read and edit files, run commands and analyze code with sandbox checks, approval UI and cost tracking.',
      points: ['Permission levels', 'Working-directory sandbox', 'Live tool-call review'],
      image: '/screenshots/s5-0412.png',
    },
    {
      label: 'Gateway',
      title: 'Local API gateway for your tools',
      desc: 'Expose OpenAI, Claude and Gemini compatible endpoints for Claude Code, Codex, OpenCode and custom clients.',
      points: ['One-click client templates', 'Keys, SSL & request logs', 'Usage analytics locally'],
      image: '/screenshots/s6-0412.png',
    },
    {
      label: 'Knowledge',
      title: 'Search the web and your private docs',
      desc: 'Tavily, Exa and more with citations — plus local sqlite-vec knowledge bases and retrieval feedback.',
      points: ['Cited web search', 'Local vector store', 'Context attachments'],
      image: '/screenshots/s3-0412.png',
    },
  ],
  bentoLabel: 'Capabilities',
  bentoTitle: 'Everything you need in one client',
  bento: [
    { icon: 'bot', title: 'Multi-model chat', desc: 'OpenAI, Claude, Gemini, DeepSeek, Qwen and compatible APIs.' },
    { icon: 'zap', title: 'AI Agent', desc: 'File edits, commands and code analysis with approval flows.' },
    { icon: 'puzzle', title: 'MCP & Skills', desc: 'stdio/SSE/HTTP MCP servers plus multi-source skill directories.' },
    { icon: 'book', title: 'Roles marketplace', desc: 'Reusable templates from prompts.chat and more.' },
    { icon: 'import', title: 'Data import', desc: 'ChatGPT, Cherry Studio and Kelivo backups.' },
    { icon: 'shield', title: 'Backup & security', desc: 'AES-256 storage, dual-root layout, WebDAV/S3 backups.' },
    { icon: 'monitor', title: 'Desktop UX', desc: 'Tray, shortcuts, auto-start, proxy and auto-update.' },
    { icon: 'globe', title: '11 languages', desc: 'Switch UI language anytime — fully localized.' },
  ],
  platformLabel: 'Platforms',
  platforms: [
    { title: 'macOS', desc: 'Apple Silicon & Intel', icon: 'macos' },
    { title: 'Windows', desc: 'x64 & ARM64', icon: 'windows' },
    { title: 'Linux', desc: 'deb · rpm · AppImage', icon: 'linux' },
  ],
  ctaTitle: 'Start shipping with your local AI workspace',
  ctaDesc: 'Free and open source — download AQBot and connect your models in minutes.',
  ctaDownload: 'Download AQBot',
  ctaGithub: 'Star on GitHub',
  footerTagline: 'Open-source AI desktop client with built-in gateway.',
  footerFeatures: 'Features',
  footerDownload: 'Download',
  footerDocs: 'Docs',
  footerRights: '© 2026 AQBot',
  docCtaTitle: 'Ready to try AQBot?',
  docCtaDesc: 'Download for macOS, Windows or Linux and get started in minutes.',
  docCtaBtn: 'Go to Download',
};

const zh: HomeCopy = {
  badge: '开源 · 本地优先 · 多模型',
  title: '你的 AI 桌面',
  titleHighlight: '工作台',
  subtitle:
    '多模型对话、Agent、MCP 工具、Skills、知识库与内置 API 网关 —— 一个本地优先客户端，连接 OpenAI、Claude、Gemini 等。',
  download: '下载',
  docs: '文档',
  github: 'GitHub',
  marquee: [
    'OpenAI',
    'Claude',
    'Gemini',
    'DeepSeek',
    '通义千问',
    'MCP',
    'Agent',
    'Skills',
    '知识库',
    'API 网关',
    'AES-256',
    'WebDAV / S3',
  ],
  showcaseLabel: '产品',
  showcaseTitle: '为真实桌面工作流而设计',
  showcaseDesc: '流式对话、图表渲染、Agent 审批与网关配置 —— 数据留在本地。',
  deepDives: [
    {
      label: '对话',
      title: '多模型对话，控制权在你手里',
      desc: '接入任意 OpenAI 兼容 API。支持对话分支、长上下文压缩与多模型并行回答。',
      points: ['密钥轮询与自定义请求头', '思考块与对话分支', 'Markdown · LaTeX · Mermaid · D2'],
      image: '/screenshots/s1-0412.png',
    },
    {
      label: 'Agent',
      title: '带权限的 Agent，而不是空白支票',
      desc: '在沙箱与审批 UI 下读改文件、执行命令、分析代码，并跟踪成本。',
      points: ['权限分级', '工作目录沙箱', '实时工具调用审批'],
      image: '/screenshots/s5-0412.png',
    },
    {
      label: '网关',
      title: '本地 API 网关，一键接入工具链',
      desc: '对外暴露 OpenAI / Claude / Gemini 兼容接口，服务 Claude Code、Codex、OpenCode 等。',
      points: ['客户端配置模板', '密钥、SSL 与请求日志', '本地用量统计'],
      image: '/screenshots/s6-0412.png',
    },
    {
      label: '知识',
      title: '联网搜索 + 私有知识库',
      desc: 'Tavily、Exa 等带来源引用；本地 sqlite-vec 索引私有文档。',
      points: ['带引用的联网搜索', '本地向量库', '上下文附件'],
      image: '/screenshots/s3-0412.png',
    },
  ],
  bentoLabel: '能力',
  bentoTitle: '一个客户端装下你需要的一切',
  bento: [
    { icon: 'bot', title: '多模型对话', desc: 'OpenAI、Claude、Gemini、DeepSeek、Qwen 与兼容 API。' },
    { icon: 'zap', title: 'AI Agent', desc: '文件编辑、命令执行与代码分析，含审批流。' },
    { icon: 'puzzle', title: 'MCP 与 Skills', desc: 'stdio/SSE/HTTP MCP，多来源技能目录。' },
    { icon: 'book', title: '角色市场', desc: '可复用角色模板，支持在线市场安装。' },
    { icon: 'import', title: '数据导入', desc: 'ChatGPT、Cherry Studio、Kelivo 备份。' },
    { icon: 'shield', title: '备份与安全', desc: 'AES-256、双根目录、WebDAV/S3 备份。' },
    { icon: 'monitor', title: '桌面体验', desc: '托盘、快捷键、开机自启、代理与自动更新。' },
    { icon: 'globe', title: '11 种语言', desc: '界面语言随时切换，完整本地化。' },
  ],
  platformLabel: '平台',
  platforms: [
    { title: 'macOS', desc: 'Apple Silicon 与 Intel', icon: 'macos' },
    { title: 'Windows', desc: 'x64 与 ARM64', icon: 'windows' },
    { title: 'Linux', desc: 'deb · rpm · AppImage', icon: 'linux' },
  ],
  ctaTitle: '从本地 AI 工作台开始',
  ctaDesc: '免费开源，下载 AQBot，几分钟内即可接入你的模型。',
  ctaDownload: '下载 AQBot',
  ctaGithub: 'GitHub Star',
  footerTagline: '开源 AI 桌面客户端，内置网关。',
  footerFeatures: '功能',
  footerDownload: '下载',
  footerDocs: '文档',
  footerRights: '© 2026 AQBot',
  docCtaTitle: '准备好试用 AQBot 了吗？',
  docCtaDesc: '支持 macOS、Windows 与 Linux，几分钟即可上手。',
  docCtaBtn: '前往下载',
};

const zhTw: HomeCopy = {
  ...zh,
  badge: '開源 · 本地優先 · 多模型',
  title: '你的 AI 桌面',
  titleHighlight: '工作台',
  subtitle:
    '多模型對話、Agent、MCP 工具、Skills、知識庫與內建 API 閘道 —— 一個本地優先用戶端，連接 OpenAI、Claude、Gemini 等。',
  download: '下載',
  docs: '文件',
  ctaTitle: '從本地 AI 工作台開始',
  ctaDesc: '免費開源，下載 AQBot，幾分鐘內即可接入你的模型。',
  ctaDownload: '下載 AQBot',
  footerTagline: '開源 AI 桌面用戶端，內建閘道。',
  footerFeatures: '功能',
  footerDownload: '下載',
  footerDocs: '文件',
  docCtaTitle: '準備好試用 AQBot 了嗎？',
  docCtaDesc: '支援 macOS、Windows 與 Linux，幾分鐘即可上手。',
  docCtaBtn: '前往下載',
};

const map: Record<LocaleKey, HomeCopy> = {
  en,
  zh,
  'zh-tw': zhTw,
  ja: { ...en, download: 'ダウンロード', docs: 'ドキュメント', ctaDownload: 'AQBot をダウンロード', docCtaBtn: 'ダウンロードへ' },
  ko: { ...en, download: '다운로드', docs: '문서', ctaDownload: 'AQBot 다운로드', docCtaBtn: '다운로드로 이동' },
  fr: { ...en, download: 'Télécharger', docs: 'Documentation', ctaDownload: 'Télécharger AQBot', docCtaBtn: 'Télécharger' },
  de: { ...en, download: 'Herunterladen', docs: 'Dokumentation', ctaDownload: 'AQBot herunterladen', docCtaBtn: 'Zum Download' },
  es: { ...en, download: 'Descargar', docs: 'Documentación', ctaDownload: 'Descargar AQBot', docCtaBtn: 'Ir a descargas' },
  ru: { ...en, download: 'Скачать', docs: 'Документация', ctaDownload: 'Скачать AQBot', docCtaBtn: 'К загрузке' },
  hi: { ...en, download: 'डाउनलोड', docs: 'दस्तावेज़', ctaDownload: 'AQBot डाउनलोड करें', docCtaBtn: 'डाउनलोड पर जाएँ' },
  ar: { ...en, download: 'تنزيل', docs: 'التوثيق', ctaDownload: 'نزّل AQBot', docCtaBtn: 'الانتقال للتنزيل' },
};

function resolveKey(localeIndex: string, lang: string): LocaleKey {
  if (localeIndex && localeIndex !== 'root' && localeIndex in map) {
    return localeIndex as LocaleKey;
  }
  if (lang.startsWith('zh-TW') || lang === 'zh-TW') return 'zh-tw';
  if (lang.startsWith('zh')) return 'zh';
  const short = lang.split('-')[0] as LocaleKey;
  if (short in map) return short;
  return 'en';
}

export function useHomeCopy() {
  const { lang, localeIndex } = useData();
  const copy = computed(() => map[resolveKey(localeIndex.value, lang.value)] ?? en);
  return { copy };
}
