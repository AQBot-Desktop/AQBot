<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useData } from 'vitepress';
import { themeModeCopy, useSiteLocale } from '../i18n';

const props = withDefaults(
  defineProps<{
    variant?: 'nav' | 'screen';
  }>(),
  { variant: 'nav' },
);

type ThemePreference = 'auto' | 'dark' | 'light';

const { isDark } = useData();
const locale = useSiteLocale();
const open = ref(false);
const preference = ref<ThemePreference>('auto');

const copy = computed(() => themeModeCopy(locale.value));

const currentLabel = computed(() => {
  if (preference.value === 'auto') return copy.value.system;
  if (preference.value === 'dark') return copy.value.dark;
  return copy.value.light;
});

function applyTheme(pref: ThemePreference) {
  if (typeof document === 'undefined') return;

  let shouldBeDark = false;
  if (pref === 'auto') {
    shouldBeDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } else {
    shouldBeDark = pref === 'dark';
  }

  isDark.value = shouldBeDark;
  const mode = shouldBeDark ? 'ink' : 'paper';
  document.documentElement.setAttribute('data-mode', mode);

  if (shouldBeDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

function setPreference(pref: ThemePreference) {
  preference.value = pref;
  try {
    localStorage.setItem('vitepress-theme-appearance', pref);
  } catch {
    /* ignore */
  }
  applyTheme(pref);
  open.value = false;
}

let mediaQuery: MediaQueryList | null = null;

function handleSystemThemeChange() {
  if (preference.value === 'auto') {
    applyTheme('auto');
  }
}

onMounted(() => {
  try {
    const s = (localStorage.getItem('vitepress-theme-appearance') || 'auto') as ThemePreference;
    if (s === 'light' || s === 'dark') {
      preference.value = s;
    } else {
      preference.value = 'auto';
    }
  } catch {
    preference.value = 'auto';
  }

  applyTheme(preference.value);

  if (typeof window !== 'undefined' && window.matchMedia) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', handleSystemThemeChange);
  }
});

onUnmounted(() => {
  if (mediaQuery) {
    mediaQuery.removeEventListener('change', handleSystemThemeChange);
  }
});

watch(isDark, (dark) => {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-mode', dark ? 'ink' : 'paper');
  }
});
</script>

<template>
  <!-- Desktop Nav Variant -->
  <div
    v-if="props.variant === 'nav'"
    class="hd-theme"
    @mouseenter="open = true"
    @mouseleave="open = false"
  >
    <button
      type="button"
      class="hd-theme-btn"
      :aria-expanded="open"
      :aria-label="currentLabel"
      @click="open = !open"
    >
      <!-- Monitor / System Icon -->
      <svg
        v-if="preference === 'auto'"
        class="hd-theme-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        aria-hidden="true"
      >
        <rect width="20" height="14" x="2" y="3" rx="2" />
        <line x1="8" x2="16" y1="21" y2="21" />
        <line x1="12" x2="12" y1="17" y2="21" />
      </svg>
      <!-- Moon Icon (Dark) -->
      <svg
        v-else-if="preference === 'dark'"
        class="hd-theme-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      </svg>
      <!-- Sun Icon (Light) -->
      <svg
        v-else
        class="hd-theme-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>

      <span class="hd-theme-label">{{ currentLabel }}</span>

      <svg class="hd-theme-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <div class="hd-theme-flyout" :class="{ 'is-open': open }">
      <div class="hd-theme-menu">
        <button
          type="button"
          class="hd-theme-item"
          :class="{ 'is-active': preference === 'auto' }"
          @click="setPreference('auto')"
        >
          <svg class="item-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect width="20" height="14" x="2" y="3" rx="2" />
            <line x1="8" x2="16" y1="21" y2="21" />
            <line x1="12" x2="12" y1="17" y2="21" />
          </svg>
          <span>{{ copy.system }}</span>
          <span v-if="preference === 'auto'" class="hd-check">✓</span>
        </button>

        <button
          type="button"
          class="hd-theme-item"
          :class="{ 'is-active': preference === 'dark' }"
          @click="setPreference('dark')"
        >
          <svg class="item-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
          </svg>
          <span>{{ copy.dark }}</span>
          <span v-if="preference === 'dark'" class="hd-check">✓</span>
        </button>

        <button
          type="button"
          class="hd-theme-item"
          :class="{ 'is-active': preference === 'light' }"
          @click="setPreference('light')"
        >
          <svg class="item-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
          </svg>
          <span>{{ copy.light }}</span>
          <span v-if="preference === 'light'" class="hd-check">✓</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Mobile Drawer Screen Variant -->
  <div v-else class="hd-theme-screen">
    <div class="hd-theme-screen-label">Theme</div>
    <div class="hd-theme-screen-grid">
      <button
        type="button"
        class="hd-theme-screen-btn"
        :class="{ 'is-active': preference === 'auto' }"
        @click="setPreference('auto')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="screen-btn-ico">
          <rect width="20" height="14" x="2" y="3" rx="2" />
          <line x1="8" x2="16" y1="21" y2="21" />
          <line x1="12" x2="12" y1="17" y2="21" />
        </svg>
        <span>{{ copy.system }}</span>
      </button>

      <button
        type="button"
        class="hd-theme-screen-btn"
        :class="{ 'is-active': preference === 'dark' }"
        @click="setPreference('dark')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="screen-btn-ico">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
        <span>{{ copy.dark }}</span>
      </button>

      <button
        type="button"
        class="hd-theme-screen-btn"
        :class="{ 'is-active': preference === 'light' }"
        @click="setPreference('light')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="screen-btn-ico">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
        <span>{{ copy.light }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.hd-theme {
  position: relative;
}

.hd-theme-btn {
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

.hd-theme-btn:hover {
  color: var(--spot);
  border-color: var(--spot);
}

.hd-theme-icon {
  width: 13px;
  height: 13px;
}

.hd-theme-arrow {
  width: 11px;
  height: 11px;
  opacity: 0.6;
}

.hd-theme-flyout {
  display: none;
  position: absolute;
  top: 100%;
  right: 0;
  padding-top: 6px;
  z-index: 80;
}

.hd-theme-flyout.is-open {
  display: block;
}

.hd-theme-menu {
  min-width: 140px;
  background: var(--panel);
  border: 1px solid var(--line2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
}

.hd-theme-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: var(--dim);
  font-family: var(--body);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.12s ease, color 0.12s ease;
}

.hd-theme-item:last-child {
  border-bottom: 0;
}

.hd-theme-item:hover {
  background: color-mix(in srgb, var(--spot) 6%, transparent);
  color: var(--ink);
}

.hd-theme-item.is-active {
  color: var(--spot);
  font-weight: 600;
}

.item-ico {
  width: 14px;
  height: 14px;
}

.hd-check {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--spot);
}

/* ── Screen (Mobile Drawer) ── */
.hd-theme-screen {
  padding: 14px var(--gut);
}

.hd-theme-screen-label {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
  margin-bottom: 10px;
}

.hd-theme-screen-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.hd-theme-screen-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 38px;
  border: 1px solid var(--line2);
  background: var(--panel);
  color: var(--dim);
  font-family: var(--body);
  font-size: 12.5px;
  cursor: pointer;
  transition: all 0.12s ease;
}

.screen-btn-ico {
  width: 14px;
  height: 14px;
}

.hd-theme-screen-btn.is-active {
  border-color: var(--spot);
  color: var(--spot);
  background: color-mix(in srgb, var(--spot) 8%, var(--panel));
  font-weight: 600;
}
</style>
