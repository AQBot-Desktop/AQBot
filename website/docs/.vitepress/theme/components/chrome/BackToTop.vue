<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { ChevronUp } from 'lucide-vue-next';

const visible = ref(false);
const THRESHOLD = 320;

function onScroll() {
  visible.value = window.scrollY > THRESHOLD;
}

function scrollTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

onMounted(() => {
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll);
});
</script>

<template>
  <Transition name="btt">
    <button
      v-show="visible"
      type="button"
      class="back-to-top"
      aria-label="Back to top"
      title="Back to top"
      @click="scrollTop"
    >
      <ChevronUp :size="20" stroke-width="2.25" />
    </button>
  </Transition>
</template>

<style scoped>
.back-to-top {
  position: fixed;
  right: 20px;
  bottom: 28px;
  z-index: 40;
  width: 42px;
  height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid var(--aq-border-strong);
  background: var(--aq-bg-1);
  color: var(--aq-text-1);
  box-shadow: var(--aq-shadow-md), 0 0 24px var(--aq-glow-soft);
  cursor: pointer;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  transition:
    transform 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease,
    box-shadow 0.2s ease,
    background 0.2s ease;
}

.back-to-top:hover {
  color: var(--aq-brand);
  border-color: var(--aq-border-hover);
  background: var(--aq-elevated-hover);
  transform: translateY(-2px);
  box-shadow: 0 0 0 1px var(--aq-glow-soft), var(--aq-shadow-md);
}

.back-to-top:active {
  transform: translateY(0);
}

.btt-enter-active,
.btt-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.btt-enter-from,
.btt-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.92);
}

@media (max-width: 640px) {
  .back-to-top {
    right: 14px;
    bottom: 18px;
    width: 40px;
    height: 40px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .back-to-top,
  .btt-enter-active,
  .btt-leave-active {
    transition: none;
  }
}
</style>
