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
        <b>{{ copy.brand }}</b>
      </a>
      <a class="hd-foot-link" :href="copy.docsLink">
        <i class="far fa-file-lines" aria-hidden="true" />
        {{ copy.docs }}
      </a>
      <a class="hd-foot-link" :href="copy.featuresLink">
        <i class="far fa-star" aria-hidden="true" />
        {{ copy.features }}
      </a>
      <a class="hd-foot-link" :href="copy.downloadLink">
        <i class="far fa-circle-down" aria-hidden="true" />
        {{ copy.download }}
      </a>
      <a class="hd-foot-link" :href="licenseUrl" target="_blank" rel="noopener">
        <i class="far fa-copyright" aria-hidden="true" />
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
          <i class="fab fa-github" aria-hidden="true" />
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
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

.hd-foot-ico i {
  font-size: 13px;
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
