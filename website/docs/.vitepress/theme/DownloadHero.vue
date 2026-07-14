<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useData } from 'vitepress';
import {
  AppleOutlined,
  WindowsOutlined,
  ClockCircleOutlined,
  LinkOutlined,
  DownloadOutlined,
} from '@ant-design/icons-vue';
import LinuxIcon from './components/ui/LinuxIcon.vue';

declare const __APP_VERSION__: string;

const VERSION = __APP_VERSION__;
const BASE = `https://github.com/AQBot-Desktop/AQBot/releases/download/v${VERSION}`;

type OS = 'macos' | 'windows' | 'linux';

interface DownloadItem {
  labelZh: string;
  labelEn: string;
  file: string;
  arch: string;
  os: OS;
  primary?: boolean;
}

const downloads: DownloadItem[] = [
  { os: 'macos', arch: 'Apple Silicon', labelEn: 'Apple Silicon (M1–M4)', labelZh: 'Apple Silicon（M 系列）', file: `AQBot_${VERSION}_aarch64.dmg`, primary: true },
  { os: 'macos', arch: 'Intel', labelEn: 'Intel', labelZh: 'Intel（英特尔）', file: `AQBot_${VERSION}_x64.dmg`, primary: true },
  { os: 'windows', arch: 'x64', labelEn: 'Windows x64 Installer', labelZh: 'Windows x64 安装包', file: `AQBot_${VERSION}_x64-setup.exe`, primary: true },
  { os: 'windows', arch: 'x64 Portable', labelEn: 'Windows x64 Portable', labelZh: 'Windows x64 绿色版', file: `AQBot_v${VERSION}_windows-x64-portable.zip` },
  { os: 'windows', arch: 'ARM64', labelEn: 'Windows ARM64 Installer', labelZh: 'Windows ARM64 安装包', file: `AQBot_${VERSION}_arm64-setup.exe` },
  { os: 'windows', arch: 'ARM64 Portable', labelEn: 'Windows ARM64 Portable', labelZh: 'Windows ARM64 绿色版', file: `AQBot_v${VERSION}_windows-arm64-portable.zip` },
  { os: 'linux', arch: 'x64 deb', labelEn: 'x64 .deb (Debian / Ubuntu)', labelZh: 'x64 .deb（Debian / Ubuntu）', file: `AQBot_${VERSION}_amd64.deb`, primary: true },
  { os: 'linux', arch: 'x64 AppImage', labelEn: 'x64 AppImage', labelZh: 'x64 AppImage', file: `AQBot_${VERSION}_amd64.AppImage` },
  { os: 'linux', arch: 'ARM64 deb', labelEn: 'ARM64 .deb', labelZh: 'ARM64 .deb', file: `AQBot_${VERSION}_arm64.deb` },
  { os: 'linux', arch: 'x64 rpm', labelEn: 'x64 .rpm (Fedora / RHEL)', labelZh: 'x64 .rpm（Fedora / RHEL）', file: `AQBot-${VERSION}-1.x86_64.rpm` },
  { os: 'linux', arch: 'ARM64 rpm', labelEn: 'ARM64 .rpm', labelZh: 'ARM64 .rpm', file: `AQBot-${VERSION}-1.aarch64.rpm` },
];

const osTabs: { id: OS; label: string }[] = [
  { id: 'macos', label: 'macOS' },
  { id: 'windows', label: 'Windows' },
  { id: 'linux', label: 'Linux' },
];

const { lang } = useData();
const isZh = computed(() => lang.value.startsWith('zh'));
const activeOS = ref<OS>('macos');

onMounted(() => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) activeOS.value = 'windows';
  else if (ua.includes('linux')) activeOS.value = 'linux';
  else activeOS.value = 'macos';
});

const currentDownloads = computed(() => downloads.filter((d) => d.os === activeOS.value));
const primaryDownloads = computed(() => currentDownloads.value.filter((d) => d.primary));
const moreDownloads = computed(() => currentDownloads.value.filter((d) => !d.primary));

function itemLabel(item: DownloadItem) {
  return isZh.value ? item.labelZh : item.labelEn;
}

function downloadUrl(item: DownloadItem) {
  return `${BASE}/${item.file}`;
}

interface InstallStep {
  titleZh: string;
  titleEn: string;
  stepsZh: string[];
  stepsEn: string[];
}

const installInstructions = computed<InstallStep[]>(() => {
  const os = activeOS.value;
  if (os === 'macos') {
    return [
      {
        titleZh: '安装说明',
        titleEn: 'Install',
        stepsZh: [
          '打开下载的 .dmg 文件',
          '将 AQBot 拖入「应用程序」文件夹',
          '首次运行时，在「系统设置 → 隐私与安全性」中允许运行',
        ],
        stepsEn: [
          'Open the downloaded .dmg file',
          'Drag AQBot into the Applications folder',
          'On first launch, allow it in System Settings → Privacy & Security',
        ],
      },
    ];
  }
  if (os === 'windows') {
    return [
      {
        titleZh: '安装版',
        titleEn: 'Installer',
        stepsZh: ['运行下载的安装程序', '按向导完成安装', '从开始菜单或桌面快捷方式启动'],
        stepsEn: [
          'Run the downloaded installer',
          'Follow the wizard to complete installation',
          'Launch from the Start Menu or desktop shortcut',
        ],
      },
      {
        titleZh: '绿色版（Portable）',
        titleEn: 'Portable',
        stepsZh: ['解压 .zip 到任意目录', '双击 AQBot.exe 即可运行'],
        stepsEn: ['Extract the .zip to any folder', 'Double-click AQBot.exe to run'],
      },
    ];
  }
  return [
    {
      titleZh: '安装说明',
      titleEn: 'Install',
      stepsZh: [
        'Debian / Ubuntu：sudo dpkg -i AQBot_*.deb',
        'AppImage：chmod +x AQBot_*.AppImage && ./AQBot_*.AppImage',
        'RPM：sudo rpm -i AQBot-*.rpm',
      ],
      stepsEn: [
        'Debian / Ubuntu: sudo dpkg -i AQBot_*.deb',
        'AppImage: chmod +x AQBot_*.AppImage && ./AQBot_*.AppImage',
        'RPM: sudo rpm -i AQBot-*.rpm',
      ],
    },
  ];
});

const sysReq = computed(() => {
  const os = activeOS.value;
  if (os === 'macos') return isZh.value ? 'macOS 11.0（Big Sur）及以上' : 'macOS 11.0 (Big Sur) or later';
  if (os === 'windows') return isZh.value ? 'Windows 10（1803）及以上' : 'Windows 10 (1803) or later';
  return isZh.value ? '主流 Linux 发行版（glibc 兼容）' : 'Major Linux distros (glibc-compatible)';
});

const heroLead = computed(() =>
  isZh.value
    ? '免费开源，选择平台后即可在几分钟内完成安装。'
    : 'Free and open source — pick a platform and install in minutes.',
);

const detectedHint = computed(() => {
  const map: Record<OS, string> = isZh.value
    ? { macos: '已检测：macOS', windows: '已检测：Windows', linux: '已检测：Linux' }
    : { macos: 'Detected: macOS', windows: 'Detected: Windows', linux: 'Detected: Linux' };
  return map[activeOS.value];
});
</script>

<template>
  <div class="aq-download">
    <div class="aq-container wrap">
      <header class="hero">
        <h1>{{ isZh ? '下载 AQBot' : 'Download AQBot' }}</h1>
        <p class="lead">{{ heroLead }}</p>
        <div class="meta-row">
          <a
            class="version-badge"
            href="https://github.com/AQBot-Desktop/AQBot/releases"
            target="_blank"
            rel="noopener"
          >
            <ClockCircleOutlined />
            v{{ VERSION }}
          </a>
          <span class="detect">{{ detectedHint }}</span>
        </div>
      </header>

      <div class="os-tabs" role="tablist">
        <button
          v-for="tab in osTabs"
          :key="tab.id"
          type="button"
          role="tab"
          :class="['os-tab', { active: activeOS === tab.id }]"
          :aria-selected="activeOS === tab.id"
          @click="activeOS = tab.id"
        >
          <AppleOutlined v-if="tab.id === 'macos'" class="tab-icon" />
          <WindowsOutlined v-else-if="tab.id === 'windows'" class="tab-icon" />
          <LinuxIcon v-else class="tab-icon" />
          {{ tab.label }}
        </button>
      </div>

      <section class="section">
        <h2 class="section-title">{{ isZh ? '推荐下载' : 'Recommended' }}</h2>
        <div class="dl-grid">
          <a
            v-for="item in primaryDownloads"
            :key="item.file"
            :href="downloadUrl(item)"
            class="dl-card primary"
          >
            <div class="dl-left">
              <span class="dl-icon">
                <AppleOutlined v-if="activeOS === 'macos'" />
                <WindowsOutlined v-else-if="activeOS === 'windows'" />
                <LinuxIcon v-else :size="20" />
              </span>
              <div class="dl-text">
                <div class="dl-name">{{ itemLabel(item) }}</div>
                <code class="dl-file">{{ item.file }}</code>
              </div>
            </div>
            <span class="dl-action">
              <DownloadOutlined />
              {{ isZh ? '下载' : 'Get' }}
            </span>
          </a>
        </div>
      </section>

      <section v-if="moreDownloads.length" class="section">
        <h2 class="section-title">{{ isZh ? '更多格式' : 'More formats' }}</h2>
        <div class="dl-grid secondary-grid">
          <a
            v-for="item in moreDownloads"
            :key="item.file"
            :href="downloadUrl(item)"
            class="dl-card secondary"
          >
            <div class="dl-text">
              <div class="dl-name">{{ itemLabel(item) }}</div>
              <code class="dl-file">{{ item.file }}</code>
            </div>
            <DownloadOutlined class="sec-dl" />
          </a>
        </div>
      </section>

      <div class="info-row">
        <div class="sys-req">
          <span class="sys-k">{{ isZh ? '系统要求' : 'Requirements' }}</span>
          <span class="sys-v">{{ sysReq }}</span>
        </div>
        <a
          class="releases-link"
          href="https://github.com/AQBot-Desktop/AQBot/releases"
          target="_blank"
          rel="noopener"
        >
          {{ isZh ? 'GitHub Releases' : 'All releases' }}
          <LinkOutlined />
        </a>
      </div>

      <section class="section install-section">
        <h2 class="section-title">{{ isZh ? '安装说明' : 'Installation' }}</h2>
        <div class="install-panel">
          <div v-for="(inst, idx) in installInstructions" :key="idx" class="install-group">
            <h3 v-if="installInstructions.length > 1" class="install-h">
              {{ isZh ? inst.titleZh : inst.titleEn }}
            </h3>
            <ol class="install-steps">
              <li v-for="(step, si) in isZh ? inst.stepsZh : inst.stepsEn" :key="si">
                {{ step }}
              </li>
            </ol>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.aq-download {
  position: relative;
  padding: calc(var(--vp-nav-height) + 56px) 0 88px;
}

.aq-download::before {
  content: '';
  pointer-events: none;
  position: absolute;
  left: 50%;
  top: 0;
  transform: translateX(-50%);
  width: min(720px, 90vw);
  height: 260px;
  background: radial-gradient(ellipse at center, var(--aq-glow-soft), transparent 70%);
  z-index: 0;
}

.wrap {
  position: relative;
  z-index: 1;
  max-width: 760px;
}

.hero {
  text-align: center;
  margin-bottom: 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 12px 0 4px;
}

.hero h1 {
  margin: 0;
  font-size: clamp(2.15rem, 5vw, 3rem);
  font-weight: 800;
  letter-spacing: -0.035em;
  line-height: 1.15;
  color: var(--aq-text-1);
}

.lead {
  margin: 0;
  max-width: 34em;
  color: var(--aq-text-2);
  line-height: 1.75;
  font-size: 1.08rem;
  text-wrap: pretty;
  line-break: strict;
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 4px;
}

.version-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 650;
  font-family: var(--aq-font-mono);
  color: var(--aq-brand);
  background: var(--aq-brand-soft);
  border: 1px solid rgba(63, 186, 64, 0.3);
  padding: 5px 12px;
  border-radius: 999px;
  text-decoration: none;
}

.version-badge:hover {
  background: rgba(63, 186, 64, 0.2);
}

.detect {
  font-size: 12px;
  font-family: var(--aq-font-mono);
  color: var(--aq-text-3);
}

.os-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 28px;
  padding: 6px;
  border-radius: 14px;
  border: 1px solid var(--aq-border);
  background: var(--aq-inset);
}

.os-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 10px;
  font-size: 14px;
  font-weight: 650;
  color: var(--aq-text-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.os-tab:hover {
  color: var(--aq-text-1);
  background: var(--aq-elevated);
}

.os-tab.active {
  color: var(--aq-text-1);
  background: var(--aq-brand-soft);
  border-color: rgba(63, 186, 64, 0.4);
  box-shadow: 0 0 18px var(--aq-glow-soft);
}

.tab-icon {
  font-size: 16px;
}

.section {
  margin-bottom: 28px;
}

.section-title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--aq-text-3);
  font-family: var(--aq-font-mono);
}

.dl-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.secondary-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.dl-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 16px;
  border-radius: var(--aq-radius-md);
  border: 1px solid var(--aq-border);
  background: var(--aq-elevated);
  text-decoration: none;
  color: var(--aq-text-1);
  transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease, background 0.2s ease;
}

.dl-card:hover {
  border-color: var(--aq-border-hover);
  background: var(--aq-brand-soft);
  box-shadow: 0 0 0 1px var(--aq-glow-soft);
  transform: translateY(-1px);
}

.dl-card.primary {
  border-color: rgba(63, 186, 64, 0.3);
  background: linear-gradient(135deg, rgba(63, 186, 64, 0.1), var(--aq-elevated));
  min-height: 72px;
}

.dl-left {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.dl-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--aq-bg-1);
  border: 1px solid var(--aq-border);
  color: var(--aq-brand);
  font-size: 18px;
  flex-shrink: 0;
}

.dl-text {
  min-width: 0;
}

.dl-name {
  font-weight: 650;
  font-size: 15px;
  margin-bottom: 4px;
  letter-spacing: -0.01em;
}

.dl-file {
  display: block;
  font-family: var(--aq-font-mono);
  font-size: 11px;
  color: var(--aq-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: transparent;
  padding: 0;
  border: none;
}

.dl-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--aq-brand);
  color: #fff;
  font-size: 13px;
  font-weight: 650;
}

.sec-dl {
  color: var(--aq-brand);
  flex-shrink: 0;
  opacity: 0.85;
}

.info-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 28px;
  padding: 14px 16px;
  border-radius: var(--aq-radius-md);
  border: 1px solid var(--aq-border);
  background: var(--aq-inset);
}

.sys-req {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: baseline;
  font-size: 13px;
}

.sys-k {
  font-family: var(--aq-font-mono);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--aq-brand);
}

.sys-v {
  color: var(--aq-text-2);
}

.releases-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--aq-font-mono);
  color: var(--aq-brand);
  text-decoration: none;
}

.releases-link:hover {
  color: var(--aq-accent);
}

.install-section {
  margin-bottom: 0;
}

.install-panel {
  padding: 18px 20px;
  border-radius: var(--aq-radius-md);
  border: 1px solid var(--aq-border);
  background: var(--aq-elevated);
}

.install-group + .install-group {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--aq-border);
}

.install-h {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 650;
  color: var(--aq-brand);
}

.install-steps {
  margin: 0;
  padding-left: 1.35em;
  list-style-type: decimal;
  list-style-position: outside;
  color: var(--aq-text-2);
  font-size: 14px;
  line-height: 1.65;
}

.install-steps li {
  display: list-item;
  padding-left: 0.2em;
}

.install-steps li + li {
  margin-top: 0.5em;
}

.install-steps li::marker {
  color: var(--aq-brand);
  font-weight: 700;
}

@media (max-width: 640px) {
  .secondary-grid {
    grid-template-columns: 1fr;
  }

  .dl-card.primary {
    flex-direction: column;
    align-items: stretch;
  }

  .dl-action {
    justify-content: center;
  }

  .os-tabs {
    grid-template-columns: 1fr;
  }
}
</style>
