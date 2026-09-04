<script setup lang="ts">
import { computed } from 'vue';
import { useSiteLocale, localeHref } from '../../i18n';

const locale = useSiteLocale();
const isZh = computed(() => locale.value === 'zh' || locale.value === 'zh-tw');

const FEATURE_ICONS = [
  'far fa-comments',
  'far fa-share-from-square',
  'far fa-user',
  'far fa-object-group',
  'far fa-folder-open',
  'far fa-id-badge',
  'far fa-file-code',
  'far fa-hard-drive',
  'far fa-window-maximize',
] as const;

interface Group {
  title: string;
  items: string[];
}

const groups = computed<Group[]>(() => {
  if (isZh.value) {
    return [
      {
        title: '多模型对话与调度',
        items: [
          '直连 OpenAI、Claude、Gemini、DeepSeek、Qwen、Ollama 等 50+ 服务商',
          '支持多模型并行提问与横向对比，实时测速与延迟测试',
          '会话分支树（Branching）、消息压缩与上下文窗口动态裁剪',
          '支持 aqbot:// 协议链接与 CC Switch 配置一键导入',
        ],
      },
      {
        title: '内置本地 AI 兼容网关',
        items: [
          '本地监听 127.0.0.1:8080，暴露标准 OpenAI /v1/chat/completions 端点',
          '为 Claude Code、Codex CLI、Cursor、Cline 与各类开发工具提供本地代理',
          '本地 Key 管理、服务商反向代理映射、SSL 证书与实时请求日志',
          '模型别名映射（如将 gpt-4o 映射到本地 deepseek-r1）',
        ],
      },
      {
        title: '自主 AI Agent',
        items: [
          '支持受控文件读写、差异比对与终端 Shell 命令执行',
          '严格的安全分级与工作目录沙箱机制，防范越权破坏',
          '可视化单步确认与审批 UI，透明展示每次工具调用的参数与结果',
          '实时 token 消耗、上下文长度与推理费用统计',
        ],
      },
      {
        title: 'MCP (Model Context Protocol) 生态',
        items: [
          '原生支持官方 Model Context Protocol 标准协议客户端',
          '一键连接外部工具、文件系统、数据库查询与第三方开发资源',
          '支持 stdio 与 SSE 传输模式，动态注入对话上下文',
          '社区热门 MCP Servers 快速预设与配置面板',
        ],
      },
      {
        title: 'sqlite-vec 本地向量知识库',
        items: [
          '轻量进程内向量数据库 sqlite-vec，无需配置重量级外部依赖',
          '支持本地 PDF、Markdown、代码文件批量切片与嵌入索引',
          '检索与召回完全在本地设备完成，杜绝数据外发泄露',
          '精准语义检索、余弦相似度分数展示与上下文引用跳转',
        ],
      },
      {
        title: '角色与提示词市场',
        items: [
          '预设丰富的专家角色模板，支持自定义系统设定与头像',
          '可微调 Temperature、Top-P、Presence Penalty 等完整采样参数',
          '深度集成 prompts.chat 与 PlexPt 中文提示词市场',
          '支持快速将角色应用到新会话或当前分支会话',
        ],
      },
      {
        title: '专业科学与代码渲染',
        items: [
          '完整的 Markdown 语法扩展，支持 GFM 任务列表与表格',
          'KaTeX 驱动的高速 LaTeX 数学公式即时排版',
          'Mermaid 流程图/时序图与 D2 架构图动态矢量渲染',
          'Monaco 语法高亮编辑器与安全的 HTML Artifacts 交互沙箱',
        ],
      },
      {
        title: '隐私安全与多端备份',
        items: [
          '所有敏感 API Key 与会话数据均在本地采用 AES-256 强加密存储',
          '双根目录架构（~/.aqbot + Documents），文件结构清晰受控',
          '支持本地快照导出、WebDAV 与 S3 云存储多端备份与差异恢复',
          '可自由选择仅备份会话、服务商配置或完整附件',
        ],
      },
      {
        title: '原生系统桌面体验',
        items: [
          '支持系统菜单栏/托盘常驻、快捷置顶窗口与全局唤醒快捷键',
          '极速冷启动、开机自启、HTTP/SOCKS5 代理设置与静默自动更新',
          '完美支持深色 (ink) 与浅色 (paper) 两种高对比技术设计主题',
          '支持 11 种常用语言的深度多语言国际化',
        ],
      },
    ];
  }

  return [
    {
      title: 'Unified Chat & Model Routing',
      items: [
        'Direct connection to 50+ providers: OpenAI, Claude, Gemini, DeepSeek, Qwen, Ollama',
        'Parallel multi-model generation, side-by-side comparison, and latency testing',
        'Conversation branching, message compression, and adaptive context truncation',
        'One-click configuration import via aqbot:// deep links and CC Switch format',
      ],
    },
    {
      title: 'Built-in Local API Gateway',
      items: [
        'Listens locally on 127.0.0.1:8080 with standard OpenAI /v1/chat/completions API',
        'Direct proxy endpoint for Claude Code, Codex CLI, Cursor, Cline, and terminal scripts',
        'Local key management, reverse proxy mappings, SSL certs, and real-time request log',
        'Model alias routing (e.g. forward gpt-4o requests directly to deepseek-r1)',
      ],
    },
    {
      title: 'Autonomous AI Agent',
      items: [
        'Controlled file inspection, diff application, and terminal command execution',
        'Strict permissions hierarchy and workspace directory sandboxing',
        'Visual step-by-step approval dialogs for complete user oversight',
        'Real-time token metrics, context window tracking, and estimated cost breakdown',
      ],
    },
    {
      title: 'Model Context Protocol (MCP)',
      items: [
        'Native client for the official Model Context Protocol standard',
        'Plug in external tools, filesystem access, databases, and custom scripts',
        'Supports stdio and SSE transport protocols with dynamic tool injection',
        'Quick configuration presets for top community MCP servers',
      ],
    },
    {
      title: 'sqlite-vec Local Knowledge Base',
      items: [
        'In-process sqlite-vec vector database with zero heavy external dependencies',
        'Batch chunking and embedding for local PDFs, Markdown docs, and codebases',
        'Search and generation stay 100% on your machine — zero cloud leakage',
        'Cosine similarity scores and direct document reference links',
      ],
    },
    {
      title: 'Roles & Prompt Presets',
      items: [
        'Curated expert persona templates with custom system prompts and avatars',
        'Full sampling control: Temperature, Top-P, Presence and Frequency penalties',
        'Deep sync with prompts.chat English and Chinese community libraries',
        'Quickly apply role templates to existing conversation threads or new sessions',
      ],
    },
    {
      title: 'Science & Code Rendering',
      items: [
        'Full Markdown specification with GitHub-style task lists and tables',
        'Fast LaTeX mathematical typesetting powered by KaTeX',
        'Dynamic vector diagrams via Mermaid sequence charts and D2 architecture files',
        'Monaco code editor and safe interactive HTML Artifact sandbox',
      ],
    },
    {
      title: 'Local Encryption & Sync',
      items: [
        'API keys and chat archives stored locally with AES-256 encryption',
        'Dual-root directory architecture (~/.aqbot + Documents) with 0600 file permissions',
        'Multi-target backups to local snapshots, WebDAV, or Amazon S3 buckets',
        'Selective migration: export credentials, chats, or document assets separately',
      ],
    },
    {
      title: 'Native Desktop Polish',
      items: [
        'System tray icon, pinnable floating window, and global activation shortcuts',
        'Instant cold start, launch on login, custom HTTP/SOCKS5 proxy, and auto-updates',
        'Pixel-perfect ink (dark) and paper (light) high-contrast technical grounds',
        'Complete localization across 11 major world languages',
      ],
    },
  ];
});
</script>

<template>
  <div class="aq-features-page">
    <div class="aq-features-frame">
      <!-- ── Header ── -->
      <header class="hd-feat-hero">
        <h1 class="hd-feat-title">
          <i class="far fa-rectangle-list" aria-hidden="true" />
          {{ isZh ? 'AQBot 全部功能矩阵' : 'Full Capability Matrix' }}
        </h1>
        <p class="hd-feat-lead">
          {{
            isZh
              ? '从多模型对话、本地网关，到自主 Agent 与本地向量知识库，为技术工作流打造的完整功能集。'
              : 'From multi-model routing and local API gateway to autonomous Agent sandboxing and private vector RAG.'
          }}
        </p>

        <div class="hd-feat-tags">
          <span class="feat-tag">OpenAI / Claude / Gemini / DeepSeek</span>
          <span class="feat-tag">OpenAI v1 Gateway</span>
          <span class="feat-tag">sqlite-vec RAG</span>
          <span class="feat-tag">MCP Protocol</span>
          <span class="feat-tag">AGPL-3.0</span>
        </div>
      </header>

      <!-- ── Capabilities Grid ── -->
      <div class="hd-feat-grid">
        <div
          v-for="(group, i) in groups"
          :key="group.title"
          class="hd-feat-card"
        >
          <h2 class="card-title">
            <i :class="FEATURE_ICONS[i]" aria-hidden="true" />
            {{ group.title }}
          </h2>

          <ul class="card-items" role="list">
            <li v-for="(item, i) in group.items" :key="i">
              <i class="far fa-circle-check" aria-hidden="true" />
              <span>{{ item }}</span>
            </li>
          </ul>
        </div>
      </div>

      <!-- ── Bottom CTA Strip ── -->
      <div class="hd-feat-bottom">
        <div class="bottom-left">
          <h3>{{ isZh ? '开启高效、私密的 AI 桌面工作流' : 'Get Started with AQBot' }}</h3>
          <p>{{ isZh ? '跨平台支持，本地优先，完全开源。' : 'Cross-platform, local-first, 100% open source.' }}</p>
        </div>
        <div class="bottom-actions">
          <a class="hd-btn hd-btn-primary" :href="localeHref(locale, '/download')">
            <i class="far fa-circle-down" aria-hidden="true" />
            {{ isZh ? '下载客户端' : 'Download Now' }}
          </a>
          <a class="hd-btn hd-btn-ghost" :href="localeHref(locale, '/guide/getting-started')">
            <i class="far fa-file-lines" aria-hidden="true" />
            {{ isZh ? '阅读文档' : 'Documentation' }}
          </a>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.aq-features-page {
  background: var(--bg);
  min-height: calc(100vh - 120px);
}

.aq-features-frame {
  max-width: 1440px;
  margin: 0 auto;
  border-left: 1px solid var(--line2);
  border-right: 1px solid var(--line2);
  border-bottom: 1px solid var(--line2);
  background: var(--bg);
  box-sizing: border-box;
}

/* ── Hero ── */
.hd-feat-hero {
  padding: 56px var(--gut) 42px;
  border-bottom: 1px solid var(--line2);
  background: var(--bg);
}

.hd-feat-title {
  font-family: var(--disp);
  font-weight: 900;
  font-size: clamp(32px, 4.5vw, 54px);
  letter-spacing: -0.045em;
  line-height: 1.05;
  color: var(--ink);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 14px;
}

.hd-feat-title i {
  color: var(--spot);
  font-size: 0.7em;
  flex-shrink: 0;
}

.hd-feat-lead {
  color: var(--dim);
  font-size: 16px;
  line-height: 1.7;
  max-width: 66ch;
  margin: 16px 0 24px;
}

.hd-feat-tags {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.feat-tag {
  font-family: var(--mono);
  font-size: 11px;
  padding: 3px 8px;
  border: 1px solid var(--line2);
  background: var(--panel);
  color: var(--dim);
}

/* ── Capabilities Grid ── */
.hd-feat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  background: var(--line);
  gap: 1px;
}

.hd-feat-card {
  background: var(--panel);
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  transition: background-color 0.12s ease;
}

.hd-feat-card:hover {
  background: color-mix(in srgb, var(--spot) 3%, var(--panel));
}

.card-title {
  font-family: var(--disp);
  font-weight: 800;
  font-size: 17px;
  letter-spacing: -0.02em;
  color: var(--ink);
  margin: 0 0 16px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.card-title i {
  color: var(--spot);
  font-size: 16px;
  flex-shrink: 0;
}

.card-items {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
}

.card-items li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-family: var(--body);
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--dim);
}

.card-items li i {
  color: var(--spot);
  font-size: 12px;
  margin-top: 4px;
  flex-shrink: 0;
}

/* ── Bottom CTA ── */
.hd-feat-bottom {
  padding: 44px var(--gut);
  border-top: 1px solid var(--line2);
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}

.bottom-left h3 {
  font-family: var(--disp);
  font-weight: 800;
  font-size: 20px;
  color: var(--ink);
  margin: 0 0 6px;
}

.bottom-left p {
  font-family: var(--body);
  font-size: 14px;
  color: var(--dim);
  margin: 0;
}

.bottom-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}

.bottom-actions .hd-btn {
  gap: 8px;
}

.bottom-actions .hd-btn {
  height: 42px !important;
  padding: 0 22px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  box-sizing: border-box !important;
}

@media (max-width: 960px) {
  .hd-feat-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 640px) {
  .hd-feat-grid {
    grid-template-columns: 1fr;
  }
  .aq-features-frame {
    border-left: 0;
    border-right: 0;
  }
  .hd-feat-hero,
  .hd-feat-bottom {
    padding: 36px var(--gut);
  }
  .bottom-actions {
    width: 100%;
  }
  .bottom-actions .hd-btn {
    flex: 1;
  }
}
</style>
