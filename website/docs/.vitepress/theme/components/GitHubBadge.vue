<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { GITHUB_REPO } from '../constants';

const stars = ref<string>('');

onMounted(async () => {
  try {
    const cached = sessionStorage.getItem('aq_gh_stars');
    if (cached) {
      stars.value = cached;
      return;
    }
    const res = await fetch('https://api.github.com/repos/AQBot-Desktop/AQBot');
    if (res.ok) {
      const data = await res.json();
      if (typeof data.stargazers_count === 'number') {
        const formatted = Number(data.stargazers_count).toLocaleString();
        stars.value = formatted;
        sessionStorage.setItem('aq_gh_stars', formatted);
      }
    }
  } catch {
    // silent failover
  }
});
</script>

<template>
  <a
    class="hd-star-badge"
    :class="{ 'has-stars': Boolean(stars) }"
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
    <b v-if="stars">{{ stars }}</b>
  </a>
</template>

<style scoped>
.hd-star-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  padding: 0 9px;
  gap: 7px;
  border: 1px solid var(--line2);
  color: var(--dim);
  text-decoration: none;
  background: var(--bg);
  box-sizing: border-box;
  transition: color 0.12s ease, border-color 0.12s ease, background-color 0.12s ease;
}

.hd-star-badge svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
  flex-shrink: 0;
}

.hd-star-badge b {
  font-family: var(--mono);
  font-weight: 500;
  font-size: 11.5px;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

.hd-star-badge:hover {
  color: var(--spot);
  border-color: var(--spot);
}

.hd-star-badge:hover b {
  color: var(--spot);
}

@media (max-width: 768px) {
  .hd-star-badge {
    width: 32px;
    height: 32px;
    padding: 0;
    gap: 0;
  }
  .hd-star-badge b {
    display: none;
  }
}
</style>
