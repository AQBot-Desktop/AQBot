<script setup lang="ts">
import { computed } from 'vue';
import DefaultTheme from 'vitepress/theme';
import LanguageSwitch from './components/LanguageSwitch.vue';
import GroundSwitch from './components/GroundSwitch.vue';
import GitHubBadge from './components/GitHubBadge.vue';
import SiteFooter from './components/SiteFooter.vue';
import { GITHUB_REPO } from './constants';
import { useSiteLocale } from './i18n';

const { Layout } = DefaultTheme;
const locale = useSiteLocale();

const searchPlaceholder = computed(() => {
  switch (locale.value) {
    case 'zh':
      return '搜索文档...';
    case 'zh-tw':
      return '搜尋文件...';
    case 'ja':
      return 'ドキュメントを検索...';
    case 'ko':
      return '문서 검색...';
    case 'ru':
      return 'Поиск по документации...';
    case 'fr':
      return 'Rechercher...';
    case 'de':
      return 'Dokumentation durchsuchen...';
    case 'es':
      return 'Buscar en la documentación...';
    default:
      return 'Search docs...';
  }
});

function triggerSearch() {
  const btn = document.querySelector(
    '#local-search button, .DocSearch-Button',
  ) as HTMLButtonElement | null;
  if (btn) {
    btn.click();
  } else {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true }),
    );
  }
}
</script>

<template>
  <Layout>
    <template #nav-bar-content-after>
      <div class="hd-nav-actions">
        <GitHubBadge />
        <GroundSwitch />
        <LanguageSwitch />
      </div>
    </template>

    <!-- Mobile Drawer Content Before Menu -->
    <template #nav-screen-content-before>
      <div class="hd-drawer-search">
        <button
          type="button"
          class="hd-drawer-search-btn"
          @click="triggerSearch"
        >
          <i class="far fa-compass hd-drawer-search-icon" aria-hidden="true" />
          <span class="hd-drawer-search-text">{{ searchPlaceholder }}</span>
          <kbd class="hd-drawer-search-kbd">⌘K</kbd>
        </button>
      </div>
    </template>

    <!-- Mobile Drawer Content After Menu -->
    <template #nav-screen-content-after>
      <div class="hd-drawer-extra">
        <div class="hd-drawer-section">
          <GroundSwitch variant="screen" />
        </div>
        <div class="hd-drawer-section">
          <LanguageSwitch variant="screen" />
        </div>
        <div class="hd-drawer-section hd-drawer-github">
          <a
            :href="GITHUB_REPO"
            target="_blank"
            rel="noopener"
            class="hd-drawer-github-link"
          >
            <i class="fab fa-github" aria-hidden="true" />
            <span>GitHub Repository</span>
          </a>
        </div>
      </div>
    </template>

    <template #layout-bottom>
      <SiteFooter />
    </template>
  </Layout>
</template>

<style scoped>
.hd-nav-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* ── Mobile Drawer Search ── */
.hd-drawer-search {
  padding: 14px var(--gut);
  border-bottom: 1px solid var(--line);
}

.hd-drawer-search-btn {
  width: 100%;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border: 1px solid var(--line2);
  background: var(--panel);
  color: var(--dim);
  font-family: var(--body);
  font-size: 13px;
  cursor: pointer;
  box-sizing: border-box;
}

.hd-drawer-search-btn:hover {
  border-color: var(--spot);
  color: var(--ink);
}

.hd-drawer-search-icon {
  font-size: 14px;
  width: 14px;
  opacity: 0.7;
}

.hd-drawer-search-text {
  flex: 1;
  text-align: left;
}

.hd-drawer-search-kbd {
  padding: 2px 6px;
  font-family: var(--mono);
  font-size: 10.5px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--faint);
}

/* ── Mobile Drawer Sections ── */
.hd-drawer-extra {
  display: flex;
  flex-direction: column;
}

.hd-drawer-section {
  border-bottom: 1px solid var(--line);
}

.hd-drawer-github-link {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px var(--gut);
  font-family: var(--body);
  font-size: 13.5px;
  font-weight: 500;
  color: var(--dim);
  text-decoration: none !important;
}

.hd-drawer-github-link:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--spot) 6%, transparent);
}
</style>
