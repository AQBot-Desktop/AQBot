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
    <i class="fab fa-github" aria-hidden="true" />
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

.hd-star-badge i {
  font-size: 14px;
  width: 14px;
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
