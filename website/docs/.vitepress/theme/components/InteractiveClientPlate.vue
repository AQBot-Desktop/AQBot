<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSiteLocale } from '../i18n';

const locale = useSiteLocale();
const isZh = computed(() => locale.value === 'zh' || locale.value === 'zh-tw');

type AppView = 'chat' | 'agent' | 'roles' | 'skills' | 'knowledge' | 'gateway';

const activeView = ref<AppView>('chat');

const copy = computed(() => {
  if (isZh.value) {
    return {
      title: 'AQBot 核心引擎 · 桌面程序架构预览',
      hint: '点击左侧导航栏切换 对话、Agent、知识库、网关、角色与 Skills 真实界面架构',
      navChat: '对话',
      navAgent: 'Agent',
      navRoles: '角色',
      navSkills: 'Skills',
      navKnowledge: '知识库',
      navGateway: '网关',
      searchPlaceholder: '搜索会话...',
      inputPlaceholder: '输入消息与指令... (Enter 发送, Shift+Enter 换行)',
    };
  }
  return {
    title: 'AQBot Core Engine · Desktop App Architecture',
    hint: 'Click left navigation icons to explore actual layout architectures: Chat, Agent, Knowledge Base, Gateway, Roles, and Skills',
    navChat: 'Chat',
    navAgent: 'Agent',
    navRoles: 'Roles',
    navSkills: 'Skills',
    navKnowledge: 'RAG',
    navGateway: 'Gateway',
    searchPlaceholder: 'Search sessions...',
    inputPlaceholder: 'Type a message or command... (Enter to send)',
  };
});
</script>

<template>
  <section class="hd-plate-section">
    <div class="hd-plate-hd">
      <div class="hd-plate-hd-left">
        <span class="hd-plate-title">{{ copy.title }}</span>
      </div>
      <span class="hd-plate-hint">{{ copy.hint }}</span>
    </div>

    <!-- ── Mock Desktop Window Frame ── -->
    <div class="aq-app-window">
      <!-- Window Title Bar -->
      <div class="aq-window-titlebar">
        <div class="aq-traffic-lights">
          <span class="light close" />
          <span class="light min" />
          <span class="light max" />
        </div>
        <div class="aq-window-title">
          <span>AQBot — Desktop AI Client &amp; Gateway</span>
        </div>
        <div class="aq-window-meta">
          <span class="ver-pill">v0.0.152</span>
          <span class="net-status">
            <span class="green-dot" /> 127.0.0.1:8080
          </span>
        </div>
      </div>

      <!-- App Chassis: Main Rail + Module Specific Layout -->
      <div class="aq-app-body">
        <!-- ── Leftmost Icon Rail (Sidebar.tsx) ── -->
        <aside class="aq-nav-rail">
          <div class="rail-top">
            <button
              type="button"
              class="rail-btn"
              :class="{ active: activeView === 'chat' }"
              :title="copy.navChat"
              @click="activeView = 'chat'"
            >
              <!-- Chat Bubble Icon -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span class="rail-label">{{ copy.navChat }}</span>
            </button>

            <button
              type="button"
              class="rail-btn"
              :class="{ active: activeView === 'agent' }"
              :title="copy.navAgent"
              @click="activeView = 'agent'"
            >
              <!-- Bot / Agent Icon -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 8V4H8" />
                <rect width="16" height="12" x="4" y="8" rx="2" />
                <path d="M2 14h2M20 14h2M9 13v2M15 13v2" />
              </svg>
              <span class="rail-label">{{ copy.navAgent }}</span>
            </button>

            <button
              type="button"
              class="rail-btn"
              :class="{ active: activeView === 'knowledge' }"
              :title="copy.navKnowledge"
              @click="activeView = 'knowledge'"
            >
              <!-- Book / Knowledge Icon -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
                <path d="M6 6h10M6 10h10" />
              </svg>
              <span class="rail-label">{{ copy.navKnowledge }}</span>
            </button>

            <button
              type="button"
              class="rail-btn"
              :class="{ active: activeView === 'gateway' }"
              :title="copy.navGateway"
              @click="activeView = 'gateway'"
            >
              <!-- Gateway / Router Icon -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect width="20" height="8" x="2" y="14" rx="2" />
                <path d="M6 18h.01M10 18h.01" />
                <path d="M15 10v4M9 10v4M12 2v12" />
              </svg>
              <span class="rail-label">{{ copy.navGateway }}</span>
            </button>

            <button
              type="button"
              class="rail-btn"
              :class="{ active: activeView === 'roles' }"
              :title="copy.navRoles"
              @click="activeView = 'roles'"
            >
              <!-- Users / Roles Icon -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <span class="rail-label">{{ copy.navRoles }}</span>
            </button>

            <button
              type="button"
              class="rail-btn"
              :class="{ active: activeView === 'skills' }"
              :title="copy.navSkills"
              @click="activeView = 'skills'"
            >
              <!-- Sparkles / Skills Icon -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
              </svg>
              <span class="rail-label">{{ copy.navSkills }}</span>
            </button>
          </div>

          <div class="rail-bottom">
            <div class="rail-btn user-avatar">
              <span class="avatar-box">AQ</span>
            </div>
          </div>
        </aside>

        <!-- ═══════════════════════════════════════════════════════════ -->
        <!-- MODULE 1: ChatPage (ChatSidebar 256px + ChatView)          -->
        <!-- ═══════════════════════════════════════════════════════════ -->
        <div v-if="activeView === 'chat'" class="module-view view-chat">
          <!-- Middle Column: ChatSidebar (256px) -->
          <aside class="chat-sidebar">
            <div class="sidebar-search-bar">
              <div class="search-input-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="s-icon">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <span>{{ copy.searchPlaceholder }}</span>
              </div>
              <button type="button" class="btn-new-chat" title="New Chat">+</button>
            </div>

            <div class="session-groups">
              <div class="session-group-title">
                <span>{{ isZh ? '今日' : 'Today' }}</span>
              </div>
              <div class="session-item active">
                <span class="item-dot green" />
                <div class="item-text">
                  <b class="item-title">{{ isZh ? '简单JS Hello示例' : 'Simple JS Hello Example' }}</b>
                  <span class="item-sub">OpenAI gpt-5.2 · 10:24</span>
                </div>
              </div>
              <div class="session-item">
                <span class="item-dot pink" />
                <div class="item-text">
                  <b class="item-title">{{ isZh ? '多模型性能与图表' : 'Multi-Model Benchmark' }}</b>
                  <span class="item-sub">DeepSeek-R1 / Claude 3.7</span>
                </div>
              </div>

              <div class="session-group-title">
                <span>{{ isZh ? '昨日' : 'Yesterday' }}</span>
              </div>
              <div class="session-item">
                <span class="item-dot blue" />
                <div class="item-text">
                  <b class="item-title">{{ isZh ? '无公网IP电脑直连方案' : 'P2P Direct Connection' }}</b>
                  <span class="item-sub">Tailscale &amp; WireGuard</span>
                </div>
              </div>
              <div class="session-item">
                <span class="item-dot cyan" />
                <div class="item-text">
                  <b class="item-title">{{ isZh ? 'Mermaid 架构流程图' : 'Mermaid System Flow' }}</b>
                  <span class="item-sub">Architecture diagram</span>
                </div>
              </div>
            </div>
          </aside>

          <!-- Main Column: ChatView -->
          <main class="chat-main">
            <!-- Header Bar with Session Title and Model Selector -->
            <div class="chat-header">
              <div class="session-title-wrap">
                <b class="title-text">{{ isZh ? '简单JS Hello示例' : 'Simple JS Hello Example' }}</b>
              </div>

              <div class="chat-header-actions">
                <div class="model-select-pill">
                  <span class="provider-badge">OpenAI</span>
                  <span class="model-name">gpt-5.2</span>
                  <span class="stats-text">65 tok/s · 1.2s</span>
                </div>
              </div>
            </div>

            <!-- Messages Stream Area -->
            <div class="chat-scroll-pane">
              <div class="chat-bubble user-bubble">
                <div class="bubble-meta">
                  <span class="role-name">{{ isZh ? '你' : 'User' }}</span>
                  <span class="time-tag">21:15</span>
                </div>
                <div class="bubble-body">
                  {{ isZh ? '给我一个系统初始化流程架构与代码组件示例。' : 'Show me a system initialization flow architecture and code example.' }}
                </div>
              </div>

              <div class="chat-bubble assistant-bubble">
                <div class="bubble-meta">
                  <span class="model-badge">OpenAI gpt-5.2</span>
                  <span class="time-tag">↑ 14 tokens  ↓ 194 tokens · 65 tok/s</span>
                </div>

                <!-- Thinking Block -->
                <div class="thought-box">
                  <div class="thought-hd">
                    <span>{{ isZh ? '思考过程 (1.2s)' : 'Thinking Process (1.2s)' }}</span>
                  </div>
                  <p class="thought-p">
                    {{ isZh ? '用户需要系统初始化流程图与组件迁移示例。先组织节点流：开始 → 需求收集 → 方案设计 → 开发实现 → 验证测试。' : 'User requested a system architecture flow and token migration mockup. Structuring 4 stages of pipeline.' }}
                  </p>
                </div>

                <!-- Diagram / Code Box -->
                <div class="diagram-box">
                  <div class="diagram-bar">
                    <span class="diagram-tag">{{ isZh ? 'Infographic 架构流程图' : 'Infographic Pipeline' }}</span>
                    <span class="tab-toggle">{{ isZh ? '预览 / 源码' : 'Preview / Source' }}</span>
                  </div>
                  <div class="pipeline-mock">
                    <div class="pipe-step s1">01 开始配置</div>
                    <div class="pipe-step s2">02 服务商接入</div>
                    <div class="pipe-step s3">03 模型对齐</div>
                    <div class="pipe-step s4">04 本地网关就绪</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Bottom Input Box -->
            <div class="chat-input-area">
              <div class="input-placeholder">
                {{ copy.inputPlaceholder }}
              </div>
              <div class="input-toolbar">
                <div class="toolbar-tools">
                  <span class="tb-item">Web</span>
                  <span class="tb-item">Attach</span>
                  <span class="tb-item">DeepThink</span>
                  <span class="tb-item">MCP</span>
                </div>
                <button type="button" class="btn-send">↑</button>
              </div>
            </div>
          </main>
        </div>

        <!-- ═══════════════════════════════════════════════════════════ -->
        <!-- MODULE 2: AgentPage (AcpSidebar 256px + AcpConversationPane)-->
        <!-- ═══════════════════════════════════════════════════════════ -->
        <div v-else-if="activeView === 'agent'" class="module-view view-agent">
          <!-- AcpSidebar (256px) -->
          <aside class="chat-sidebar">
            <div class="sidebar-search-bar">
              <div class="search-input-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="s-icon">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <span>{{ isZh ? '搜索项目与线程...' : 'Search agent threads...' }}</span>
              </div>
              <button type="button" class="btn-new-chat">+</button>
            </div>

            <div class="session-groups">
              <div class="session-group-title">
                <span>{{ isZh ? '活动项目与线程' : 'Projects & Threads' }}</span>
              </div>
              <div class="session-item active">
                <span class="item-dot blue" />
                <div class="item-text">
                  <b class="item-title">AQBot-Inner</b>
                  <span class="item-sub">thread #12: refactor-website</span>
                </div>
              </div>
              <div class="session-item">
                <span class="item-dot yellow" />
                <div class="item-text">
                  <b class="item-title">tauri-backend</b>
                  <span class="item-sub">thread #4: secure-sqlite-vec</span>
                </div>
              </div>
            </div>
          </aside>

          <!-- AcpConversationPane -->
          <main class="chat-main">
            <div class="chat-header">
              <div class="session-title-wrap">
                <b class="title-text">AQBot-Inner / refactor-website</b>
                <span class="tag-dir">~/dev/project/AQBot-Inner</span>
              </div>
              <div class="chat-header-actions">
                <div class="model-select-pill">
                  <span class="provider-badge">Claude Agent</span>
                  <span class="model-name">sonnet-3-7</span>
                </div>
              </div>
            </div>

            <div class="chat-scroll-pane">
              <!-- Step 1: Tool call -->
              <div class="agent-step-box done">
                <div class="step-head">
                  <span class="step-badge">STEP 01</span>
                  <b>Tool Call: filesystem.read_directory</b>
                </div>
                <code>path: "/website/docs/.vitepress/theme"</code>
                <span class="step-result">✓ Enumerated 12 component files in 2ms</span>
              </div>

              <!-- Step 2: Safety Permission Approval Dialog -->
              <div class="agent-step-box warning">
                <div class="step-head">
                  <span class="step-badge warn">APPROVAL REQUIRED</span>
                  <b>Write Permission Requested by Agent</b>
                </div>
                <code>write_file: "website/docs/.vitepress/theme/style.css" (+42 lines, -18 lines)</code>
                <div class="approval-actions">
                  <button type="button" class="btn-allow">Allow Action</button>
                  <button type="button" class="btn-reject">Reject</button>
                  <span class="sandbox-hint">Sandbox: ~/dev/project/AQBot-Inner</span>
                </div>
              </div>
            </div>

            <div class="chat-input-area">
              <div class="input-placeholder">{{ isZh ? '给 Agent 下达下一步操作任务...' : 'Prompt agent for next task...' }}</div>
              <div class="input-toolbar">
                <div class="toolbar-tools">
                  <span class="tb-item">Terminal</span>
                  <span class="tb-item">Filesystem</span>
                </div>
                <button type="button" class="btn-send">↑</button>
              </div>
            </div>
          </main>
        </div>

        <!-- ═══════════════════════════════════════════════════════════ -->
        <!-- MODULE 3: KnowledgePage (KB List 240px + Document Table)    -->
        <!-- ═══════════════════════════════════════════════════════════ -->
        <div v-else-if="activeView === 'knowledge'" class="module-view view-knowledge">
          <!-- KB List Column (240px) -->
          <aside class="chat-sidebar">
            <div class="sidebar-search-bar">
              <span class="kb-sidebar-title">{{ isZh ? '知识库列表' : 'Knowledge Bases' }}</span>
              <button type="button" class="btn-new-chat" title="New Knowledge Base">+</button>
            </div>

            <div class="session-groups">
              <div class="session-item active">
                <span class="item-dot green" />
                <div class="item-text">
                  <b class="item-title">{{ isZh ? '系统技术架构文档' : 'System Architecture' }}</b>
                  <span class="item-sub">{{ isZh ? '14 篇文档 · 420 切片' : '14 docs · 420 chunks' }}</span>
                </div>
              </div>
              <div class="session-item">
                <span class="item-dot blue" />
                <div class="item-text">
                  <b class="item-title">{{ isZh ? '产品需求与规范' : 'Product Specs' }}</b>
                  <span class="item-sub">{{ isZh ? '8 篇文档 · 180 切片' : '8 docs · 180 chunks' }}</span>
                </div>
              </div>
              <div class="session-item">
                <span class="item-dot cyan" />
                <div class="item-text">
                  <b class="item-title">{{ isZh ? 'API 接口手册' : 'API Reference' }}</b>
                  <span class="item-sub">{{ isZh ? '26 篇文档 · 840 切片' : '26 docs · 840 chunks' }}</span>
                </div>
              </div>
            </div>
          </aside>

          <!-- Main Document Table & Test Search -->
          <main class="chat-main">
            <div class="chat-header">
              <div class="session-title-wrap">
                <b class="title-text">{{ isZh ? '系统技术架构文档' : 'System Architecture' }}</b>
                <span class="model-select-pill">
                  <span class="provider-badge">Embed</span>
                  <span class="model-name">text-embedding-3-small (1536d)</span>
                </span>
              </div>
              <button type="button" class="btn-import-doc">
                {{ isZh ? '+ 上传文档' : '+ Import Files' }}
              </button>
            </div>

            <!-- Documents Table -->
            <div class="kb-content-pane">
              <div class="kb-table-wrap">
                <table class="kb-table">
                  <thead>
                    <tr>
                      <th>{{ isZh ? '文档名称' : 'File Name' }}</th>
                      <th>{{ isZh ? '切片数' : 'Chunks' }}</th>
                      <th>{{ isZh ? '文件大小' : 'Size' }}</th>
                      <th>{{ isZh ? '索引状态' : 'Status' }}</th>
                      <th>{{ isZh ? '更新时间' : 'Updated' }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><b>gateway-spec.md</b></td>
                      <td>42</td>
                      <td>18.4 KB</td>
                      <td><span class="tag-status ready">ready</span></td>
                      <td>10:14</td>
                    </tr>
                    <tr>
                      <td><b>agent-sandbox-protocol.pdf</b></td>
                      <td>128</td>
                      <td>245.0 KB</td>
                      <td><span class="tag-status ready">ready</span></td>
                      <td>09:30</td>
                    </tr>
                    <tr>
                      <td><b>sqlite-vec-schema.sql</b></td>
                      <td>18</td>
                      <td>8.2 KB</td>
                      <td><span class="tag-status ready">ready</span></td>
                      <td>昨天</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Test Retrieval Box -->
              <div class="kb-test-query">
                <div class="query-bar">
                  <span class="prompt-sym">&gt;</span>
                  <code>"AQBot local API gateway port and endpoint routing"</code>
                </div>
                <div class="retrieval-match">
                  <div class="match-hd">
                    <span class="score-pill">Cosine: 0.892</span>
                    <span class="match-file">docs/guide/gateway.md #chunk-3</span>
                  </div>
                  <p class="match-snippet">
                    "内置网关监听本地 127.0.0.1:8080，暴露标准 OpenAI 兼容端点 /v1/chat/completions，支持 Claude Code 与 Cursor 零配置接入。"
                  </p>
                </div>
              </div>
            </div>
          </main>
        </div>

        <!-- ═══════════════════════════════════════════════════════════ -->
        <!-- MODULE 4: GatewayPage (Overview Tabs + KPI Cards + Logs)    -->
        <!-- ═══════════════════════════════════════════════════════════ -->
        <div v-else-if="activeView === 'gateway'" class="module-view view-gateway">
          <main class="gateway-main">
            <!-- Gateway Tabs Header -->
            <div class="gw-tab-header">
              <div class="gw-tabs">
                <span class="gw-tab active">{{ isZh ? '概览' : 'Overview' }}</span>
                <span class="gw-tab">{{ isZh ? 'API 密钥' : 'API Keys' }}</span>
                <span class="gw-tab">{{ isZh ? '调用指标' : 'Metrics' }}</span>
                <span class="gw-tab">{{ isZh ? '请求日志' : 'Logs' }}</span>
                <span class="gw-tab">{{ isZh ? '快速接入' : 'Quick Connect' }}</span>
              </div>
              <div class="gw-status-badge">
                <span class="green-dot" />
                <span>{{ isZh ? '网关监听中: 127.0.0.1:8080' : 'Listening: 127.0.0.1:8080' }}</span>
              </div>
            </div>

            <!-- Gateway Dashboard Content -->
            <div class="gw-dashboard">
              <!-- 4 KPI Metrics Cards -->
              <div class="gw-kpi-grid">
                <div class="kpi-card">
                  <span class="kpi-label">{{ isZh ? '服务状态' : 'Service Status' }}</span>
                  <b class="kpi-val green">{{ isZh ? '运行中' : 'Running' }}</b>
                  <small>Port: 8080 · PID: 4920</small>
                </div>
                <div class="kpi-card">
                  <span class="kpi-label">{{ isZh ? '活跃 API 密钥' : 'Active Keys' }}</span>
                  <b class="kpi-val">3</b>
                  <small>Rate Limit: 120 req/m</small>
                </div>
                <div class="kpi-card">
                  <span class="kpi-label">{{ isZh ? '今日请求量' : 'Today Requests' }}</span>
                  <b class="kpi-val">1,428</b>
                  <small>{{ isZh ? '平均响应: 182ms' : 'Avg Latency: 182ms' }}</small>
                </div>
                <div class="kpi-card">
                  <span class="kpi-label">{{ isZh ? '转发 Token 总量' : 'Total Tokens' }}</span>
                  <b class="kpi-val">328,540</b>
                  <small>{{ isZh ? '本地缓存命中: 41.2%' : 'Cache Hit: 41.2%' }}</small>
                </div>
              </div>

              <!-- Real-time Request Diagnostics Table -->
              <div class="gw-logs-wrap">
                <div class="gw-logs-title">
                  <span>{{ isZh ? '实时请求审计日志' : 'Real-time Request Diagnostics' }}</span>
                </div>
                <table class="gw-table">
                  <thead>
                    <tr>
                      <th>{{ isZh ? '时间' : 'Time' }}</th>
                      <th>{{ isZh ? '方法' : 'Method' }}</th>
                      <th>{{ isZh ? '端点路径' : 'Path' }}</th>
                      <th>{{ isZh ? '客户端' : 'Client' }}</th>
                      <th>{{ isZh ? '状态' : 'Status' }}</th>
                      <th>{{ isZh ? '耗时' : 'Duration' }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td class="mono">10:41:02</td>
                      <td class="mono post">POST</td>
                      <td class="mono">/v1/chat/completions</td>
                      <td>Claude Code CLI</td>
                      <td><span class="st s200">200 OK</span></td>
                      <td class="mono">248ms</td>
                    </tr>
                    <tr>
                      <td class="mono">10:41:08</td>
                      <td class="mono post">POST</td>
                      <td class="mono">/v1/embeddings</td>
                      <td>Cursor Editor</td>
                      <td><span class="st s200">200 OK</span></td>
                      <td class="mono">42ms</td>
                    </tr>
                    <tr>
                      <td class="mono">10:41:20</td>
                      <td class="mono get">GET</td>
                      <td class="mono">/v1/models</td>
                      <td>Cline Assistant</td>
                      <td><span class="st s200">200 OK</span></td>
                      <td class="mono">1ms</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </main>
        </div>

        <!-- ═══════════════════════════════════════════════════════════ -->
        <!-- MODULE 5: RolesPage (Gallery Grid)                          -->
        <!-- ═══════════════════════════════════════════════════════════ -->
        <div v-else-if="activeView === 'roles'" class="module-view view-roles">
          <main class="roles-main">
            <div class="roles-header">
              <div class="roles-tabs">
                <span class="role-tab active">{{ isZh ? '我的角色' : 'My Roles' }} (12)</span>
                <span class="role-tab">{{ isZh ? '提示词市场' : 'Marketplace' }} (240+)</span>
              </div>
              <button type="button" class="btn-create-role">{{ isZh ? '+ 新建角色' : '+ New Role' }}</button>
            </div>

            <div class="roles-grid">
              <div class="role-card">
                <div class="role-card-top">
                  <div class="role-avatar">RS</div>
                  <div class="role-meta">
                    <b>Rust Senior Architect</b>
                    <small>System &amp; Concurrency</small>
                  </div>
                </div>
                <p class="role-desc">
                  {{ isZh ? '专注于零成本抽象、内存安全与 Tokio 异步并发性能优化。' : 'Specialized in zero-cost abstractions, memory safety, and async performance.' }}
                </p>
                <div class="role-card-footer">
                  <span class="param-tag">Temp: 0.6 · TopP: 0.9</span>
                  <button type="button" class="btn-apply-role">{{ isZh ? '应用' : 'Apply' }}</button>
                </div>
              </div>

              <div class="role-card">
                <div class="role-card-top">
                  <div class="role-avatar">TW</div>
                  <div class="role-meta">
                    <b>Full-Stack Technical Writer</b>
                    <small>Docs &amp; Specs</small>
                  </div>
                </div>
                <p class="role-desc">
                  {{ isZh ? '撰写清晰规范的工程 API 手册、架构白皮书与用户指引。' : 'Author high-clarity technical docs, API specs, and engineering manuals.' }}
                </p>
                <div class="role-card-footer">
                  <span class="param-tag">Temp: 0.4 · TopP: 0.8</span>
                  <button type="button" class="btn-apply-role">{{ isZh ? '应用' : 'Apply' }}</button>
                </div>
              </div>

              <div class="role-card">
                <div class="role-card-top">
                  <div class="role-avatar">DB</div>
                  <div class="role-meta">
                    <b>Database Performance Tuning</b>
                    <small>SQL &amp; Vector DB</small>
                  </div>
                </div>
                <p class="role-desc">
                  {{ isZh ? '精通 SQL 查询优化、向量索引构建与内存数据库调优。' : 'Specialized in database query optimization, indexing, and sqlite-vec tuning.' }}
                </p>
                <div class="role-card-footer">
                  <span class="param-tag">Temp: 0.5 · TopP: 0.85</span>
                  <button type="button" class="btn-apply-role">{{ isZh ? '应用' : 'Apply' }}</button>
                </div>
              </div>
            </div>
          </main>
        </div>

        <!-- ═══════════════════════════════════════════════════════════ -->
        <!-- MODULE 6: SkillsPage (Source Filters + Directory)           -->
        <!-- ═══════════════════════════════════════════════════════════ -->
        <div v-else-if="activeView === 'skills'" class="module-view view-skills">
          <main class="skills-main">
            <div class="skills-header">
              <div class="skills-sources">
                <span class="source-pill active">All (8)</span>
                <span class="source-pill">AQBot (~/.aqbot)</span>
                <span class="source-pill">Claude (~/.claude)</span>
                <span class="source-pill">Codex (~/.codex)</span>
              </div>
              <button type="button" class="btn-import-doc">{{ isZh ? '+ 安装 Skill' : '+ Install Skill' }}</button>
            </div>

            <div class="skills-list">
              <div class="skill-row">
                <div class="skill-info">
                  <b>kill-ai-slop</b>
                  <span class="source-tag">~/.claude/skills</span>
                  <p>{{ isZh ? '自动扫描并消除前端界面中的 AI 样板化设计缺陷' : 'Detect and remediate AI visual slop in web interfaces' }}</p>
                </div>
                <div class="skill-switch on">{{ isZh ? '已启用' : 'Enabled' }}</div>
              </div>

              <div class="skill-row">
                <div class="skill-info">
                  <b>git-commit-helper</b>
                  <span class="source-tag">~/.aqbot/skills</span>
                  <p>{{ isZh ? '分析工作区 diff 并自动生成符合 Conventional Commits 规范的提交日志' : 'Generate conventional commits based on staged workspace diffs' }}</p>
                </div>
                <div class="skill-switch on">{{ isZh ? '已启用' : 'Enabled' }}</div>
              </div>

              <div class="skill-row">
                <div class="skill-info">
                  <b>sqlite-vector-search</b>
                  <span class="source-tag">~/.codex/skills</span>
                  <p>{{ isZh ? '调用本地向量模型检索匹配项目代码切片与技术规范' : 'Query local vector store for semantic code chunk retrieval' }}</p>
                </div>
                <div class="skill-switch on">{{ isZh ? '已启用' : 'Enabled' }}</div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hd-plate-section {
  padding: 52px var(--gut);
  background: var(--bg);
  border-bottom: 1px solid var(--line2);
}

.hd-plate-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
  flex-wrap: wrap;
  gap: 12px;
}

.hd-plate-title {
  font-family: var(--disp);
  font-weight: 800;
  font-size: 18px;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.hd-plate-hint {
  font-family: var(--mono);
  font-size: 11.5px;
  letter-spacing: 0.04em;
  color: var(--faint);
}

/* ── App Window Shell ── */
.aq-app-window {
  border: 1px solid var(--line2);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Window Title Bar ── */
.aq-window-titlebar {
  height: 38px;
  background: var(--bg);
  border-bottom: 1px solid var(--line2);
  display: flex;
  align-items: center;
  padding: 0 14px;
  justify-content: space-between;
  user-select: none;
}

.aq-traffic-lights {
  display: flex;
  align-items: center;
  gap: 7px;
}

.light {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.light.close {
  background: #ff5f56;
}
.light.min {
  background: #ffbd2e;
}
.light.max {
  background: #27c93f;
}

.aq-window-title {
  font-family: var(--disp);
  font-weight: 700;
  font-size: 12px;
  color: var(--dim);
  letter-spacing: 0.02em;
}

.aq-window-meta {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ver-pill {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 1px 6px;
  border: 1px solid var(--line2);
  background: var(--panel);
  color: var(--faint);
}

.net-status {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--dim);
  display: flex;
  align-items: center;
  gap: 6px;
}

.green-dot {
  width: 7px;
  height: 7px;
  background: var(--green);
  border-radius: 50%;
  display: inline-block;
}

/* ── App Body: Rail + Module View ── */
.aq-app-body {
  display: flex;
  min-height: 520px;
  background: var(--bg);
}

/* ── Left Rail (Column 1) ── */
.aq-nav-rail {
  width: 56px;
  border-right: 1px solid var(--line);
  background: var(--bg);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 10px 0;
  align-items: center;
  flex-shrink: 0;
}

.rail-top {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  align-items: center;
}

.rail-btn {
  width: 42px;
  height: 42px;
  border: 0;
  background: transparent;
  color: var(--dim);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.12s ease;
  padding: 0;
}

.rail-btn svg {
  width: 17px;
  height: 17px;
}

.rail-label {
  font-family: var(--body);
  font-size: 9px;
  margin-top: 2px;
  line-height: 1;
}

.rail-btn:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--spot) 6%, transparent);
}

.rail-btn.active {
  color: var(--spot);
  background: color-mix(in srgb, var(--spot) 10%, transparent);
}

.avatar-box {
  width: 28px;
  height: 28px;
  background: var(--mass);
  border: 1px solid var(--line2);
  color: var(--ink);
  font-family: var(--disp);
  font-weight: 800;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}

/* ── Module Container ── */
.module-view {
  display: flex;
  flex: 1;
  min-width: 0;
}

/* ── Shared 256px Chat/Agent/KB Sidebar ── */
.chat-sidebar {
  width: 240px;
  border-right: 1px solid var(--line);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-search-bar {
  padding: 10px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 8px;
}

.kb-sidebar-title {
  font-family: var(--disp);
  font-weight: 800;
  font-size: 13px;
  color: var(--ink);
  flex: 1;
}

.search-input-box {
  flex: 1;
  height: 28px;
  border: 1px solid var(--line2);
  background: var(--bg);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  font-family: var(--body);
  font-size: 11.5px;
  color: var(--faint);
}

.s-icon {
  width: 12px;
  height: 12px;
}

.btn-new-chat {
  width: 28px;
  height: 28px;
  border: 1px solid var(--line2);
  background: var(--bg);
  color: var(--dim);
  font-family: var(--mono);
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.session-groups {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.session-group-title {
  padding: 10px 14px 4px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.session-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.session-item:hover {
  background: color-mix(in srgb, var(--spot) 5%, transparent);
}

.session-item.active {
  background: color-mix(in srgb, var(--spot) 9%, transparent);
  border-left: 2px solid var(--spot);
}

.item-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.item-dot.pink { background: #f472b6; }
.item-dot.blue { background: #60a5fa; }
.item-dot.green { background: #4ade80; }
.item-dot.cyan { background: #38bdf8; }
.item-dot.yellow { background: #facc15; }

.item-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.item-title {
  font-family: var(--body);
  font-size: 12.5px;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-sub {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--dim);
}

/* ── Main Chat Area ── */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg);
}

.chat-header {
  height: 44px;
  border-bottom: 1px solid var(--line);
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg);
}

.session-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-text {
  font-family: var(--disp);
  font-weight: 800;
  font-size: 14px;
  color: var(--ink);
}

.edit-pill {
  color: var(--faint);
  font-size: 12px;
}

.tag-dir {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--dim);
  padding: 2px 6px;
  background: var(--panel);
  border: 1px solid var(--line);
}

.model-select-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border: 1px solid var(--line2);
  background: var(--panel);
}

.provider-badge {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--spot);
  text-transform: uppercase;
}

.model-name {
  font-family: var(--body);
  font-size: 12px;
  color: var(--ink);
  font-weight: 600;
}

.stats-text {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--faint);
  margin-left: 6px;
}

.chat-scroll-pane {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.chat-bubble {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.user-bubble {
  align-self: flex-end;
  max-width: 75%;
  background: var(--panel);
  border: 1px solid var(--line2);
  padding: 10px 14px;
}

.bubble-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--faint);
}

.bubble-body {
  font-family: var(--body);
  font-size: 13.5px;
  color: var(--ink);
  line-height: 1.5;
}

.assistant-bubble {
  align-self: flex-start;
  width: 100%;
  background: var(--panel);
  border: 1px solid var(--line);
  padding: 14px 16px;
}

.model-badge {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--spot);
}

.thought-box {
  border: 1px solid var(--line2);
  background: var(--bg);
  padding: 10px 12px;
  margin: 8px 0;
}

.thought-hd {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
  margin-bottom: 4px;
}

.thought-p {
  margin: 0;
  font-family: var(--body);
  font-size: 12px;
  color: var(--dim);
  line-height: 1.6;
}

.diagram-box {
  border: 1px solid var(--line2);
  background: var(--bg);
  padding: 12px;
}

.diagram-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--faint);
  margin-bottom: 10px;
}

.pipeline-mock {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.pipe-step {
  padding: 8px;
  font-family: var(--mono);
  font-size: 11px;
  text-align: center;
  border: 1px solid var(--line2);
  background: var(--panel);
  color: var(--ink);
}

.pipe-step.s1 { border-left: 2px solid #38bdf8; }
.pipe-step.s2 { border-left: 2px solid #52c97a; }
.pipe-step.s3 { border-left: 2px solid #e6b84a; }
.pipe-step.s4 { border-left: 2px solid #94e2d5; }

/* ── Chat Input ── */
.chat-input-area {
  border-top: 1px solid var(--line);
  background: var(--panel);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.input-placeholder {
  font-family: var(--body);
  font-size: 13px;
  color: var(--faint);
  min-height: 24px;
}

.input-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.toolbar-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tb-item {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 3px 8px;
  border: 1px solid var(--line2);
  background: var(--bg);
  color: var(--dim);
  cursor: pointer;
}

.btn-send {
  width: 26px;
  height: 26px;
  border: 1px solid var(--spot);
  background: var(--spot);
  color: var(--spot-ink);
  font-family: var(--mono);
  font-weight: 900;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

/* ── Agent View ── */
.agent-step-box {
  border: 1px solid var(--line2);
  background: var(--panel);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.step-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--ink);
}

.step-badge {
  font-family: var(--mono);
  font-size: 9.5px;
  padding: 2px 6px;
  border: 1px solid var(--green);
  color: var(--green);
  background: color-mix(in srgb, var(--green) 10%, transparent);
}

.step-badge.warn {
  border-color: var(--yellow);
  color: var(--yellow);
  background: color-mix(in srgb, var(--yellow) 10%, transparent);
}

.step-result {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--green);
}

.agent-step-box code {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--spot);
}

.approval-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.btn-allow {
  padding: 4px 14px;
  font-family: var(--mono);
  font-size: 11px;
  background: var(--spot);
  color: var(--spot-ink);
  border: 1px solid var(--spot);
  font-weight: 600;
  cursor: pointer;
}

.btn-reject {
  padding: 4px 14px;
  font-family: var(--mono);
  font-size: 11px;
  background: transparent;
  color: var(--dim);
  border: 1px solid var(--line2);
  cursor: pointer;
}

.sandbox-hint {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--faint);
  margin-left: auto;
}

/* ── Knowledge Base View ── */
.kb-content-pane {
  flex: 1;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.btn-import-doc {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--spot);
  background: var(--spot);
  color: var(--spot-ink);
  font-family: var(--body);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.kb-table-wrap {
  border: 1px solid var(--line2);
  background: var(--panel);
}

.kb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.kb-table th {
  padding: 8px 12px;
  font-family: var(--mono);
  font-size: 10.5px;
  text-transform: uppercase;
  color: var(--faint);
  background: var(--bg);
  border-bottom: 1px solid var(--line2);
  text-align: left;
}

.kb-table td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
  color: var(--dim);
}

.tag-status.ready {
  font-family: var(--mono);
  font-size: 10px;
  padding: 1px 6px;
  border: 1px solid var(--green);
  color: var(--green);
  background: color-mix(in srgb, var(--green) 10%, transparent);
}

.kb-test-query {
  border: 1px solid var(--line2);
  background: var(--panel);
  padding: 12px;
}

.query-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--ink);
  margin-bottom: 8px;
}

.prompt-sym {
  color: var(--spot);
  font-weight: 600;
}

.retrieval-match {
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--line);
}

.match-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-family: var(--mono);
  font-size: 10.5px;
  margin-bottom: 4px;
}

.score-pill {
  color: var(--green);
  font-weight: 600;
}

.match-file {
  color: var(--faint);
}

.match-snippet {
  margin: 0;
  font-family: var(--body);
  font-size: 12px;
  color: var(--dim);
  line-height: 1.5;
}

/* ── Gateway View ── */
.gateway-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.gw-tab-header {
  height: 42px;
  border-bottom: 1px solid var(--line2);
  background: var(--panel);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
}

.gw-tabs {
  display: flex;
  align-items: center;
  gap: 16px;
}

.gw-tab {
  font-family: var(--body);
  font-size: 13px;
  color: var(--dim);
  cursor: pointer;
}

.gw-tab.active {
  color: var(--spot);
  font-weight: 600;
}

.gw-status-badge {
  display: flex;
  align-items: center;
  gap: 7px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--dim);
}

.gw-dashboard {
  flex: 1;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
}

.gw-kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.kpi-card {
  padding: 14px;
  border: 1px solid var(--line2);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.kpi-label {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--faint);
}

.kpi-val {
  font-family: var(--disp);
  font-weight: 900;
  font-size: 24px;
  color: var(--ink);
  line-height: 1.1;
}

.kpi-val.green {
  color: var(--green);
}

.kpi-card small {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--dim);
}

.gw-logs-wrap {
  border: 1px solid var(--line2);
  background: var(--panel);
}

.gw-logs-title {
  padding: 10px 14px;
  border-bottom: 1px solid var(--line2);
  font-family: var(--disp);
  font-weight: 700;
  font-size: 12.5px;
  color: var(--ink);
}

.gw-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.gw-table th {
  padding: 8px 12px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--faint);
  background: var(--bg);
  border-bottom: 1px solid var(--line);
  text-align: left;
}

.gw-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  color: var(--dim);
}

.gw-table td.mono {
  font-family: var(--mono);
}

.gw-table td.post {
  color: var(--cyan);
  font-weight: 600;
}

.gw-table td.get {
  color: var(--green);
  font-weight: 600;
}

.gw-table .st.s200 {
  color: var(--green);
}

/* ── Roles View ── */
.roles-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.roles-header {
  height: 44px;
  border-bottom: 1px solid var(--line2);
  background: var(--panel);
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.roles-tabs {
  display: flex;
  align-items: center;
  gap: 16px;
}

.role-tab {
  font-family: var(--body);
  font-size: 13px;
  color: var(--dim);
  cursor: pointer;
}

.role-tab.active {
  color: var(--spot);
  font-weight: 600;
}

.btn-create-role {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--line2);
  background: var(--bg);
  color: var(--ink);
  font-family: var(--body);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.roles-grid {
  flex: 1;
  padding: 16px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  overflow-y: auto;
}

.role-card {
  border: 1px solid var(--line2);
  background: var(--panel);
  padding: 16px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
}

.role-card-top {
  display: flex;
  align-items: center;
  gap: 10px;
}

.role-avatar {
  width: 34px;
  height: 34px;
  background: var(--bg);
  border: 1px solid var(--line2);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
}

.role-meta b {
  font-family: var(--disp);
  font-size: 13px;
  color: var(--ink);
  display: block;
}

.role-meta small {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--faint);
}

.role-desc {
  margin: 0;
  font-family: var(--body);
  font-size: 12px;
  color: var(--dim);
  line-height: 1.5;
}

.role-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid var(--line);
  padding-top: 8px;
}

.param-tag {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--faint);
}

.btn-apply-role {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--spot);
  background: var(--spot);
  color: var(--spot-ink);
  font-family: var(--body);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

/* ── Skills View ── */
.skills-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.skills-header {
  height: 44px;
  border-bottom: 1px solid var(--line2);
  background: var(--panel);
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.skills-sources {
  display: flex;
  align-items: center;
  gap: 8px;
}

.source-pill {
  font-family: var(--mono);
  font-size: 11px;
  padding: 3px 8px;
  border: 1px solid var(--line2);
  background: var(--bg);
  color: var(--dim);
  cursor: pointer;
}

.source-pill.active {
  border-color: var(--spot);
  color: var(--spot);
}

.skills-list {
  flex: 1;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.skill-row {
  border: 1px solid var(--line2);
  background: var(--panel);
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.skill-info b {
  font-family: var(--disp);
  font-size: 13.5px;
  color: var(--ink);
}

.source-tag {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--faint);
  margin-left: 8px;
}

.skill-info p {
  margin: 4px 0 0;
  font-family: var(--body);
  font-size: 12px;
  color: var(--dim);
}

.skill-switch.on {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 3px 8px;
  border: 1px solid var(--green);
  color: var(--green);
  background: color-mix(in srgb, var(--green) 10%, transparent);
}

@media (max-width: 960px) {
  .chat-sidebar {
    display: none;
  }
  .gw-kpi-grid {
    grid-template-columns: 1fr 1fr;
  }
  .roles-grid {
    grid-template-columns: 1fr;
  }
}
</style>
