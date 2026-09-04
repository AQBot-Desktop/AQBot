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
          <svg
            class="hd-drawer-search-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
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
            <svg
              viewBox="0 0 16 16"
              width="15"
              height="15"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.64 7.64 0 0 1 8 3.87c.68 0 1.36.09 2 .26 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
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
  width: 14px;
  height: 14px;
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
