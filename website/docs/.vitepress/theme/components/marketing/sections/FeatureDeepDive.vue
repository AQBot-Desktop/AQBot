<script setup lang="ts">
import { Check } from 'lucide-vue-next';
import { useHomeCopy } from '../../../composables/useHomeCopy';

const { copy } = useHomeCopy();
</script>

<template>
  <section class="aq-section dives">
    <div class="aq-container">
      <article
        v-for="(item, index) in copy.deepDives"
        :key="item.label"
        class="row"
        :class="{ reverse: index % 2 === 1 }"
      >
        <div class="copy">
          <div class="aq-section-label">{{ item.label }}</div>
          <h2 class="title">{{ item.title }}</h2>
          <p class="desc">{{ item.desc }}</p>
          <ul>
            <li v-for="p in item.points" :key="p">
              <Check :size="16" class="check" />
              {{ p }}
            </li>
          </ul>
        </div>
        <div class="visual">
          <div class="shot-frame">
            <div class="shot-bar">
              <span class="shot-tag">shot</span>
              <span class="shot-path">{{ item.label.toLowerCase() }}</span>
            </div>
            <img :src="item.image" :alt="item.title" loading="lazy" />
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.dives {
  padding-top: 24px;
}

.row {
  display: grid;
  gap: 36px;
  align-items: center;
  margin-bottom: 72px;
}

.row:last-child {
  margin-bottom: 0;
}

.title {
  margin: 0 0 12px;
  font-size: clamp(1.5rem, 3vw, 2rem);
  font-weight: 750;
  letter-spacing: -0.03em;
  line-height: 1.2;
  color: var(--aq-text-1);
}

.desc {
  margin: 0 0 20px;
  font-size: 1.02rem;
  line-height: 1.65;
  color: var(--aq-text-2);
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 14px;
  color: var(--aq-text-2);
  line-height: 1.45;
}

.check {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--aq-brand);
}

.shot-frame {
  border-radius: var(--aq-radius-lg);
  border: 1px solid var(--aq-border);
  background: var(--aq-bg-1);
  box-shadow: var(--aq-shadow-glow), var(--aq-shadow-md);
  overflow: hidden;
}

.shot-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  background: var(--aq-bg-2);
  border-bottom: 1px solid var(--aq-border);
  font-family: var(--aq-font-mono);
  font-size: 11px;
}

.shot-tag {
  color: var(--aq-brand);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.shot-path {
  color: var(--aq-text-3);
}

.shot-frame img {
  display: block;
  width: 100%;
  height: auto;
}

@media (min-width: 900px) {
  .row {
    grid-template-columns: 1fr 1.1fr;
    gap: 56px;
  }

  .row.reverse {
    grid-template-columns: 1.1fr 1fr;
  }

  .row.reverse .copy {
    order: 2;
  }

  .row.reverse .visual {
    order: 1;
  }
}
</style>
