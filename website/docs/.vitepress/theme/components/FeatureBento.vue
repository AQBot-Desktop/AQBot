<script setup lang="ts">
import { computed } from 'vue';
import { localeHref, useSiteLocale } from '../i18n';

export interface BentoItem {
  title: string;
  desc: string;
  link?: string;
}

const props = defineProps<{
  heading?: string;
  lead?: string;
  items?: BentoItem[];
}>();

const locale = useSiteLocale();

const defaultHeading = computed(() => {
  return locale.value === 'zh' || locale.value === 'zh-tw'
    ? '为开发者与重度用户设计的能力集'
    : 'Engineered for Developers and Power Users';
});

const defaultLead = computed(() => {
  return locale.value === 'zh' || locale.value === 'zh-tw'
    ? '多模型统一对话、自主 Agent 审批、本地 API 网关与向量知识库，在一个开箱即用的桌面端全部就绪。'
    : 'Unified multi-model chat, autonomous Agent approval, local API gateway, and vector knowledge base in one native desktop app.';
});

const BENTO_ICONS = [
  'far fa-comments',
  'far fa-share-from-square',
  'far fa-user',
  'far fa-object-group',
  'far fa-folder-open',
  'far fa-id-badge',
  'far fa-file-code',
  'far fa-hard-drive',
] as const;

const defaultItems = computed<BentoItem[]>(() => {
  if (locale.value === 'zh') {
    return [
      {
        title: '多服务商模型聚合对话',
        desc: '原生支持 OpenAI、Claude、Gemini、DeepSeek、Qwen 与 Ollama 等 50+ 服务商，支持多模型并行对比与分支会话。',
        link: '/guide/providers',
      },
      {
        title: '内置本地 AI 兼容网关',
        desc: '监听 127.0.0.1:8080 提供标准化 OpenAI 端点，让 Claude Code、Codex、Cursor 与终端工具直接复用所有配置。',
        link: '/guide/gateway',
      },
      {
        title: '自主 AI Agent 与权限沙箱',
        desc: '支持文件读写与终端命令执行；严格的审批 UI 与工作目录沙箱保护本地文件，实时统计 token 与消耗。',
        link: '/guide/getting-started',
      },
      {
        title: 'MCP (Model Context Protocol) 扩展',
        desc: '内置官方 MCP 协议客户端，轻松接入外部工具、数据库连接器与第三方资源，拓展 LLM 能力边界。',
        link: '/guide/mcp',
      },
      {
        title: '基于 sqlite-vec 的本地向量知识库',
        desc: '轻量进程内嵌入检索，支持 Markdown、代码与文档切片，检索与问答完全在本地设备完成，零数据泄露。',
        link: '/guide/getting-started',
      },
      {
        title: '角色预设与提示词市场',
        desc: '内置角色模板，支持自定义系统提示词、温度与采样参数，深度兼容 prompts.chat 中文与英文市场。',
        link: '/guide/getting-started',
      },
      {
        title: '代码与科学内容深度渲染',
        desc: '原生支持 LaTeX 数学公式、Mermaid 流程图、D2 架构图、Monaco 高亮编辑器与安全的 HTML Artifacts 交互沙箱。',
        link: '/guide/getting-started',
      },
      {
        title: 'AES-256 本地加密与多端备份',
        desc: '所有 API Key 与会话在本地通过主密钥加密；支持 WebDAV 与 S3 备份还原，可自由选择迁移服务商或附件。',
        link: '/guide/getting-started',
      },
    ];
  }
  if (locale.value === 'zh-tw') {
    return [
      {
        title: '多服務商模型聚合對話',
        desc: '原生支援 OpenAI、Claude、Gemini、DeepSeek、Qwen 與 Ollama 等 50+ 服務商，支援多模型平行對比與分支會話。',
        link: '/guide/providers',
      },
      {
        title: '內建本地 AI 相容閘道',
        desc: '監聽 127.0.0.1:8080 提供標準化 OpenAI 端點，讓 Claude Code、Codex、Cursor 與終端工具直接複用所有配置。',
        link: '/guide/gateway',
      },
      {
        title: '自主 AI Agent 與權限沙箱',
        desc: '支援文件讀寫與終端命令執行；嚴格的審批 UI 與工作目錄沙箱保護本地文件，即時統計 token 與消耗。',
        link: '/guide/getting-started',
      },
      {
        title: 'MCP (Model Context Protocol) 擴充',
        desc: '內建官方 MCP 協議客戶端，輕鬆接入外部工具、資料庫連接器與第三方資源，拓展 LLM 能力邊界。',
        link: '/guide/mcp',
      },
      {
        title: '基於 sqlite-vec 的本地向量知識庫',
        desc: '輕量進程內嵌入檢索，支援 Markdown、程式碼與文件切片，檢索與問答完全在本地設備完成，零資料洩漏。',
        link: '/guide/getting-started',
      },
      {
        title: '角色預設與提示詞市場',
        desc: '內建角色模板，支援自訂系統提示詞、溫度與取樣參數，深度相容 prompts.chat 中文與英文市場。',
        link: '/guide/getting-started',
      },
      {
        title: '程式碼與科學內容深度渲染',
        desc: '原生支援 LaTeX 數學公式、Mermaid 流程圖、D2 架構圖、Monaco 高亮編輯器與安全的 HTML Artifacts 互動沙箱。',
        link: '/guide/getting-started',
      },
      {
        title: 'AES-256 本地加密與多端備份',
        desc: '所有 API Key 與會話在本地透過主密鑰加密；支援 WebDAV 與 S3 備份還原，可自由選擇遷移服務商或附件。',
        link: '/guide/getting-started',
      },
    ];
  }
  return [
    {
      title: 'Multi-Provider Model Routing',
      desc: 'Connect 50+ providers including OpenAI, Claude, Gemini, DeepSeek, and local Ollama. Compare models side-by-side.',
      link: '/guide/providers',
    },
    {
      title: 'Built-in Local API Gateway',
      desc: 'Runs at 127.0.0.1:8080 with OpenAI-compatible endpoints. Share keys & models directly with Claude Code, Codex, and Cursor.',
      link: '/guide/gateway',
    },
    {
      title: 'Autonomous Agent & Sandbox',
      desc: 'Executes file edits and terminal commands with workspace sandboxing and explicit user confirmation dialogs.',
      link: '/guide/getting-started',
    },
    {
      title: 'Model Context Protocol (MCP)',
      desc: 'Official Model Context Protocol support. Connect database connectors, terminal utilities, and external APIs directly.',
      link: '/guide/mcp',
    },
    {
      title: 'sqlite-vec Local Knowledge Base',
      desc: 'In-process vector embeddings for PDF, Markdown, and codebase documents. Complete privacy with zero cloud indexing.',
      link: '/guide/getting-started',
    },
    {
      title: 'Roles & Prompt Marketplace',
      desc: 'Configure system instructions, sampling temperatures, and import curated personas from community prompt markets.',
      link: '/guide/getting-started',
    },
    {
      title: 'Deep Content & Diagram Rendering',
      desc: 'Built-in support for LaTeX formulas, Mermaid diagrams, D2 architectures, Monaco code editor, and interactive Artifacts.',
      link: '/guide/getting-started',
    },
    {
      title: 'AES-256 Encryption & S3/WebDAV Sync',
      desc: 'API keys stay on your machine encrypted with AES-256. Optional backup snapshots to WebDAV, S3, or local disks.',
      link: '/guide/getting-started',
    },
  ];
});
</script>

<template>
  <section class="hd-capabilities">
    <div class="hd-caps-header">
      <h2 class="hd-caps-title">
        <i class="far fa-object-group" aria-hidden="true" />
        {{ heading || defaultHeading }}
      </h2>
      <p class="hd-caps-lead">{{ lead || defaultLead }}</p>
    </div>

    <!-- ── Full-Width Horizontal Rows (01 ~ 08) ── -->
    <div class="caps">
      <a
        v-for="(item, i) in (items || defaultItems)"
        :key="i"
        class="cap"
        :href="localeHref(locale, item.link || '/guide/getting-started')"
      >
        <div class="n">
          <span>0{{ i + 1 }}</span>
        </div>

        <div class="cap-title-col">
          <h3 class="cap-title">
            <i :class="BENTO_ICONS[i]" aria-hidden="true" />
            <span>{{ item.title }}</span>
            <i class="far fa-circle-right arw" aria-hidden="true" />
          </h3>
        </div>

        <div class="cap-desc-col">
          <p class="cap-desc">{{ item.desc }}</p>
        </div>
      </a>
    </div>
  </section>
</template>

<style scoped>
.hd-capabilities {
  background: var(--bg);
  border-bottom: 1px solid var(--line2);
}

.hd-caps-header {
  padding: 48px var(--gut) 28px;
}

.hd-caps-title {
  font-family: var(--disp);
  font-weight: 900;
  font-size: clamp(26px, 3.6vw, 44px);
  letter-spacing: -0.04em;
  color: var(--ink);
  line-height: 1.05;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.hd-caps-title i {
  color: var(--spot);
  font-size: 0.7em;
}

.hd-caps-lead {
  color: var(--dim);
  font-size: 15px;
  line-height: 1.7;
  max-width: 64ch;
  margin: 12px 0 0;
}

/* ── Full-Width Horizontal Rows ── */
.caps {
  border-top: 1px solid var(--line2);
  border-bottom: 1px solid var(--line2);
}

.cap {
  display: grid;
  grid-template-columns: 72px 280px 1fr;
  gap: 0 28px;
  align-items: center;
  padding: 20px var(--gut);
  border-bottom: 1px solid var(--line);
  text-decoration: none !important;
  cursor: pointer;
  background: var(--bg);
  transition: background-color 0.12s ease;
  box-sizing: border-box;
}

.cap:last-child {
  border-bottom: 0;
}

.cap:hover {
  background: color-mix(in srgb, var(--spot) 5%, var(--bg));
}

.cap:hover .cap-title {
  color: var(--spot);
}

.cap:hover .arw {
  color: var(--spot);
  transform: translateX(4px);
}

.cap:hover .n > span {
  color: var(--spot);
}

.n {
  display: flex;
  align-items: center;
}

.n > span {
  font-family: var(--disp);
  font-weight: 900;
  font-size: 28px;
  letter-spacing: -0.04em;
  color: var(--line2);
  transition: color 0.12s ease;
  font-variant-numeric: tabular-nums;
}

.cap-title-col {
  min-width: 0;
}

.cap-title {
  font-family: var(--disp);
  font-weight: 800;
  font-size: 16.5px;
  letter-spacing: -0.02em;
  color: var(--ink);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: color 0.12s ease;
}

.cap-title > .far:first-child {
  color: var(--spot);
  font-size: 15px;
  width: 1.1em;
  flex-shrink: 0;
}

.arw {
  font-size: 13px;
  color: var(--faint);
  transition: all 0.12s ease;
  display: inline-block;
  margin-left: auto;
}

.cap-desc-col {
  min-width: 0;
}

.cap-desc {
  font-family: var(--body);
  font-size: 14px;
  line-height: 1.6;
  color: var(--dim);
  margin: 0;
}

@media (max-width: 860px) {
  .cap {
    grid-template-columns: 50px 1fr;
    gap: 6px 18px;
    align-items: start;
    padding: 16px var(--gut);
  }
  .cap-desc-col {
    grid-column: 2;
  }
  .n > span {
    font-size: 22px;
  }
  .cap-title {
    font-size: 15px;
  }
  .cap-desc {
    font-size: 13px;
  }
}
</style>
