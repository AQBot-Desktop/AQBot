import { computed } from 'vue';
import { useData } from 'vitepress';

/** Locale prefix for internal links, e.g. '' | '/zh' | '/ja' */
export function useLocalePath() {
  const { lang, localeIndex } = useData();

  const prefix = computed(() => {
    // root locale
    if (!localeIndex.value || localeIndex.value === 'root') return '';
    return `/${localeIndex.value}`;
  });

  const isZh = computed(
    () => lang.value === 'zh-CN' || lang.value === 'zh-TW' || localeIndex.value === 'zh' || localeIndex.value === 'zh-tw',
  );

  const isZhCN = computed(() => lang.value === 'zh-CN' || localeIndex.value === 'zh');

  function path(p: string) {
    const clean = p.startsWith('/') ? p : `/${p}`;
    if (clean === '/') return prefix.value ? `${prefix.value}/` : '/';
    return `${prefix.value}${clean}`;
  }

  return { prefix, path, isZh, isZhCN, lang, localeIndex };
}
