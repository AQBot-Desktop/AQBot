<script setup lang="ts">
import { AppleOutlined, WindowsOutlined } from '@ant-design/icons-vue';
import { useHomeCopy } from '../../../composables/useHomeCopy';
import LinuxIcon from '../../ui/LinuxIcon.vue';

const { copy } = useHomeCopy();
</script>

<template>
  <section class="aq-section strip">
    <div class="aq-container">
      <div class="aq-section-label center">{{ copy.platformLabel }}</div>
      <div class="grid">
        <div v-for="p in copy.platforms" :key="p.title" class="aq-glass item">
          <div class="icon-wrap">
            <AppleOutlined v-if="p.icon === 'macos'" class="os-icon" />
            <WindowsOutlined v-else-if="p.icon === 'windows'" class="os-icon" />
            <LinuxIcon v-else class="os-icon" :size="22" />
          </div>
          <div class="title">{{ p.title }}</div>
          <div class="desc">{{ p.desc }}</div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.strip {
  padding-top: 24px;
  padding-bottom: 48px;
}

.center {
  display: flex;
  justify-content: center;
  width: 100%;
  margin-bottom: 20px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  max-width: 900px;
  margin: 0 auto;
}

.item {
  text-align: center;
  padding: 24px 16px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.item:hover {
  transform: translateY(-2px);
}

.item:hover .icon-wrap {
  background: var(--aq-brand-soft);
  color: var(--aq-brand);
  border-color: rgba(63, 186, 64, 0.35);
}

.icon-wrap {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 12px;
  background: var(--aq-elevated);
  border: 1px solid var(--aq-border);
  color: var(--aq-text-1);
  transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}

.os-icon {
  font-size: 22px;
  width: 22px;
  height: 22px;
}

.title {
  font-weight: 700;
  color: var(--aq-text-1);
  margin-bottom: 4px;
  letter-spacing: -0.02em;
  font-size: 16px;
}

.desc {
  font-size: 13px;
  color: var(--aq-text-3);
}

@media (max-width: 640px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
