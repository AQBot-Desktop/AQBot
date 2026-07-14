<script setup lang="ts">
import { useHomeCopy } from '../../../composables/useHomeCopy';

const { copy } = useHomeCopy();
/* Enough duplicates so the strip always fills wide viewports and loops seamlessly */
const copies = 4;
</script>

<template>
  <div class="marquee" aria-hidden="true">
    <div class="track">
      <div v-for="n in copies" :key="n" class="group">
        <span v-for="(item, i) in copy.marquee" :key="`${n}-${i}`" class="chip">
          {{ item }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.marquee {
  position: relative;
  overflow: hidden;
  border-block: 1px solid var(--aq-border);
  background: var(--aq-bg-2);
  mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
  padding: 14px 0;
}

.track {
  display: flex;
  width: max-content;
  will-change: transform;
  animation: marquee-scroll 48s linear infinite;
}

.group {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 12px;
  /* half of gap on each side so seam between groups is continuous */
  padding-inline: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--aq-border);
  background: var(--aq-bg-1);
  color: var(--aq-text-2);
  font-size: 13px;
  font-weight: 550;
  white-space: nowrap;
  font-family: var(--aq-font-mono);
  letter-spacing: 0.02em;
}

/* 4 equal groups → shift by one group (25%) for seamless loop */
@keyframes marquee-scroll {
  from {
    transform: translate3d(0, 0, 0);
  }
  to {
    transform: translate3d(-25%, 0, 0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .track {
    animation: none;
  }
}
</style>
