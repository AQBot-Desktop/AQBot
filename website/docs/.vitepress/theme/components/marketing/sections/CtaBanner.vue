<script setup lang="ts">
import { Download, Github } from 'lucide-vue-next';
import { useHomeCopy } from '../../../composables/useHomeCopy';
import { useLocalePath } from '../../../composables/useLocalePath';
import GlowButton from '../../ui/GlowButton.vue';

const { copy } = useHomeCopy();
const { path } = useLocalePath();
</script>

<template>
  <section class="aq-section cta">
    <div class="aq-container">
      <div class="panel-shell">
        <div class="flow-border" aria-hidden="true" />
        <div class="panel">
          <h2>{{ copy.ctaTitle }}</h2>
          <p>{{ copy.ctaDesc }}</p>
          <div class="actions">
            <GlowButton :href="path('/download')" variant="primary">
              <Download :size="18" />
              {{ copy.ctaDownload }}
            </GlowButton>
            <GlowButton href="https://github.com/AQBot-Desktop/AQBot" variant="secondary" external>
              <Github :size="18" />
              {{ copy.ctaGithub }}
            </GlowButton>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cta {
  padding-top: 24px;
  padding-bottom: 80px;
}

.panel-shell {
  position: relative;
  border-radius: var(--aq-radius-xl);
  padding: 1.5px;
  overflow: hidden;
  isolation: isolate;
}

/* Rotating conic beam → brand green streamer */
.flow-border {
  position: absolute;
  inset: -40%;
  z-index: 0;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    transparent 60deg,
    rgba(63, 186, 64, 0.15) 90deg,
    var(--aq-brand) 130deg,
    var(--aq-accent) 155deg,
    var(--aq-brand) 180deg,
    rgba(63, 186, 64, 0.15) 220deg,
    transparent 260deg,
    transparent 360deg
  );
  animation: flow-spin 4.5s linear infinite;
  pointer-events: none;
}

.panel {
  position: relative;
  z-index: 1;
  text-align: center;
  padding: 56px 28px;
  border-radius: calc(var(--aq-radius-xl) - 1.5px);
  background:
    radial-gradient(ellipse 70% 80% at 50% 0%, var(--aq-glow-soft), transparent 60%),
    linear-gradient(180deg, var(--aq-bg-2), var(--aq-bg-1));
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03);
}

/* Soft outer glow matching theme */
.panel-shell::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: 0 0 40px var(--aq-glow-soft), 0 0 80px rgba(63, 186, 64, 0.08);
  pointer-events: none;
  z-index: 2;
}

h2 {
  margin: 0 0 12px;
  font-size: clamp(1.6rem, 3.5vw, 2.25rem);
  font-weight: 800;
  letter-spacing: -0.03em;
  color: var(--aq-text-1);
  line-height: 1.15;
}

p {
  margin: 0 auto 28px;
  max-width: 480px;
  color: var(--aq-text-2);
  line-height: 1.6;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
}

@keyframes flow-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 480px) {
  .actions {
    flex-direction: column;
    align-items: stretch;
    max-width: 280px;
    margin: 0 auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .flow-border {
    animation: none;
    background: linear-gradient(
      120deg,
      var(--aq-brand-2),
      var(--aq-brand),
      var(--aq-accent),
      var(--aq-brand-2)
    );
    inset: 0;
  }
}
</style>
