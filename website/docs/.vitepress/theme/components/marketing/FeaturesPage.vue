<script setup lang="ts">
import { computed } from 'vue';
import { useData } from 'vitepress';
import {
  Bot,
  Zap,
  Puzzle,
  BookOpen,
  Search,
  Code2,
  Server,
  Shield,
  Monitor,
  Import,
  Download,
} from 'lucide-vue-next';
import { useLocalePath } from '../../composables/useLocalePath';
import GlowButton from '../ui/GlowButton.vue';

const { lang, localeIndex } = useData();
const { path, isZhCN } = useLocalePath();

const isZh = computed(
  () => isZhCN.value || localeIndex.value === 'zh-tw' || lang.value.startsWith('zh'),
);

interface Group {
  id: string;
  icon: any;
  title: string;
  items: string[];
}

const groups = computed<Group[]>(() => {
  if (isZh.value) {
    return [
      {
        id: 'chat',
        icon: Bot,
        title: '对话与模型',
        items: [
          '多服务商对话：OpenAI、Claude、Gemini、DeepSeek、Qwen 与兼容端点',
          'aqbot:// 链接与 CC Switch 导入',
          '模型同步、分组、延迟测试与 extra_body',
          '流式回复、分支、压缩与多模型并行',
        ],
      },
      {
        id: 'agent',
        icon: Zap,
        title: 'AI Agent',
        items: ['文件读写与命令执行', '权限分级与工作目录沙箱', '审批 UI 与 token / 成本统计'],
      },
      {
        id: 'roles',
        icon: BookOpen,
        title: '角色',
        items: ['本地角色模板（提示词、头像、采样参数）', '一键新建或应用到当前对话', 'prompts.chat / PlexPt 中文市场'],
      },
      {
        id: 'skills',
        icon: Puzzle,
        title: 'Skills 管理',
        items: ['多来源技能目录（AQBot / Codex / Claude / Agents）', '分组批量启停与卸载', 'skills.sh 与 GitHub 市场'],
      },
      {
        id: 'render',
        icon: Code2,
        title: '内容渲染',
        items: ['Markdown、LaTeX、任务列表', 'Monaco、Mermaid、D2、Artifact', '安全的 HTML 片段预览'],
      },
      {
        id: 'search',
        icon: Search,
        title: '搜索与知识库',
        items: ['Tavily、Exa、智谱、Bocha 等联网搜索', 'sqlite-vec 本地知识库', '检索反馈与上下文附件'],
      },
      {
        id: 'gateway',
        icon: Server,
        title: 'API 网关',
        items: ['OpenAI / Claude / Gemini 兼容本地端点', '密钥、SSL、请求日志', 'Claude Code、Codex 等模板'],
      },
      {
        id: 'import',
        icon: Import,
        title: '导入与备份',
        items: ['ChatGPT / Cherry Studio / Kelivo 导入', '本地、WebDAV、S3 备份恢复', '可选迁移服务商与附件'],
      },
      {
        id: 'security',
        icon: Shield,
        title: '安全',
        items: ['AES-256 本地加密', '双根目录（~/.aqbot + Documents）', '主密钥模式 0600'],
      },
      {
        id: 'desktop',
        icon: Monitor,
        title: '桌面体验',
        items: ['托盘、置顶、全局快捷键', '开机自启、代理、自动更新', '11 种界面语言'],
      },
    ];
  }

  return [
    {
      id: 'chat',
      icon: Bot,
      title: 'Chat & Models',
      items: [
        'Multi-provider chat: OpenAI, Claude, Gemini, DeepSeek, Qwen and compatible APIs',
        'aqbot:// links and CC Switch import',
        'Model sync, groups, latency tests and extra_body',
        'Streaming, branches, compression and multi-model answers',
      ],
    },
    {
      id: 'agent',
      icon: Zap,
      title: 'AI Agent',
      items: ['File edits and shell commands', 'Permission levels and working-directory sandbox', 'Approval UI and token / cost tracking'],
    },
    {
      id: 'roles',
      icon: BookOpen,
      title: 'Roles',
      items: ['Local role templates with prompts and sampling', 'Start new or apply to current chat', 'prompts.chat and community marketplaces'],
    },
    {
      id: 'skills',
      icon: Puzzle,
      title: 'Skills Management',
      items: ['Multi-source skill roots (AQBot / Codex / Claude / Agents)', 'Group enable / disable and uninstall', 'skills.sh and GitHub marketplace'],
    },
    {
      id: 'render',
      icon: Code2,
      title: 'Rich Rendering',
      items: ['Markdown, LaTeX and task lists', 'Monaco, Mermaid, D2 and Artifacts', 'Safe HTML fragment preview'],
    },
    {
      id: 'search',
      icon: Search,
      title: 'Search & Knowledge',
      items: ['Tavily, Exa, Zhipu, Bocha web search with citations', 'Local sqlite-vec knowledge bases', 'Retrieval feedback and context attachments'],
    },
    {
      id: 'gateway',
      icon: Server,
      title: 'API Gateway',
      items: ['Local OpenAI / Claude / Gemini endpoints', 'Keys, SSL and request logs', 'Templates for Claude Code, Codex and more'],
    },
    {
      id: 'import',
      icon: Import,
      title: 'Import & Backup',
      items: ['ChatGPT, Cherry Studio and Kelivo imports', 'Local, WebDAV and S3 backups', 'Optional provider and attachment migration'],
    },
    {
      id: 'security',
      icon: Shield,
      title: 'Security',
      items: ['AES-256 local encryption', 'Dual-root layout (~/.aqbot + Documents)', 'Master key mode 0600 on Unix'],
    },
    {
      id: 'desktop',
      icon: Monitor,
      title: 'Desktop Experience',
      items: ['Tray, always-on-top, global shortcuts', 'Auto-start, proxy and auto-update', '11 interface languages'],
    },
  ];
});

const pageTitle = computed(() => (isZh.value ? '功能特性' : 'Features'));
const pageDesc = computed(() =>
  isZh.value
    ? '本地优先的 AI 桌面工作台：多模型对话、Agent、MCP、知识库与内置网关。'
    : 'A local-first AI desktop workspace: multi-model chat, Agent, MCP, knowledge bases and a built-in gateway.',
);
const cta = computed(() => (isZh.value ? '立即下载' : 'Download now'));
</script>

<template>
  <div class="aq-features-page">
    <div class="aq-container">
      <header class="hero">
        <h1>{{ pageTitle }}</h1>
        <p class="lead">{{ pageDesc }}</p>
        <GlowButton :href="path('/download')" variant="primary">
          <Download :size="18" />
          {{ cta }}
        </GlowButton>
      </header>

      <div class="grid">
        <article v-for="(g, index) in groups" :key="g.id" class="card">
          <div class="card-head">
            <div class="icon">
              <component :is="g.icon" :size="18" />
            </div>
            <div class="head-text">
              <span class="idx">{{ String(index + 1).padStart(2, '0') }}</span>
              <h2>{{ g.title }}</h2>
            </div>
          </div>
          <ul>
            <li v-for="item in g.items" :key="item">{{ item }}</li>
          </ul>
        </article>
      </div>

      <div class="bottom-cta">
        <p>{{ isZh ? '准备好了？下载桌面客户端开始使用。' : 'Ready? Download the desktop client and get started.' }}</p>
        <GlowButton :href="path('/download')" variant="secondary">
          <Download :size="18" />
          {{ cta }}
        </GlowButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.aq-features-page {
  position: relative;
  padding: calc(var(--vp-nav-height) + 56px) 0 88px;
}

.aq-features-page::before {
  content: '';
  pointer-events: none;
  position: absolute;
  left: 50%;
  top: 0;
  transform: translateX(-50%);
  width: min(720px, 90vw);
  height: 280px;
  background: radial-gradient(ellipse at center, var(--aq-glow-soft), transparent 70%);
  z-index: 0;
}

.aq-container {
  position: relative;
  z-index: 1;
}

.hero {
  text-align: center;
  max-width: 640px;
  margin: 0 auto 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: 12px 0 8px;
}

h1 {
  margin: 0;
  font-size: clamp(2.15rem, 5vw, 3rem);
  font-weight: 800;
  letter-spacing: -0.035em;
  line-height: 1.15;
  color: var(--aq-text-1);
}

.lead {
  margin: 0;
  max-width: 36em;
  color: var(--aq-text-2);
  line-height: 1.75;
  font-size: 1.08rem;
  text-wrap: pretty;
  line-break: strict;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
}

.card {
  padding: 20px 20px 18px;
  border-radius: var(--aq-radius-md);
  border: 1px solid var(--aq-border);
  background: var(--aq-elevated);
  transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease, background 0.2s ease;
}

.card:hover {
  border-color: var(--aq-border-hover);
  background: var(--aq-brand-soft);
  box-shadow: 0 0 0 1px var(--aq-glow-soft);
  transform: translateY(-1px);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--aq-bg-1);
  border: 1px solid var(--aq-border);
  color: var(--aq-brand);
  flex-shrink: 0;
}

.head-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.idx {
  font-family: var(--aq-font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--aq-brand);
  letter-spacing: 0.04em;
}

h2 {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--aq-text-1);
  line-height: 1.3;
}

ul {
  margin: 0;
  padding-left: 1.3em;
  list-style-type: disc;
  list-style-position: outside;
}

li {
  display: list-item;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--aq-text-2);
  padding-left: 0.15em;
}

li + li {
  margin-top: 0.4em;
}

li::marker {
  color: var(--aq-brand);
}

.bottom-cta {
  margin-top: 48px;
  padding-top: 32px;
  border-top: 1px solid var(--aq-border);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.bottom-cta p {
  margin: 0;
  color: var(--aq-text-2);
  font-size: 15px;
  line-height: 1.6;
}

@media (max-width: 768px) {
  .grid {
    grid-template-columns: 1fr;
  }

  .bottom-cta {
    flex-direction: column;
    align-items: stretch;
    text-align: center;
  }
}
</style>
