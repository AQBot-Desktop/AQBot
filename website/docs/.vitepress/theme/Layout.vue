<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import { useData, useRoute } from 'vitepress';
import { computed } from 'vue';
import SiteFooter from './components/chrome/SiteFooter.vue';
import DocPageCta from './components/docs/DocPageCta.vue';
import BackToTop from './components/chrome/BackToTop.vue';

const { Layout } = DefaultTheme;
const { frontmatter } = useData();
const route = useRoute();

const showDocCta = computed(() => {
  const path = route.path;
  // Guide / docs pages only
  return path.includes('/guide/') || path.includes('/features');
});

const isMarketingPage = computed(() => {
  const layout = frontmatter.value?.layout;
  return layout === 'page' || layout === 'home';
});
</script>

<template>
  <Layout>
    <template #doc-after>
      <DocPageCta v-if="showDocCta && !isMarketingPage" />
    </template>
    <template #layout-bottom>
      <SiteFooter />
      <BackToTop />
    </template>
  </Layout>
</template>
