<script setup lang="ts">
import { computed, ref } from 'vue';
import { useData, useRouter, withBase } from 'vitepress';
import { LOCALE_CONFIG, type SiteLocale, useSiteLocale } from '../i18n';

const props = withDefaults(
  defineProps<{
    variant?: 'nav' | 'screen';
  }>(),
  { variant: 'nav' },
);

const { page, hash } = useData();
const router = useRouter();
const open = ref(false);
const currentLocale = useSiteLocale();

const currentLabel = computed(() => {
  return LOCALE_CONFIG[currentLocale.value]?.label || 'English';
});

function getLocaleTargetHref(targetLocale: SiteLocale): string {
  // Extract relative path without locale prefix
  let raw = page.value.relativePath.replace(/\\/g, '/');
  // strip extension .md
  raw = raw.replace(/\.md$/, '');
  if (raw.endsWith('/index')) {
    raw = raw.slice(0, -6);
  } else if (raw === 'index') {
    raw = '';
  }

  // Remove any leading locale prefix from path
  const prefixes = Object.values(LOCALE_CONFIG)
    .map((c) => c.prefix.replace(/^\//, ''))
    .filter(Boolean);

  let stripped = raw;
  for (const p of prefixes) {
    if (stripped === p) {
      stripped = '';
      break;
    } else if (stripped.startsWith(`${p}/`)) {
      stripped = stripped.slice(p.length + 1);
      break;
    }
  }

  const targetPrefix = LOCALE_CONFIG[targetLocale].prefix;
  let result = '';
  if (!targetPrefix) {
    result = stripped ? `/${stripped}` : '/';
  } else {
    result = stripped ? `${targetPrefix}/${stripped}` : `${targetPrefix}/`;
  }

  const h = hash.value || '';
  return `${result}${h}`;
}

const items = computed(() => {
  const keys = Object.keys(LOCALE_CONFIG) as SiteLocale[];
  return keys.map((key) => {
    return {
      key,
      label: LOCALE_CONFIG[key].label,
      href: getLocaleTargetHref(key),
      active: key === currentLocale.value,
    };
  });
});

function go(href: string) {
  open.value = false;
  if (typeof document !== 'undefined') {
    const hamburger = document.querySelector(
      '.VPNavBarHamburger.active',
    ) as HTMLButtonElement | null;
    if (hamburger) {
      hamburger.click();
    }
  }
  router.go(href);
}
</script>

<template>
  <div
    v-if="props.variant === 'nav'"
    class="hd-lang"
    @mouseenter="open = true"
    @mouseleave="open = false"
  >
    <button
      type="button"
      class="hd-lang-btn"
      :aria-expanded="open"
      aria-label="Change language"
      @click="open = !open"
    >
      <svg
        class="hd-lang-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20M12 2a14.5 14.5 0 0 1 0 20M2 12h20" />
      </svg>
      <span class="hd-lang-label">{{ currentLabel }}</span>
      <svg
        class="hd-lang-arrow"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <div class="hd-lang-flyout" :class="{ 'is-open': open }">
      <ul class="hd-lang-list" role="list">
        <li v-for="item in items" :key="item.key">
          <span v-if="item.active" class="hd-lang-item is-active" aria-current="page">
            <span>{{ item.label }}</span>
            <span class="hd-lang-check" aria-hidden="true">✓</span>
          </span>
          <a
            v-else
            class="hd-lang-item"
            :href="withBase(item.href)"
            @click.prevent="go(item.href)"
          >
            <span>{{ item.label }}</span>
          </a>
        </li>
      </ul>
    </div>
  </div>

  <div v-else class="hd-lang-screen">
    <div class="hd-lang-screen-title">Language</div>
    <ul class="hd-lang-screen-list" role="list">
      <li v-for="item in items" :key="item.key">
        <span v-if="item.active" class="hd-lang-screen-item is-active">
          <span>{{ item.label }}</span>
          <span class="hd-lang-check">✓</span>
        </span>
        <a
          v-else
          class="hd-lang-screen-item"
          :href="withBase(item.href)"
          @click.prevent="go(item.href)"
        >
          <span>{{ item.label }}</span>
        </a>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.hd-lang {
  position: relative;
}

.hd-lang-btn {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 10px;
  gap: 7px;
  border: 1px solid var(--line2);
  background: var(--bg);
  color: var(--dim);
  cursor: pointer;
  box-sizing: border-box;
  font-family: var(--body);
  font-size: 11.5px;
  font-weight: 500;
  transition: color 0.12s ease, border-color 0.12s ease;
}

.hd-lang-btn:hover {
  color: var(--spot);
  border-color: var(--spot);
}

.hd-lang-icon {
  width: 13px;
  height: 13px;
}

.hd-lang-arrow {
  width: 11px;
  height: 11px;
  opacity: 0.6;
}

.hd-lang-flyout {
  display: none;
  position: absolute;
  top: 100%;
  right: 0;
  padding-top: 6px;
  z-index: 80;
}

.hd-lang-flyout.is-open {
  display: block;
}

.hd-lang-list {
  margin: 0;
  padding: 0;
  list-style: none;
  min-width: 170px;
  max-height: 340px;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--line2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
}

.hd-lang-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  color: var(--dim);
  font-family: var(--body);
  font-size: 13px;
  text-decoration: none !important;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}

li:last-child .hd-lang-item {
  border-bottom: 0;
}

.hd-lang-item:hover {
  background: color-mix(in srgb, var(--spot) 6%, transparent);
  color: var(--ink);
}

.hd-lang-item.is-active {
  color: var(--spot);
  font-weight: 600;
}

.hd-lang-check {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--spot);
}

/* ── Screen (Mobile Drawer) ── */
.hd-lang-screen {
  padding: 14px var(--gut);
}

.hd-lang-screen-title {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
  margin-bottom: 10px;
}

.hd-lang-screen-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.hd-lang-screen-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 38px;
  padding: 0 12px;
  font-family: var(--body);
  font-size: 12.5px;
  color: var(--dim);
  border: 1px solid var(--line2);
  background: var(--panel);
  text-decoration: none !important;
  box-sizing: border-box;
  cursor: pointer;
  transition: all 0.12s ease;
}

.hd-lang-screen-item:hover {
  border-color: var(--spot);
  color: var(--ink);
}

.hd-lang-screen-item.is-active {
  border-color: var(--spot);
  color: var(--spot);
  background: color-mix(in srgb, var(--spot) 8%, var(--panel));
  font-weight: 600;
}
</style>
