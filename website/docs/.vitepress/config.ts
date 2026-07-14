import { defineConfig } from 'vitepress';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rootPkg = JSON.parse(
  readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'),
);
const APP_VERSION = rootPkg.version as string;

const SITE_URL = 'https://app.aqbot.top';
const OG_IMAGE = `${SITE_URL}/og-image.png`;

export default defineConfig({
  title: 'AQBot',
  description: 'AQBot — Open-source AI desktop client with built-in AI gateway, multi-model chat, MCP server support. Connect OpenAI, Claude, Gemini and more LLMs in one app.',

  base: '/',

  // Default to dark; user can still toggle light via appearance switch
  appearance: 'dark',
  lastUpdated: true,
  cleanUrls: true,

  sitemap: {
    hostname: SITE_URL,
  },

  vite: {
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
  },

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    // Primary SEO meta
    ['meta', { name: 'theme-color', content: '#050607' }],
    ['meta', { name: 'author', content: 'AQBot Team' }],
    ['meta', { name: 'keywords', content: 'AQBot, AI desktop client, AI gateway, AI chat client, LLM client, multi-model AI, MCP server, OpenAI client, Claude client, Gemini client, AI assistant, desktop AI app, open source AI, ChatGPT alternative, AI aggregator, large language model, AI desktop application, Tauri AI app' }],
    ['meta', { name: 'robots', content: 'index, follow' }],
    // Open Graph
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'AQBot' }],
    ['meta', { property: 'og:title', content: 'AQBot — Open-source AI Desktop Client & Gateway' }],
    ['meta', { property: 'og:description', content: 'Free, open-source AI desktop client with built-in gateway. Connect multiple LLMs (OpenAI, Claude, Gemini, DeepSeek) in one app. MCP server support, knowledge base, and more.' }],
    ['meta', { property: 'og:image', content: OG_IMAGE }],
    ['meta', { property: 'og:url', content: SITE_URL }],
    ['meta', { property: 'og:locale', content: 'en' }],
    ['meta', { property: 'og:locale:alternate', content: 'zh_CN' }],
    // Twitter Card
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'AQBot — Open-source AI Desktop Client & Gateway' }],
    ['meta', { name: 'twitter:description', content: 'Free, open-source AI desktop client with built-in gateway. Multi-model chat, MCP server support, knowledge base.' }],
    ['meta', { name: 'twitter:image', content: OG_IMAGE }],
  ],

  locales: {
    root: {
      label: '🇺🇸 English',
      lang: 'en',
      title: 'AQBot',
      description: 'AQBot — Open-source AI desktop client with built-in AI gateway, multi-model chat, MCP server support.',
      themeConfig: {
        nav: [
          { text: 'Home', link: '/' },
          { text: 'Features', link: '/features' },
          { text: 'Download', link: '/download' },
          { text: 'Docs', link: '/guide/getting-started' },
        ],
        sidebar: {
          '/guide/': [{ text: 'Getting Started', items: [
            { text: 'Quick Start', link: '/guide/getting-started' },
            { text: 'Configure Providers', link: '/guide/providers' },
            { text: 'MCP Servers', link: '/guide/mcp' },
            { text: 'API Gateway', link: '/guide/gateway' },
          ]}],
        },
      },
    },
    zh: {
      label: '🇨🇳 简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      title: 'AQBot',
      description: 'AQBot — 开源 AI 桌面客户端，内置 AI 网关，支持多模型对话、MCP 服务器、知识库。',
      themeConfig: {
        nav: [
          { text: '首页', link: '/zh/' },
          { text: '功能', link: '/zh/features' },
          { text: '下载', link: '/zh/download' },
          { text: '文档', link: '/zh/guide/getting-started' },
        ],
        sidebar: {
          '/zh/guide/': [{ text: '入门', items: [
            { text: '快速开始', link: '/zh/guide/getting-started' },
            { text: '配置服务商', link: '/zh/guide/providers' },
            { text: 'MCP 服务器', link: '/zh/guide/mcp' },
            { text: 'API 网关', link: '/zh/guide/gateway' },
          ]}],
        },
        docFooter: { prev: '上一页', next: '下一页' },
        darkModeSwitchLabel: '外观',
        returnToTopLabel: '返回顶部',
        sidebarMenuLabel: '菜单',
        outline: { label: '页面导航' },
      },
    },
    'zh-tw': {
      label: '🇭🇰 繁體中文',
      lang: 'zh-TW',
      link: '/zh-tw/',
      title: 'AQBot',
      description: 'AQBot — 開源 AI 桌面客戶端，內建 AI 網關，支援多模型對話、MCP 伺服器、知識庫。',
      themeConfig: {
        nav: [
          { text: '首頁', link: '/zh-tw/' },
          { text: '功能', link: '/zh-tw/features' },
          { text: '下載', link: '/zh-tw/download' },
          { text: '文件', link: '/zh-tw/guide/getting-started' },
        ],
        sidebar: {
          '/zh-tw/guide/': [{ text: '入門', items: [
            { text: '快速開始', link: '/zh-tw/guide/getting-started' },
            { text: '設定服務供應商', link: '/zh-tw/guide/providers' },
            { text: 'MCP 伺服器', link: '/zh-tw/guide/mcp' },
            { text: 'API 閘道', link: '/zh-tw/guide/gateway' },
          ]}],
        },
        docFooter: { prev: '上一頁', next: '下一頁' },
        darkModeSwitchLabel: '外觀',
        returnToTopLabel: '返回頂部',
        sidebarMenuLabel: '選單',
        outline: { label: '頁面導覽' },
      },
    },
    ja: {
      label: '🇯🇵 日本語',
      lang: 'ja',
      link: '/ja/',
      title: 'AQBot',
      description: 'AQBot — オープンソースのAIデスクトップクライアント。AIゲートウェイ内蔵、マルチモデルチャット、MCPサーバー対応。',
      themeConfig: {
        nav: [
          { text: 'ホーム', link: '/ja/' },
          { text: '機能', link: '/ja/features' },
          { text: 'ダウンロード', link: '/ja/download' },
          { text: 'ドキュメント', link: '/ja/guide/getting-started' },
        ],
        sidebar: {
          '/ja/guide/': [{ text: 'はじめに', items: [
            { text: 'クイックスタート', link: '/ja/guide/getting-started' },
            { text: 'プロバイダーの設定', link: '/ja/guide/providers' },
            { text: 'MCPサーバー', link: '/ja/guide/mcp' },
            { text: 'APIゲートウェイ', link: '/ja/guide/gateway' },
          ]}],
        },
        docFooter: { prev: '前のページ', next: '次のページ' },
        darkModeSwitchLabel: '外観',
        returnToTopLabel: 'トップに戻る',
        sidebarMenuLabel: 'メニュー',
        outline: { label: 'ページナビゲーション' },
      },
    },
    ko: {
      label: '🇰🇷 한국어',
      lang: 'ko',
      link: '/ko/',
      title: 'AQBot',
      description: 'AQBot — 오픈소스 AI 데스크톱 클라이언트. AI 게이트웨이 내장, 멀티 모델 채팅, MCP 서버 지원.',
      themeConfig: {
        nav: [
          { text: '홈', link: '/ko/' },
          { text: '기능', link: '/ko/features' },
          { text: '다운로드', link: '/ko/download' },
          { text: '문서', link: '/ko/guide/getting-started' },
        ],
        sidebar: {
          '/ko/guide/': [{ text: '시작하기', items: [
            { text: '빠른 시작', link: '/ko/guide/getting-started' },
            { text: '제공업체 설정', link: '/ko/guide/providers' },
            { text: 'MCP 서버', link: '/ko/guide/mcp' },
            { text: 'API 게이트웨이', link: '/ko/guide/gateway' },
          ]}],
        },
        docFooter: { prev: '이전 페이지', next: '다음 페이지' },
        darkModeSwitchLabel: '외관',
        returnToTopLabel: '맨 위로',
        sidebarMenuLabel: '메뉴',
        outline: { label: '페이지 탐색' },
      },
    },
    fr: {
      label: '🇫🇷 Français',
      lang: 'fr',
      link: '/fr/',
      title: 'AQBot',
      description: 'AQBot — Client de bureau IA open-source avec passerelle IA intégrée, chat multi-modèles, support serveur MCP.',
      themeConfig: {
        nav: [
          { text: 'Accueil', link: '/fr/' },
          { text: 'Fonctionnalités', link: '/fr/features' },
          { text: 'Télécharger', link: '/fr/download' },
          { text: 'Documentation', link: '/fr/guide/getting-started' },
        ],
        sidebar: {
          '/fr/guide/': [{ text: 'Démarrage', items: [
            { text: 'Démarrage rapide', link: '/fr/guide/getting-started' },
            { text: 'Configurer les fournisseurs', link: '/fr/guide/providers' },
            { text: 'Serveurs MCP', link: '/fr/guide/mcp' },
            { text: 'Passerelle API', link: '/fr/guide/gateway' },
          ]}],
        },
        docFooter: { prev: 'Page précédente', next: 'Page suivante' },
        darkModeSwitchLabel: 'Apparence',
        returnToTopLabel: 'Retour en haut',
        sidebarMenuLabel: 'Menu',
        outline: { label: 'Navigation de la page' },
      },
    },
    de: {
      label: '🇩🇪 Deutsch',
      lang: 'de',
      link: '/de/',
      title: 'AQBot',
      description: 'AQBot — Open-Source KI-Desktop-Client mit integriertem KI-Gateway, Multi-Modell-Chat, MCP-Server-Unterstützung.',
      themeConfig: {
        nav: [
          { text: 'Startseite', link: '/de/' },
          { text: 'Funktionen', link: '/de/features' },
          { text: 'Download', link: '/de/download' },
          { text: 'Dokumentation', link: '/de/guide/getting-started' },
        ],
        sidebar: {
          '/de/guide/': [{ text: 'Erste Schritte', items: [
            { text: 'Schnellstart', link: '/de/guide/getting-started' },
            { text: 'Anbieter konfigurieren', link: '/de/guide/providers' },
            { text: 'MCP-Server', link: '/de/guide/mcp' },
            { text: 'API-Gateway', link: '/de/guide/gateway' },
          ]}],
        },
        docFooter: { prev: 'Vorherige Seite', next: 'Nächste Seite' },
        darkModeSwitchLabel: 'Erscheinungsbild',
        returnToTopLabel: 'Nach oben',
        sidebarMenuLabel: 'Menü',
        outline: { label: 'Seitennavigation' },
      },
    },
    es: {
      label: '🇪🇸 Español',
      lang: 'es',
      link: '/es/',
      title: 'AQBot',
      description: 'AQBot — Cliente de escritorio IA de código abierto con pasarela IA integrada, chat multi-modelo, soporte de servidor MCP.',
      themeConfig: {
        nav: [
          { text: 'Inicio', link: '/es/' },
          { text: 'Características', link: '/es/features' },
          { text: 'Descargar', link: '/es/download' },
          { text: 'Documentación', link: '/es/guide/getting-started' },
        ],
        sidebar: {
          '/es/guide/': [{ text: 'Comenzar', items: [
            { text: 'Inicio rápido', link: '/es/guide/getting-started' },
            { text: 'Configurar proveedores', link: '/es/guide/providers' },
            { text: 'Servidores MCP', link: '/es/guide/mcp' },
            { text: 'Pasarela API', link: '/es/guide/gateway' },
          ]}],
        },
        docFooter: { prev: 'Página anterior', next: 'Página siguiente' },
        darkModeSwitchLabel: 'Apariencia',
        returnToTopLabel: 'Volver arriba',
        sidebarMenuLabel: 'Menú',
        outline: { label: 'Navegación de página' },
      },
    },
    ru: {
      label: '🇷🇺 Русский',
      lang: 'ru',
      link: '/ru/',
      title: 'AQBot',
      description: 'AQBot — Настольный ИИ-клиент с открытым исходным кодом. Встроенный шлюз ИИ, чат с несколькими моделями, поддержка MCP-серверов.',
      themeConfig: {
        nav: [
          { text: 'Главная', link: '/ru/' },
          { text: 'Функции', link: '/ru/features' },
          { text: 'Скачать', link: '/ru/download' },
          { text: 'Документация', link: '/ru/guide/getting-started' },
        ],
        sidebar: {
          '/ru/guide/': [{ text: 'Начало работы', items: [
            { text: 'Быстрый старт', link: '/ru/guide/getting-started' },
            { text: 'Настройка провайдеров', link: '/ru/guide/providers' },
            { text: 'MCP-серверы', link: '/ru/guide/mcp' },
            { text: 'API-шлюз', link: '/ru/guide/gateway' },
          ]}],
        },
        docFooter: { prev: 'Предыдущая страница', next: 'Следующая страница' },
        darkModeSwitchLabel: 'Внешний вид',
        returnToTopLabel: 'Наверх',
        sidebarMenuLabel: 'Меню',
        outline: { label: 'Навигация по странице' },
      },
    },
    hi: {
      label: '🇮🇳 हिन्दी',
      lang: 'hi',
      link: '/hi/',
      title: 'AQBot',
      description: 'AQBot — ओपन-सोर्स AI डेस्कटॉप क्लाइंट। बिल्ट-इन AI गेटवे, मल्टी-मॉडल चैट, MCP सर्वर समर्थन।',
      themeConfig: {
        nav: [
          { text: 'होम', link: '/hi/' },
          { text: 'विशेषताएं', link: '/hi/features' },
          { text: 'डाउनलोड', link: '/hi/download' },
          { text: 'दस्तावेज़', link: '/hi/guide/getting-started' },
        ],
        sidebar: {
          '/hi/guide/': [{ text: 'शुरुआत', items: [
            { text: 'त्वरित प्रारंभ', link: '/hi/guide/getting-started' },
            { text: 'प्रदाता कॉन्फ़िगर करें', link: '/hi/guide/providers' },
            { text: 'MCP सर्वर', link: '/hi/guide/mcp' },
            { text: 'API गेटवे', link: '/hi/guide/gateway' },
          ]}],
        },
        docFooter: { prev: 'पिछला पृष्ठ', next: 'अगला पृष्ठ' },
        darkModeSwitchLabel: 'स्वरूप',
        returnToTopLabel: 'शीर्ष पर वापस',
        sidebarMenuLabel: 'मेनू',
        outline: { label: 'पृष्ठ नेविगेशन' },
      },
    },
    ar: {
      label: '🇸🇦 العربية',
      lang: 'ar',
      link: '/ar/',
      title: 'AQBot',
      description: 'AQBot — عميل سطح مكتب AI مفتوح المصدر مع بوابة AI مدمجة، دردشة متعددة النماذج، دعم خوادم MCP.',
      themeConfig: {
        nav: [
          { text: 'الرئيسية', link: '/ar/' },
          { text: 'الميزات', link: '/ar/features' },
          { text: 'تنزيل', link: '/ar/download' },
          { text: 'التوثيق', link: '/ar/guide/getting-started' },
        ],
        sidebar: {
          '/ar/guide/': [{ text: 'البدء', items: [
            { text: 'البدء السريع', link: '/ar/guide/getting-started' },
            { text: 'إعداد المزودين', link: '/ar/guide/providers' },
            { text: 'خوادم MCP', link: '/ar/guide/mcp' },
            { text: 'بوابة API', link: '/ar/guide/gateway' },
          ]}],
        },
        docFooter: { prev: 'الصفحة السابقة', next: 'الصفحة التالية' },
        darkModeSwitchLabel: 'المظهر',
        returnToTopLabel: 'العودة للأعلى',
        sidebarMenuLabel: 'القائمة',
        outline: { label: 'تنقل الصفحة' },
      },
    },
  },

  themeConfig: {
    logo: '/logo.png',
    socialLinks: [
      { icon: 'github', link: 'https://github.com/AQBot-Desktop/AQBot' },
    ],
    search: {
      provider: 'local',
      options: {
        locales: {
          zh: {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
              modal: {
                displayDetails: '显示详细列表',
                resetButtonTitle: '重置搜索',
                noResultsText: '没有结果',
                footer: { selectText: '选择', navigateText: '导航', closeText: '关闭' },
              },
            },
          },
          'zh-tw': {
            translations: {
              button: { buttonText: '搜尋', buttonAriaLabel: '搜尋' },
              modal: {
                displayDetails: '顯示詳細列表',
                resetButtonTitle: '重置搜尋',
                noResultsText: '無結果',
                footer: { selectText: '選擇', navigateText: '導覽', closeText: '關閉' },
              },
            },
          },
          ja: {
            translations: {
              button: { buttonText: '検索', buttonAriaLabel: '検索' },
              modal: {
                displayDetails: '詳細一覧を表示',
                resetButtonTitle: '検索をリセット',
                noResultsText: '結果なし',
                footer: { selectText: '選択', navigateText: 'ナビゲート', closeText: '閉じる' },
              },
            },
          },
          ko: {
            translations: {
              button: { buttonText: '검색', buttonAriaLabel: '검색' },
              modal: {
                displayDetails: '상세 목록 표시',
                resetButtonTitle: '검색 초기화',
                noResultsText: '결과 없음',
                footer: { selectText: '선택', navigateText: '탐색', closeText: '닫기' },
              },
            },
          },
          fr: {
            translations: {
              button: { buttonText: 'Rechercher', buttonAriaLabel: 'Rechercher' },
              modal: {
                displayDetails: 'Afficher la liste détaillée',
                resetButtonTitle: 'Réinitialiser la recherche',
                noResultsText: 'Aucun résultat',
                footer: { selectText: 'Sélectionner', navigateText: 'Naviguer', closeText: 'Fermer' },
              },
            },
          },
          de: {
            translations: {
              button: { buttonText: 'Suchen', buttonAriaLabel: 'Suchen' },
              modal: {
                displayDetails: 'Detaillierte Liste anzeigen',
                resetButtonTitle: 'Suche zurücksetzen',
                noResultsText: 'Keine Ergebnisse',
                footer: { selectText: 'Auswählen', navigateText: 'Navigieren', closeText: 'Schließen' },
              },
            },
          },
          es: {
            translations: {
              button: { buttonText: 'Buscar', buttonAriaLabel: 'Buscar' },
              modal: {
                displayDetails: 'Mostrar lista detallada',
                resetButtonTitle: 'Restablecer búsqueda',
                noResultsText: 'Sin resultados',
                footer: { selectText: 'Seleccionar', navigateText: 'Navegar', closeText: 'Cerrar' },
              },
            },
          },
          ru: {
            translations: {
              button: { buttonText: 'Поиск', buttonAriaLabel: 'Поиск' },
              modal: {
                displayDetails: 'Показать подробный список',
                resetButtonTitle: 'Сбросить поиск',
                noResultsText: 'Нет результатов',
                footer: { selectText: 'Выбрать', navigateText: 'Навигация', closeText: 'Закрыть' },
              },
            },
          },
          hi: {
            translations: {
              button: { buttonText: 'खोजें', buttonAriaLabel: 'खोजें' },
              modal: {
                displayDetails: 'विस्तृत सूची दिखाएं',
                resetButtonTitle: 'खोज रीसेट करें',
                noResultsText: 'कोई परिणाम नहीं',
                footer: { selectText: 'चुनें', navigateText: 'नेविगेट', closeText: 'बंद करें' },
              },
            },
          },
          ar: {
            translations: {
              button: { buttonText: 'بحث', buttonAriaLabel: 'بحث' },
              modal: {
                displayDetails: 'عرض القائمة التفصيلية',
                resetButtonTitle: 'إعادة تعيين البحث',
                noResultsText: 'لا توجد نتائج',
                footer: { selectText: 'اختر', navigateText: 'تنقل', closeText: 'إغلاق' },
              },
            },
          },
        },
      },
    },
  },
});
