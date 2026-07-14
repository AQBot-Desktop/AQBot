<script setup lang="ts">
import { useHomeCopy } from '../../composables/useHomeCopy';
import { useLocalePath } from '../../composables/useLocalePath';
import GlowButton from '../ui/GlowButton.vue';
import { Download } from 'lucide-vue-next';

const { copy } = useHomeCopy();
const { path } = useLocalePath();
</script>

<template>
  <div class="doc-cta">
    <div class="doc-cta-inner">
      <div>
        <h3>{{ copy.docCtaTitle }}</h3>
        <p>{{ copy.docCtaDesc }}</p>
      </div>
      <GlowButton :href="path('/download')" variant="primary">
        <Download :size="18" />
        {{ copy.docCtaBtn }}
      </GlowButton>
    </div>
  </div>
</template>

<style scoped>
.doc-cta {
  margin: 40px 0 8px;
}

.doc-cta-inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 24px 28px;
  border-radius: var(--aq-radius-lg);
  border: 1px solid var(--aq-border);
  background:
    radial-gradient(ellipse 80% 120% at 100% 0%, var(--aq-glow-soft), transparent 55%),
    var(--aq-elevated);
}

h3 {
  margin: 0 0 6px;
  font-size: 1.15rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--aq-text-1);
}

p {
  margin: 0;
  font-size: 14px;
  color: var(--aq-text-2);
  line-height: 1.5;
  max-width: 420px;
}
</style>
