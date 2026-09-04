import { computed } from 'vue';
import { useData } from 'vitepress';

export type SiteLocale =
  | 'zh'
  | 'zh-tw'
  | 'en'
  | 'ja'
  | 'ko'
  | 'ru'
  | 'fr'
  | 'de'
  | 'es'
  | 'hi'
  | 'ar';

export const LOCALE_CONFIG: Record<
  SiteLocale,
  { label: string; prefix: string; htmlLang: string }
> = {
  zh: { label: '简体中文', prefix: '/zh', htmlLang: 'zh-CN' },
  'zh-tw': { label: '繁體中文', prefix: '/zh-tw', htmlLang: 'zh-TW' },
  en: { label: 'English', prefix: '', htmlLang: 'en' },
  ja: { label: '日本語', prefix: '/ja', htmlLang: 'ja' },
  ko: { label: '한국어', prefix: '/ko', htmlLang: 'ko' },
  ru: { label: 'Русский', prefix: '/ru', htmlLang: 'ru' },
  fr: { label: 'Français', prefix: '/fr', htmlLang: 'fr' },
  de: { label: 'Deutsch', prefix: '/de', htmlLang: 'de' },
  es: { label: 'Español', prefix: '/es', htmlLang: 'es' },
  hi: { label: 'हिन्दी', prefix: '/hi', htmlLang: 'hi' },
  ar: { label: 'العربية', prefix: '/ar', htmlLang: 'ar' },
};

export function resolveSiteLocale(lang: string | undefined): SiteLocale {
  const value = (lang ?? '').toLowerCase();
  if (value.startsWith('zh-hant') || value.includes('zh-tw') || value.includes('zh-hk')) {
    return 'zh-tw';
  }
  if (value.startsWith('zh')) return 'zh';
  if (value.startsWith('ja')) return 'ja';
  if (value.startsWith('ko')) return 'ko';
  if (value.startsWith('ru')) return 'ru';
  if (value.startsWith('fr')) return 'fr';
  if (value.startsWith('de')) return 'de';
  if (value.startsWith('es')) return 'es';
  if (value.startsWith('hi')) return 'hi';
  if (value.startsWith('ar')) return 'ar';
  return 'en';
}

export function localePrefix(locale: SiteLocale): string {
  return LOCALE_CONFIG[locale]?.prefix ?? '';
}

export function localeHref(locale: SiteLocale, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  const prefix = localePrefix(locale);
  if (!prefix) return clean;
  if (clean === '/') return `${prefix}/`;
  return `${prefix}${clean}`;
}

export function useSiteLocale() {
  const { lang } = useData();
  return computed(() => resolveSiteLocale(lang.value));
}

export interface ThemeModeCopy {
  system: string;
  dark: string;
  light: string;
}

export const THEME_MODE_COPY: Record<SiteLocale, ThemeModeCopy> = {
  zh: { system: '系统', dark: '深色', light: '浅色' },
  'zh-tw': { system: '系統', dark: '深色', light: '淺色' },
  en: { system: 'System', dark: 'Dark', light: 'Light' },
  ja: { system: 'システム', dark: 'ダーク', light: 'ライト' },
  ko: { system: '시스템', dark: '다크', light: '라이트' },
  ru: { system: 'Система', dark: 'Тёмная', light: 'Светлая' },
  fr: { system: 'Système', dark: 'Sombre', light: 'Clair' },
  de: { system: 'System', dark: 'Dunkel', light: 'Hell' },
  es: { system: 'Sistema', dark: 'Oscuro', light: 'Claro' },
  hi: { system: 'सिस्टम', dark: 'डार्क', light: 'लाइट' },
  ar: { system: 'النظام', dark: 'داكن', light: 'فاتح' },
};

export function themeModeCopy(locale: SiteLocale): ThemeModeCopy {
  return THEME_MODE_COPY[locale] ?? THEME_MODE_COPY.en;
}

export interface GeneralUiCopy {
  copy: string;
  copied: string;
  allDownloads: string;
}

export const GENERAL_UI_COPY: Record<SiteLocale, GeneralUiCopy> = {
  zh: { copy: '复制', copied: '已复制', allDownloads: '查看所有平台安装包' },
  'zh-tw': { copy: '複製', copied: '已複製', allDownloads: '查看所有平台安裝包' },
  en: { copy: 'Copy', copied: 'Copied', allDownloads: 'View all platform downloads' },
  ja: { copy: 'コピー', copied: '完了', allDownloads: 'すべてのダウンロード' },
  ko: { copy: '복사', copied: '완료', allDownloads: '모든 다운로드 보기' },
  ru: { copy: 'Копировать', copied: 'Готово', allDownloads: 'Все версии для загрузки' },
  fr: { copy: 'Copier', copied: 'Copié', allDownloads: 'Tous les téléchargements' },
  de: { copy: 'Kopieren', copied: 'Kopiert', allDownloads: 'Alle Downloads anzeigen' },
  es: { copy: 'Copiar', copied: 'Copiado', allDownloads: 'Ver todas las descargas' },
  hi: { copy: 'कॉपी करें', copied: 'कॉपी हो गया', allDownloads: 'सभी डाउनलोड देखें' },
  ar: { copy: 'نسخ', copied: 'تم النسخ', allDownloads: 'عرض جميع التنزيلات' },
};

export function generalUiCopy(locale: SiteLocale): GeneralUiCopy {
  return GENERAL_UI_COPY[locale] ?? GENERAL_UI_COPY.en;
}

export interface HomeCopy {
  tagline: string;
}

export const HOME_COPY: Record<SiteLocale, HomeCopy> = {
  zh: {
    tagline: '轻量级高性能跨平台AI对话 + AI Agent + AI网关桌面客户端',
  },
  'zh-tw': {
    tagline: '輕量級高效能跨平台AI對話 + AI Agent + AI閘道桌面客戶端',
  },
  en: {
    tagline: 'Lightweight high-performance cross-platform desktop client for AI chat, AI Agent, and AI gateway',
  },
  ja: {
    tagline: '軽量かつ高性能なクロスプラットフォームの AI チャット + AI Agent + AI ゲートウェイ デスクトップクライアント',
  },
  ko: {
    tagline: '가볍고 성능 좋은 크로스 플랫폼 AI 대화 + AI Agent + AI 게이트웨이 데스크톱 클라이언트',
  },
  ru: {
    tagline: 'Лёгкий высокопроизводительный кроссплатформенный десктоп-клиент: AI-чат + AI Agent + AI-шлюз',
  },
  fr: {
    tagline: 'Client de bureau léger et performant, multiplateforme : chat IA + AI Agent + passerelle IA',
  },
  de: {
    tagline: 'Leichter, leistungsstarker plattformübergreifender Desktop-Client für KI-Chat, AI Agent und KI-Gateway',
  },
  es: {
    tagline: 'Cliente de escritorio ligero y de alto rendimiento, multiplataforma: chat IA + AI Agent + pasarela IA',
  },
  hi: {
    tagline: 'हल्का, उच्च-प्रदर्शन क्रॉस-प्लेटफ़ॉर्म डेस्कटॉप क्लाइंट: AI चैट + AI Agent + AI गेटवे',
  },
  ar: {
    tagline: 'عميل سطح مكتب خفيف وعالي الأداء متعدد المنصات: محادثة الذكاء الاصطناعي + AI Agent + بوابة الذكاء الاصطناعي',
  },
};

export function homeCopy(locale: SiteLocale): HomeCopy {
  return HOME_COPY[locale] ?? HOME_COPY.en;
}

export interface FooterCopy {
  docs: string;
  features: string;
  download: string;
  github: string;
  license: string;
}

export const FOOTER_COPY: Record<SiteLocale, FooterCopy> = {
  zh: {
    docs: '快速开始',
    features: '核心特性',
    download: '下载客户端',
    github: 'GitHub 源码',
    license: 'AGPL-3.0 协议',
  },
  'zh-tw': {
    docs: '快速開始',
    features: '核心特性',
    download: '下載客戶端',
    github: 'GitHub 原始碼',
    license: 'AGPL-3.0 協議',
  },
  en: {
    docs: 'Documentation',
    features: 'Features',
    download: 'Download',
    github: 'GitHub Source',
    license: 'AGPL-3.0 License',
  },
  ja: {
    docs: 'ドキュメント',
    features: '機能一覧',
    download: 'ダウンロード',
    github: 'GitHub',
    license: 'AGPL-3.0 ライセンス',
  },
  ko: {
    docs: '문서',
    features: '주요 기능',
    download: '다운로드',
    github: 'GitHub',
    license: 'AGPL-3.0 라이선스',
  },
  ru: {
    docs: 'Документация',
    features: 'Возможности',
    download: 'Скачать',
    github: 'GitHub',
    license: 'Лицензия AGPL-3.0',
  },
  fr: {
    docs: 'Documentation',
    features: 'Fonctionnalités',
    download: 'Télécharger',
    github: 'GitHub',
    license: 'Licence AGPL-3.0',
  },
  de: {
    docs: 'Dokumentation',
    features: 'Funktionen',
    download: 'Herunterladen',
    github: 'GitHub',
    license: 'AGPL-3.0 Lizenz',
  },
  es: {
    docs: 'Documentación',
    features: 'Características',
    download: 'Descargar',
    github: 'GitHub',
    license: 'Licencia AGPL-3.0',
  },
  hi: {
    docs: 'दस्तावेज़',
    features: 'विशेषताएं',
    download: 'डाउनलोड',
    github: 'GitHub',
    license: 'AGPL-3.0 लाइसेंस',
  },
  ar: {
    docs: 'التوثيق',
    features: 'الميزات',
    download: 'تنزيل',
    github: 'GitHub',
    license: 'ترخيص AGPL-3.0',
  },
};

export function footerCopy(locale: SiteLocale): FooterCopy {
  return FOOTER_COPY[locale] ?? FOOTER_COPY.en;
}
