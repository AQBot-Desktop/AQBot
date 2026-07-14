<script setup lang="ts">
withDefaults(
  defineProps<{
    href: string;
    variant?: 'primary' | 'secondary' | 'ghost';
    external?: boolean;
  }>(),
  { variant: 'primary', external: false },
);
</script>

<template>
  <a
    :href="href"
    class="aq-btn"
    :class="[`aq-btn--${variant}`]"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noopener noreferrer' : undefined"
  >
    <slot />
  </a>
</template>

<style scoped>
.aq-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 48px;
  padding: 0 22px;
  border-radius: 999px;
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
  transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease, border-color 0.2s ease;
  cursor: pointer;
  border: 1px solid transparent;
}

.aq-btn--primary {
  background: var(--aq-brand);
  color: var(--aq-btn-primary-text, #ffffff);
  box-shadow: 0 0 0 1px rgba(63, 186, 64, 0.3), 0 8px 28px var(--aq-glow-soft);
}

.aq-btn--primary:hover {
  background: var(--aq-brand-2);
  color: var(--aq-btn-primary-text, #ffffff);
  transform: translateY(-1px);
  box-shadow: 0 0 0 1px rgba(63, 186, 64, 0.45), 0 12px 36px var(--aq-glow);
}

.aq-btn--primary :deep(svg) {
  color: inherit;
  stroke: currentColor;
}

.aq-btn--secondary {
  background: var(--aq-elevated);
  color: var(--aq-text-1);
  border-color: var(--aq-border-strong);
}

.aq-btn--secondary:hover {
  border-color: var(--aq-border-hover);
  background: var(--aq-elevated-hover);
  transform: translateY(-1px);
}

.aq-btn--ghost {
  background: transparent;
  color: var(--aq-text-2);
  border-color: var(--aq-border);
}

.aq-btn--ghost:hover {
  color: var(--aq-text-1);
  border-color: var(--aq-border-hover);
}

@media (max-width: 480px) {
  .aq-btn {
    width: 100%;
    height: 46px;
    font-size: 14px;
  }
}
</style>
