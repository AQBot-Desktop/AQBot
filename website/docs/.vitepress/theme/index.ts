import DefaultTheme from 'vitepress/theme';
import { useRouter, inBrowser } from 'vitepress';
import { onMounted } from 'vue';
import type { Theme } from 'vitepress';
import Layout from './Layout.vue';
import HomePage from './components/marketing/HomePage.vue';
import FeaturesPage from './components/marketing/FeaturesPage.vue';
import DownloadHero from './DownloadHero.vue';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/docs.css';
import './styles/prose.css';
import './styles/marketing.css';

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('HomePage', HomePage);
    app.component('FeaturesPage', FeaturesPage);
    app.component('DownloadHero', DownloadHero);
  },
  setup() {
    const router = useRouter();

    onMounted(() => {
      if (!inBrowser) return;

      // Prefer dark as default when no stored preference exists
      try {
        const key = 'vitepress-theme-appearance';
        if (localStorage.getItem(key) == null) {
          localStorage.setItem(key, 'dark');
          document.documentElement.classList.add('dark');
        }
      } catch {
        /* ignore */
      }

      const path = window.location.pathname;
      if (path !== '/' && path !== '') return;
      const lang = navigator.language || navigator.languages?.[0] || '';
      if (/^zh/i.test(lang)) {
        router.go('/zh/');
      }
    });
  },
} satisfies Theme;
