<script setup lang="ts">
import { computed } from 'vue';
import { generalUiCopy, useSiteLocale } from '../i18n';

defineProps<{
  title: string;
  tagline: string;
  primaryText: string;
  primaryLink: string;
  secondaryText: string;
  secondaryLink: string;
}>();

const locale = useSiteLocale();
const generalCopy = computed(() => generalUiCopy(locale.value));
</script>

<template>
  <header class="hd-hero">
    <!-- Faint background ghost logo watermark -->
    <div class="ghost-logo" aria-hidden="true">
      <svg viewBox="0 0 512 512" fill="currentColor">
        <mask id="hero-cutout" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <rect width="512" height="512" fill="#fff" />
          <path d="M252 111 139 400" fill="none" stroke="#000" stroke-width="41" stroke-linecap="round" />
          <path d="M290 189.5 371 399.5" fill="none" stroke="#000" stroke-width="41" stroke-linecap="round" />
          <path d="M211 366.5 C222 366.2 232 364.4 253 363 C268 362 280 362 290 362.5 C304 363 305 384.5 290 386.5 C275 387 253 386.5 232 384.5 C222 383.5 216 382.5 211 382.5 Z" fill="#000" transform="translate(255.5 375.25) scale(.99 .962) translate(-255 -374.5)" />
          <path d="M309.5 110.5 C296 110.5 288 118 288 127 L288 136 C288 143 294 149 301 149 C307 150 315 150 321 149 C328 148 332 142 332 135 L332 127 C332 118 323 110.5 309.5 110.5 Z" fill="#000" />
        </mask>
        <circle cx="256" cy="256" r="256" fill="currentColor" mask="url(#hero-cutout)" />
      </svg>
    </div>

    <div class="hd-hero-in">
      <h1 class="hd-hero-title">
        {{ title }}
      </h1>

      <p class="hd-hero-lede">{{ tagline }}</p>

      <div class="hd-hero-go">
        <a class="hd-btn hd-btn-primary" :href="primaryLink">
          <i class="far fa-circle-down" aria-hidden="true" />
          {{ primaryText }}
        </a>
        <a class="hd-btn hd-btn-ghost" :href="secondaryLink">
          <i class="far fa-file-lines" aria-hidden="true" />
          {{ secondaryText }}
        </a>
      </div>

      <div class="hd-hero-meta">
        <span class="hd-hero-os" aria-hidden="true">
          <i class="fab fa-apple" />
          <i class="fab fa-windows" />
          <i class="fab fa-linux" />
        </span>
        <span>macOS Apple Silicon &amp; Intel · Windows x64 · Linux · AGPL-3.0</span>
        <span class="meta-sep">—</span>
        <a :href="primaryLink">
          <i class="far fa-share-from-square" aria-hidden="true" />
          {{ generalCopy.allDownloads }}
        </a>
      </div>
    </div>
  </header>
</template>

<style scoped>
.hd-hero {
  position: relative;
  overflow: hidden;
  padding: 68px var(--gut) 52px;
  background: var(--bg);
}

.ghost-logo {
  position: absolute;
  right: -6%;
  top: 50%;
  transform: translateY(-50%);
  width: min(620px, 50vw);
  height: min(620px, 50vw);
  color: var(--mass);
  opacity: 0.55;
  z-index: 0;
  pointer-events: none;
}

.ghost-logo svg {
  width: 100%;
  height: 100%;
}

.hd-hero-in {
  position: relative;
  z-index: 1;
  max-width: 980px;
}

.hd-hero-title {
  font-family: var(--disp);
  font-weight: 900;
  letter-spacing: -0.045em;
  line-height: 1.06;
  font-size: clamp(34px, 5.2vw, 72px);
  margin: 0;
  color: var(--ink);
  max-width: 22ch;
}

.hd-hero-lede {
  color: var(--dim);
  font-size: 16px;
  line-height: 1.7;
  max-width: 52em;
  margin: 22px 0 0;
}

.hd-hero-go {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 32px;
  flex-wrap: wrap;
}

/* ── Action Buttons ── */
.hd-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 42px;
  padding: 0 20px;
  font-family: var(--body);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none !important;
  box-sizing: border-box;
  transition: all 0.12s ease;
}

.hd-hero-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 26px;
  color: var(--faint);
  font-size: 12px;
}

.meta-sep {
  opacity: 0.5;
}

.hd-hero-os {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--spot);
}

.hd-hero-os i {
  font-size: 13px;
}

.hd-hero-meta a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--spot);
  text-decoration: none;
}

.hd-hero-meta a:hover {
  text-decoration: underline;
}

@media (max-width: 900px) {
  .hd-hero {
    padding: 48px var(--gut) 40px;
  }
}

@media (max-width: 640px) {
  .hd-hero-go {
    gap: 10px;
  }
  .hd-btn {
    width: 100%;
  }
}
</style>
