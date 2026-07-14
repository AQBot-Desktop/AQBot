<script setup lang="ts">
import {
  Bot,
  Zap,
  Puzzle,
  BookOpen,
  Import,
  Shield,
  Monitor,
  Globe,
} from 'lucide-vue-next';
import { useHomeCopy } from '../../../composables/useHomeCopy';

const { copy } = useHomeCopy();

const icons: Record<string, any> = {
  bot: Bot,
  zap: Zap,
  puzzle: Puzzle,
  book: BookOpen,
  import: Import,
  shield: Shield,
  monitor: Monitor,
  globe: Globe,
};
</script>

<template>
  <section class="aq-section bento-section">
    <div class="aq-container">
      <div class="head">
        <div class="aq-section-label">{{ copy.bentoLabel }}</div>
        <h2 class="aq-section-title">{{ copy.bentoTitle }}</h2>
      </div>
      <div class="grid">
        <article v-for="item in copy.bento" :key="item.title" class="aq-glass card">
          <div class="icon-wrap">
            <component :is="icons[item.icon] || Bot" :size="22" />
          </div>
          <h3>{{ item.title }}</h3>
          <p>{{ item.desc }}</p>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.head {
  margin-bottom: 32px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}

.card {
  padding: 22px 20px;
}

.card:hover {
  transform: translateY(-2px);
}

.icon-wrap {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--aq-brand-soft);
  color: var(--aq-brand);
  margin-bottom: 14px;
}

h3 {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 650;
  color: var(--aq-text-1);
  letter-spacing: -0.01em;
}

p {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--aq-text-2);
}

@media (max-width: 960px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 520px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
