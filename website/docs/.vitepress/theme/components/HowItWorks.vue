<script setup lang="ts">
import { computed } from 'vue';
import { useSiteLocale } from '../i18n';

export interface HowStep {
  title: string;
  desc: string;
}

const props = defineProps<{
  heading?: string;
  steps?: HowStep[];
}>();

const locale = useSiteLocale();

const defaultHeading = computed(() => {
  return locale.value === 'zh' || locale.value === 'zh-tw'
    ? '三步开启高效 AI 桌面工作流'
    : 'Three steps to a private AI workspace';
});

const STEP_ICONS = [
  'far fa-circle-down',
  'far fa-handshake',
  'far fa-paper-plane',
] as const;

const defaultSteps = computed<HowStep[]>(() => {
  if (locale.value === 'zh') {
    return [
      {
        title: '下载与安装',
        desc: '支持 macOS (Apple Silicon / Intel)、Windows x64 与主流 Linux 发行版，开箱即用。',
      },
      {
        title: '接入服务商或本地模型',
        desc: '一键填入 OpenAI、Claude、DeepSeek 密钥，或直连本地 Ollama，密钥在本地强加密。',
      },
      {
        title: '启动 Agent 与本地网关',
        desc: '开启多模型对话、MCP 外部工具、本地向量知识库检索，以及本地 127.0.0.1 API 网关。',
      },
    ];
  }
  if (locale.value === 'zh-tw') {
    return [
      {
        title: '下載與安裝',
        desc: '支援 macOS (Apple Silicon / Intel)、Windows x64 與主流 Linux 發行版，開箱即用。',
      },
      {
        title: '接入服務商或本地模型',
        desc: '一鍵填入 OpenAI、Claude、DeepSeek 金鑰，或直連本地 Ollama，金鑰在本地強加密。',
      },
      {
        title: '啟動 Agent 與本地閘道',
        desc: '開啟多模型對話、MCP 外部工具、本地向量知識庫檢索，以及本地 127.0.0.1 API 閘道。',
      },
    ];
  }
  return [
    {
      title: 'Download & Install',
      desc: 'Available for macOS (Apple Silicon / Intel), Windows x64, and Linux distros. Fast native startup.',
    },
    {
      title: 'Connect Providers or Local LLMs',
      desc: 'Plug in your OpenAI, Claude, DeepSeek API keys, or connect Ollama. Keys stay local and encrypted.',
    },
    {
      title: 'Enable Agent & Local Gateway',
      desc: 'Multi-model parallel chat, MCP tools, sqlite-vec knowledge base, and local 127.0.0.1:8080 gateway.',
    },
  ];
});
</script>

<template>
  <section class="hd-how">
    <div class="hd-how-header">
      <h2 class="hd-how-title">
        <i class="far fa-paper-plane" aria-hidden="true" />
        {{ heading || defaultHeading }}
      </h2>
    </div>

    <div class="hd-how-grid">
      <div
        v-for="(step, i) in (steps || defaultSteps)"
        :key="i"
        class="hd-how-card"
      >
        <div class="hd-how-n">
          <span>0{{ i + 1 }}</span>
        </div>
        <div class="hd-how-content">
          <h3 class="hd-how-card-title">
            <i :class="STEP_ICONS[i]" aria-hidden="true" />
            {{ step.title }}
          </h3>
          <p class="hd-how-desc">{{ step.desc }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hd-how {
  padding: 48px var(--gut);
  border-bottom: 1px solid var(--line2);
  background: var(--bg);
}

.hd-how-header {
  margin-bottom: 28px;
}

.hd-how-title {
  font-family: var(--disp);
  font-weight: 900;
  font-size: clamp(26px, 3.5vw, 44px);
  letter-spacing: -0.04em;
  color: var(--ink);
  line-height: 1.05;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.hd-how-title i {
  color: var(--spot);
  font-size: 0.7em;
}

.hd-how-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid var(--line2);
  background: var(--bg);
}

.hd-how-card {
  padding: 24px 22px;
  border-right: 1px solid var(--line);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 14px;
  transition: background-color 0.12s ease;
}

.hd-how-card:last-child {
  border-right: 0;
}

.hd-how-card:hover {
  background: color-mix(in srgb, var(--spot) 4%, var(--panel));
}

.hd-how-n span {
  font-family: var(--disp);
  font-weight: 900;
  font-size: 34px;
  letter-spacing: -0.02em;
  line-height: 1;
  color: var(--line2);
  transition: color 0.12s ease;
}

.hd-how-card:hover .hd-how-n span {
  color: var(--spot);
}

.hd-how-card-title {
  font-family: var(--disp);
  font-weight: 800;
  font-size: 16.5px;
  letter-spacing: -0.02em;
  color: var(--ink);
  margin: 0 0 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.hd-how-card-title i {
  color: var(--spot);
  font-size: 15px;
}

.hd-how-desc {
  font-family: var(--body);
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--dim);
  margin: 0;
}

@media (max-width: 860px) {
  .hd-how-grid {
    grid-template-columns: 1fr;
  }
  .hd-how-card {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .hd-how-card:last-child {
    border-bottom: 0;
  }
}
</style>
