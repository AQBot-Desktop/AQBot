<script setup lang="ts">
import { computed } from 'vue';
import GeekHero from '../GeekHero.vue';
import ProofStrip from '../ProofStrip.vue';
import InteractiveClientPlate from '../InteractiveClientPlate.vue';
import ScreenshotCarousel from '../ScreenshotCarousel.vue';
import HowItWorks from '../HowItWorks.vue';
import FeatureBento from '../FeatureBento.vue';
import HomeCta from '../HomeCta.vue';
import { homeCopy, localeHref, useSiteLocale } from '../../i18n';

const locale = useSiteLocale();
const heroCopy = computed(() => homeCopy(locale.value));

const heroProps = computed(() => {
  const tagline = heroCopy.value.tagline;
  if (locale.value === 'zh') {
    return {
      title: '开源多模型 AI 桌面客户端与网关',
      tagline,
      primaryText: '立即下载客户端',
      primaryLink: localeHref(locale.value, '/download'),
      secondaryText: '快速开始入门',
      secondaryLink: localeHref(locale.value, '/guide/getting-started'),
    };
  }
  if (locale.value === 'zh-tw') {
    return {
      title: '開源多模型 AI 桌面客戶端與閘道',
      tagline,
      primaryText: '立即下載客戶端',
      primaryLink: localeHref(locale.value, '/download'),
      secondaryText: '快速開始入門',
      secondaryLink: localeHref(locale.value, '/guide/getting-started'),
    };
  }
  return {
    title: 'Open-Source AI Desktop Client & Gateway',
    tagline,
    primaryText: 'Download for Desktop',
    primaryLink: localeHref(locale.value, '/download'),
    secondaryText: 'Getting Started',
    secondaryLink: localeHref(locale.value, '/guide/getting-started'),
  };
});
</script>

<template>
  <div class="aq-home">
    <GeekHero
      :title="heroProps.title"
      :tagline="heroProps.tagline"
      :primary-text="heroProps.primaryText"
      :primary-link="heroProps.primaryLink"
      :secondary-text="heroProps.secondaryText"
      :secondary-link="heroProps.secondaryLink"
    />

    <ProofStrip />

    <InteractiveClientPlate />

    <ScreenshotCarousel />

    <HowItWorks />

    <FeatureBento />

    <HomeCta
      :primary-link="localeHref(locale, '/download')"
      :secondary-link="localeHref(locale, '/guide/getting-started')"
    />
  </div>
</template>

<style scoped>
.aq-home {
  max-width: 1440px;
  margin: 0 auto;
  padding: 0;
  background: var(--bg);
  position: relative;
  border-left: 1px solid var(--line2);
  border-right: 1px solid var(--line2);
  border-bottom: 1px solid var(--line2);
  box-sizing: border-box;
}

@media (max-width: 900px) {
  .aq-home {
    border-left: 0;
    border-right: 0;
  }
}
</style>
