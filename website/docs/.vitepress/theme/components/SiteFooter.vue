<script setup lang="ts">
import { computed } from 'vue';
import { APP_VERSION, GITHUB_REPO } from '../constants';
import { footerCopy, localeHref, useSiteLocale } from '../i18n';

const locale = useSiteLocale();

const copy = computed(() => {
  const text = footerCopy(locale.value);
  return {
    brand: 'AQBot',
    docs: text.docs,
    docsLink: localeHref(locale.value, '/guide/getting-started'),
    features: text.features,
    featuresLink: localeHref(locale.value, '/features'),
    download: text.download,
    downloadLink: localeHref(locale.value, '/download'),
    github: text.github,
    license: 'AGPL-3.0',
    version: `v${APP_VERSION}`,
  };
});

const licenseUrl = `${GITHUB_REPO}/blob/main/LICENSE`;
</script>

<template>
  <footer class="hd-foot">
    <div class="hd-foot-inner">
      <a class="hd-foot-brand" :href="localeHref(locale, '/')">
        <img src="/logo.png" alt="AQBot" width="20" height="20" class="hd-foot-logo" />
        <b>aqbot</b>
      </a>
      <a class="hd-foot-link" :href="copy.docsLink">{{ copy.docs }}</a>
      <a class="hd-foot-link" :href="copy.featuresLink">{{ copy.features }}</a>
      <a class="hd-foot-link" :href="copy.downloadLink">{{ copy.download }}</a>
      <a class="hd-foot-link" :href="licenseUrl" target="_blank" rel="noopener">
        {{ copy.license }}
      </a>
      <span class="hd-foot-cr">© 2026 AQBot</span>
      <span class="hd-foot-fact">{{ copy.version }}</span>
      <span class="hd-foot-out">
        <a
          class="hd-foot-ico"
          :href="GITHUB_REPO"
          target="_blank"
          rel="noopener"
          aria-label="AQBot on GitHub"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.64 7.64 0 0 1 8 3.87c.68 0 1.36.09 2 .26 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
            />
          </svg>
        </a>
      </span>
    </div>
  </footer>
</template>

<style scoped>
.hd-foot {
  border-top: 1px solid var(--line2);
  background: var(--bg);
  color: var(--dim);
  font-size: 11.5px;
  position: relative;
  z-index: 50;
  width: 100%;
}

.hd-foot-inner {
  max-width: 1440px;
  margin: 0 auto;
  padding: 22px var(--gut);
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  border-left: 1px solid var(--line2);
  border-right: 1px solid var(--line2);
  box-sizing: border-box;
}

.hd-foot-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  margin-right: 6px;
  color: var(--ink);
}

.hd-foot-logo {
  display: block;
}

.hd-foot-brand b {
  font-family: var(--disp);
  font-weight: 900;
  font-size: 14.5px;
  letter-spacing: -0.03em;
  color: var(--ink);
}

.hd-foot-link {
  color: var(--dim);
  text-decoration: none !important;
  font-family: var(--body);
  transition: color 0.12s ease;
}

.hd-foot-link:hover {
  color: var(--ink);
}

.hd-foot-cr {
  color: var(--faint);
  margin-left: auto;
  font-family: var(--body);
}

.hd-foot-fact {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--faint);
  letter-spacing: 0.04em;
}

.hd-foot-out {
  display: inline-flex;
  align-items: center;
}

.hd-foot-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--line2);
  background: var(--panel);
  color: var(--dim);
  text-decoration: none !important;
  transition: all 0.12s ease;
}

.hd-foot-ico svg {
  width: 13px;
  height: 13px;
  fill: currentColor;
}

.hd-foot-ico:hover {
  color: var(--spot);
  border-color: var(--spot);
}

@media (max-width: 900px) {
  .hd-foot-inner {
    border-left: 0;
    border-right: 0;
    padding: 20px var(--gut);
    gap: 14px;
  }
  .hd-foot-cr {
    margin-left: 0;
    width: 100%;
  }
}
</style>
