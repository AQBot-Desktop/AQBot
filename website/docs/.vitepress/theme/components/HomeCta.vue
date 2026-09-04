<script setup lang="ts">
import { computed } from 'vue';
import { useSiteLocale } from '../i18n';

const props = defineProps<{
  heading?: string;
  lead?: string;
  steps?: string[];
  primaryText?: string;
  primaryLink?: string;
  secondaryText?: string;
  secondaryLink?: string;
}>();

const locale = useSiteLocale();

const defaultHeading = computed(() => {
  return locale.value === 'zh' || locale.value === 'zh-tw'
    ? '立即体验本地优先的 AI 桌面与网关'
    : 'Start using AQBot today';
});

const defaultLead = computed(() => {
  return locale.value === 'zh' || locale.value === 'zh-tw'
    ? '免费开源、零外部遥测。多模型调度、自主 Agent、本地向量知识库与 API 网关全部开箱即用。'
    : 'Free and open-source. Local-first privacy, multi-model chat, autonomous Agent sandbox, and built-in API gateway.';
});

const defaultSteps = computed(() => {
  if (locale.value === 'zh') {
    return [
      '下载并安装对应平台的桌面安装包',
      '配置云端服务商 API 密钥或连接本地 Ollama',
      '在桌面端与外部开发工具中畅享极致 AI 体验',
    ];
  }
  if (locale.value === 'zh-tw') {
    return [
      '下載並安裝對應平台的桌面安裝包',
      '配置雲端服務商 API 金鑰或連接本地 Ollama',
      '在桌面端與外部開發工具中暢享極致 AI 體驗',
    ];
  }
  return [
    'Download and install for your OS (macOS, Windows, Linux)',
    'Configure your API keys or local Ollama endpoints',
    'Run multi-model chats and point your terminal tools to the local gateway',
  ];
});

const dlText = computed(() => {
  return locale.value === 'zh' || locale.value === 'zh-tw' ? '立即下载' : 'Download Now';
});

const docText = computed(() => {
  return locale.value === 'zh' || locale.value === 'zh-tw' ? '阅读完整文档' : 'Documentation';
});
</script>

<template>
  <section class="hd-cta">
    <div class="hd-cta-in">
      <h2 class="hd-cta-title">{{ heading || defaultHeading }}</h2>
      <p class="hd-cta-lead">{{ lead || defaultLead }}</p>

      <ul class="hd-cta-steps" role="list">
        <li v-for="(step, i) in (steps || defaultSteps)" :key="i">
          <span class="step-num">0{{ i + 1 }}</span>
          <span>{{ step }}</span>
        </li>
      </ul>

      <div class="hd-cta-actions">
        <a class="hd-btn hd-btn-primary" :href="primaryLink || '/download'">
          {{ primaryText || dlText }}
        </a>
        <a class="hd-btn hd-btn-ghost" :href="secondaryLink || '/guide/getting-started'">
          {{ secondaryText || docText }} →
        </a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hd-cta {
  padding: 64px var(--gut);
  background: var(--panel);
  border-bottom: 1px solid var(--line2);
}

.hd-cta-in {
  max-width: 820px;
}

.hd-cta-title {
  font-family: var(--disp);
  font-weight: 900;
  font-size: clamp(28px, 4vw, 48px);
  letter-spacing: -0.04em;
  color: var(--ink);
  line-height: 1.05;
  margin: 0;
}

.hd-cta-lead {
  color: var(--dim);
  font-size: 16px;
  line-height: 1.7;
  margin: 16px 0 0;
}

.hd-cta-steps {
  margin: 28px 0 34px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hd-cta-steps li {
  display: flex;
  align-items: center;
  gap: 12px;
  font-family: var(--body);
  font-size: 14px;
  color: var(--ink);
}

.step-num {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--spot);
  padding: 2px 6px;
  border: 1px solid var(--line2);
  background: var(--bg);
}

.hd-cta-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.hd-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 42px;
  padding: 0 22px;
  font-family: var(--body);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none !important;
  box-sizing: border-box;
  transition: all 0.12s ease;
}

@media (max-width: 640px) {
  .hd-cta {
    padding: 44px var(--gut);
  }
  .hd-btn {
    width: 100%;
  }
}
</style>
