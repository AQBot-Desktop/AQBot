<script setup lang="ts">
import { computed } from 'vue';
import { useHomeCopy } from '../../composables/useHomeCopy';
import { useLocalePath } from '../../composables/useLocalePath';

const { copy } = useHomeCopy();
const { path } = useLocalePath();

const START_YEAR = 2026;

const copyrightText = computed(() => {
  const year = new Date().getFullYear();
  if (year <= START_YEAR) return `© ${START_YEAR}`;
  return `© ${START_YEAR}-${year}`;
});
</script>

<template>
  <footer class="aq-site-footer">
    <div class="aq-container inner">
      <div class="brand">
        <a :href="path('/')" class="brand-link">
          <img src="/logo.png" alt="AQBot" width="28" height="28" class="logo" />
          <span class="name">AQBot</span>
        </a>
      </div>
      <nav class="links" aria-label="Footer">
        <a :href="path('/features')">{{ copy.footerFeatures }}</a>
        <a :href="path('/download')">{{ copy.footerDownload }}</a>
        <a :href="path('/guide/getting-started')">{{ copy.footerDocs }}</a>
        <a href="https://github.com/AQBot-Desktop/AQBot" target="_blank" rel="noopener">GitHub</a>
      </nav>
      <p class="rights">
        {{ copyrightText }}
        <a :href="path('/')" class="rights-brand">AQBot</a>
      </p>
    </div>
  </footer>
</template>

<style scoped>
.aq-site-footer {
  border-top: 1px solid var(--aq-border);
  background: var(--aq-bg-1);
  padding: 40px 0 32px;
  margin-top: auto;
}

.inner {
  display: grid;
  gap: 20px;
}

.brand {
  display: flex;
  align-items: center;
}

.brand-link {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: inherit;
}

.brand-link:hover .name {
  color: var(--aq-brand);
}

.logo {
  border-radius: 7px;
  flex-shrink: 0;
}

.name {
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--aq-text-1);
  transition: color 0.15s ease;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
}

.links a {
  color: var(--aq-text-2);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: color 0.15s ease;
}

.links a:hover {
  color: var(--aq-brand);
}

.rights {
  margin: 0;
  font-size: 13px;
  color: var(--aq-text-3);
  text-align: center;
  width: 100%;
}

.rights-brand {
  color: var(--aq-text-2);
  text-decoration: none;
  font-weight: 600;
  margin-left: 2px;
  transition: color 0.15s ease;
}

.rights-brand:hover {
  color: var(--aq-brand);
}

@media (min-width: 768px) {
  .inner {
    grid-template-columns: 1fr auto;
    align-items: center;
  }

  .rights {
    grid-column: 1 / -1;
    text-align: center;
  }
}
</style>
