<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { Download, BookOpen, Github } from 'lucide-vue-next';
import { useHomeCopy } from '../../../composables/useHomeCopy';
import { useLocalePath } from '../../../composables/useLocalePath';
import GlowButton from '../../ui/GlowButton.vue';
import HeroAsciiBg from './HeroAsciiBg.vue';

declare const __APP_VERSION__: string;

const { copy } = useHomeCopy();
const { path } = useLocalePath();
const version = __APP_VERSION__;
const os = ref<'macos' | 'windows' | 'linux'>('macos');

onMounted(() => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) os.value = 'windows';
  else if (ua.includes('linux')) os.value = 'linux';
  else os.value = 'macos';
});

const osLabel = computed(() => {
  if (os.value === 'windows') return 'Windows';
  if (os.value === 'linux') return 'Linux';
  return 'macOS';
});
</script>

<template>
  <section class="hero">
    <HeroAsciiBg />
    <div class="hero-glow" aria-hidden="true" />
    <div class="aq-container hero-inner">
      <div class="badge">
        <span class="dot" />
        {{ copy.badge }}
      </div>
      <h1 class="title">
        {{ copy.title }}
        <span class="highlight">{{ copy.titleHighlight }}</span>
      </h1>
      <p class="subtitle">{{ copy.subtitle }}</p>
      <div class="actions">
        <GlowButton :href="path('/download')" variant="primary">
          <Download :size="18" />
          {{ copy.download }} · {{ osLabel }}
          <span class="ver">v{{ version }}</span>
        </GlowButton>
        <GlowButton :href="path('/guide/getting-started')" variant="secondary">
          <BookOpen :size="18" />
          {{ copy.docs }}
        </GlowButton>
        <GlowButton href="https://github.com/AQBot-Desktop/AQBot" variant="ghost" external>
          <Github :size="18" />
          {{ copy.github }}
        </GlowButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hero {
  position: relative;
  /* +15px bottom spacing before marquee tags */
  padding: calc(var(--vp-nav-height) + 56px) 0 71px;
  overflow: hidden;
}

.hero-inner {
  position: relative;
  z-index: 2;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--aq-border);
  background: var(--aq-elevated);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--aq-text-2);
  margin-bottom: 28px;
  backdrop-filter: blur(6px);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--aq-brand);
  box-shadow: 0 0 10px var(--aq-glow);
}

.title {
  margin: 0;
  font-size: clamp(2.4rem, 6vw, 4rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.05;
  color: var(--aq-text-1);
  max-width: 16ch;
  text-shadow: 0 2px 24px rgba(0, 0, 0, 0.35);
}

.highlight {
  display: inline-block;
  background: linear-gradient(120deg, var(--aq-brand), var(--aq-accent));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.subtitle {
  margin: 20px 0 0;
  max-width: 560px;
  font-size: clamp(1rem, 2vw, 1.15rem);
  line-height: 1.65;
  color: var(--aq-text-2);
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.4);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  margin-top: 36px;
  width: 100%;
}

.ver {
  opacity: 0.75;
  font-weight: 500;
  font-size: 13px;
}

.hero-glow {
  position: absolute;
  left: 50%;
  top: 42%;
  transform: translate(-50%, -50%);
  width: min(720px, 90vw);
  height: 320px;
  background: radial-gradient(ellipse at center, var(--aq-glow-soft), transparent 70%);
  pointer-events: none;
  z-index: 1;
}

@media (max-width: 640px) {
  .hero {
    padding: calc(var(--vp-nav-height) + 40px) 0 55px;
  }

  .actions {
    flex-direction: column;
    align-items: stretch;
    max-width: 320px;
  }
}
</style>
