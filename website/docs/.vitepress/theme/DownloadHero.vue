<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useData } from 'vitepress';
import { APP_VERSION, GITHUB_RELEASES, GITHUB_RELEASE_TAG } from './constants';
import { generalUiCopy, useSiteLocale } from './i18n';

const VERSION = APP_VERSION;
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
  { os: 'macos', arch: 'Apple Silicon', labelEn: 'Apple Silicon (M1–M4)', labelZh: 'Apple Silicon（M 系列芯片）', file: `AQBot_${VERSION}_aarch64.dmg`, primary: true },
  { os: 'macos', arch: 'Intel', labelEn: 'Intel x64', labelZh: 'Intel x64（英特尔芯片）', file: `AQBot_${VERSION}_x64.dmg`, primary: true },
  { os: 'windows', arch: 'x64', labelEn: 'Windows x64 Setup', labelZh: 'Windows x64 安装包', file: `AQBot_${VERSION}_x64-setup.exe`, primary: true },
  { os: 'windows', arch: 'x64 Portable', labelEn: 'Windows x64 Portable', labelZh: 'Windows x64 绿色版', file: `AQBot_v${VERSION}_windows-x64-portable.zip` },
  { os: 'windows', arch: 'ARM64', labelEn: 'Windows ARM64 Setup', labelZh: 'Windows ARM64 安装包', file: `AQBot_${VERSION}_arm64-setup.exe` },
  { os: 'windows', arch: 'ARM64 Portable', labelEn: 'Windows ARM64 Portable', labelZh: 'Windows ARM64 绿色版', file: `AQBot_v${VERSION}_windows-arm64-portable.zip` },
  { os: 'linux', arch: 'x64 deb', labelEn: 'x64 .deb (Debian / Ubuntu)', labelZh: 'x64 .deb（Debian / Ubuntu）', file: `AQBot_${VERSION}_amd64.deb`, primary: true },
  { os: 'linux', arch: 'x64 AppImage', labelEn: 'x64 AppImage', labelZh: 'x64 AppImage', file: `AQBot_${VERSION}_amd64.AppImage`, primary: true },
  { os: 'linux', arch: 'ARM64 deb', labelEn: 'ARM64 .deb', labelZh: 'ARM64 .deb', file: `AQBot_${VERSION}_arm64.deb` },
  { os: 'linux', arch: 'x64 rpm', labelEn: 'x64 .rpm (Fedora / RHEL)', labelZh: 'x64 .rpm（Fedora / RHEL）', file: `AQBot-${VERSION}-1.x86_64.rpm` },
  { os: 'linux', arch: 'ARM64 rpm', labelEn: 'ARM64 .rpm', labelZh: 'ARM64 .rpm', file: `AQBot-${VERSION}-1.aarch64.rpm` },
];

const osTabs: { id: OS; label: string }[] = [
  { id: 'macos', label: 'macOS' },
  { id: 'windows', label: 'Windows' },
  { id: 'linux', label: 'Linux' },
];

const locale = useSiteLocale();
const generalCopy = computed(() => generalUiCopy(locale.value));
const isZh = computed(() => locale.value === 'zh' || locale.value === 'zh-tw');
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

const installSteps = computed(() => {
  if (activeOS.value === 'macos') {
    return isZh.value
      ? [
          '打开下载的 .dmg 磁盘映像文件。',
          '将 AQBot 图标拖拽到 Applications (应用程序) 文件夹。',
          '首次运行如遇安全提示，在「系统设置 → 隐私与安全性」中点击「仍要打开」即可。',
        ]
      : [
          'Open the downloaded .dmg disk image.',
          'Drag the AQBot icon into your Applications folder.',
          'If prompted on first launch, click "Open Anyway" under System Settings → Privacy & Security.',
        ];
  }
  if (activeOS.value === 'windows') {
    return isZh.value
      ? [
          '运行下载的安装程序（或解压绿色版 .zip 压缩包）。',
          '按照安装向导完成安装，启动 AQBot。',
          '可在托盘或设置中开启开机自启与全局快捷键。',
        ]
      : [
          'Run the downloaded installer (or extract the Portable .zip).',
          'Follow the setup wizard to launch AQBot.',
          'Optionally enable launch on startup and global shortcuts in settings.',
        ];
  }
  return isZh.value
    ? [
        'Debian / Ubuntu: sudo dpkg -i AQBot_*.deb',
        'AppImage: chmod +x AQBot_*.AppImage && ./AQBot_*.AppImage',
        'Fedora / RHEL: sudo rpm -i AQBot-*.rpm',
      ]
    : [
        'Debian / Ubuntu: sudo dpkg -i AQBot_*.deb',
        'AppImage: chmod +x AQBot_*.AppImage && ./AQBot_*.AppImage',
        'Fedora / RHEL: sudo rpm -i AQBot-*.rpm',
      ];
});
</script>

<template>
  <div class="hd-download-page">
    <div class="hd-download-frame">
      <!-- ── Page Header ── -->
      <header class="hd-dl-hero">
        <h1 class="hd-dl-title">
          {{ isZh ? '下载 AQBot 桌面客户端' : 'Download AQBot for Desktop' }}
        </h1>
        <p class="hd-dl-lead">
          {{
            isZh
              ? '免费开源。支持 macOS、Windows 与主流 Linux 系统，内置本地 API 网关与知识库，离线安装即用。'
              : 'Free and open-source. Available for macOS, Windows, and Linux. Built-in local gateway and private RAG.'
          }}
        </p>

        <div class="hd-dl-meta-strip">
          <a
            class="hd-dl-tag version"
            :href="GITHUB_RELEASE_TAG"
            target="_blank"
            rel="noopener"
          >
            v{{ VERSION }}
          </a>
          <span class="hd-dl-tag">macOS 11+ · Windows 10+ · Linux</span>
          <span class="hd-dl-tag">AGPL-3.0 License</span>
          <a
            class="hd-dl-tag release-link"
            :href="GITHUB_RELEASES"
            target="_blank"
            rel="noopener"
          >
            {{ isZh ? '更新日志与所有版本 →' : 'Changelog & Releases →' }}
          </a>
        </div>
      </header>

      <!-- ── OS Switcher Tabs ── -->
      <div class="hd-dl-os-tabs">
        <button
          v-for="tab in osTabs"
          :key="tab.id"
          type="button"
          class="hd-os-tab"
          :class="{ active: activeOS === tab.id }"
          @click="activeOS = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- ── Primary Download Matrix ── -->
      <section class="hd-dl-section">
        <div class="hd-dl-sec-hd">
          <h2 class="hd-dl-h2">
            {{ isZh ? '安装包下载' : 'Installation Packages' }}
          </h2>
        </div>

        <div class="hd-dl-cards">
          <div
            v-for="item in primaryDownloads"
            :key="item.file"
            class="hd-dl-card"
          >
            <div class="hd-dl-card-top">
              <h3 class="hd-card-title">{{ itemLabel(item) }}</h3>
              <p class="hd-card-file"><code>{{ item.file }}</code></p>
            </div>
            <a
              class="hd-btn hd-btn-primary hd-card-btn"
              :href="downloadUrl(item)"
              download
            >
              {{ isZh ? '直接下载' : 'Download' }} ({{ item.arch }})
            </a>
          </div>
        </div>

        <!-- Secondary/Alternative downloads -->
        <div v-if="moreDownloads.length > 0" class="hd-dl-more">
          <div class="hd-more-title">
            {{ isZh ? '其他架构与格式' : 'Other Architectures & Formats' }}
          </div>
          <div class="hd-more-list">
            <div
              v-for="item in moreDownloads"
              :key="item.file"
              class="hd-more-item"
            >
              <div class="hd-more-info">
                <b>{{ itemLabel(item) }}</b>
                <code>{{ item.file }}</code>
              </div>
              <a
                class="hd-btn hd-btn-ghost hd-more-btn"
                :href="downloadUrl(item)"
                download
              >
                {{ isZh ? '下载' : 'Download' }}
              </a>
            </div>
          </div>
        </div>
      </section>

      <!-- ── Installation Steps ── -->
      <section class="hd-dl-section hd-dl-steps-sec">
        <div class="hd-dl-sec-hd">
          <h2 class="hd-dl-h2">
            {{ isZh ? '安装指引' : 'Installation Guide' }}
          </h2>
        </div>

        <div class="hd-steps-list">
          <div
            v-for="(step, idx) in installSteps"
            :key="idx"
            class="hd-step-item"
          >
            <span class="step-idx">0{{ idx + 1 }}</span>
            <p class="step-p">{{ step }}</p>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.hd-download-page {
  background: var(--bg);
  min-height: calc(100vh - 120px);
}

.hd-download-frame {
  max-width: 1440px;
  margin: 0 auto;
  border-left: 1px solid var(--line2);
  border-right: 1px solid var(--line2);
  border-bottom: 1px solid var(--line2);
  background: var(--bg);
  box-sizing: border-box;
}

/* ── Hero ── */
.hd-dl-hero {
  padding: 56px var(--gut) 40px;
  border-bottom: 1px solid var(--line2);
  background: var(--bg);
}

.hd-dl-title {
  font-family: var(--disp);
  font-weight: 900;
  font-size: clamp(32px, 4.5vw, 54px);
  letter-spacing: -0.045em;
  line-height: 1.05;
  color: var(--ink);
  margin: 0;
}

.hd-dl-lead {
  color: var(--dim);
  font-size: 16px;
  line-height: 1.7;
  max-width: 66ch;
  margin: 16px 0 24px;
}

.hd-dl-meta-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.hd-dl-tag {
  font-family: var(--mono);
  font-size: 11px;
  padding: 3px 8px;
  border: 1px solid var(--line2);
  background: var(--panel);
  color: var(--dim);
  text-decoration: none !important;
}

.hd-dl-tag.version {
  color: var(--spot);
  border-color: var(--spot);
  font-weight: 600;
}

.hd-dl-tag.release-link:hover {
  color: var(--spot);
}

/* ── OS Tabs ── */
.hd-dl-os-tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--line2);
  background: var(--panel);
}

.hd-os-tab {
  height: 46px;
  padding: 0 28px;
  border: 0;
  border-right: 1px solid var(--line2);
  background: transparent;
  color: var(--dim);
  font-family: var(--disp);
  font-weight: 800;
  font-size: 14px;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: all 0.12s ease;
}

.hd-os-tab:hover {
  color: var(--ink);
}

.hd-os-tab.active {
  background: var(--bg);
  color: var(--spot);
  border-bottom: 2px solid var(--spot);
  margin-bottom: -1px;
}

/* ── Sections ── */
.hd-dl-section {
  padding: 44px var(--gut);
  border-bottom: 1px solid var(--line2);
}

.hd-dl-sec-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 22px;
}

.hd-dl-h2 {
  font-family: var(--disp);
  font-weight: 800;
  font-size: 20px;
  letter-spacing: -0.025em;
  color: var(--ink);
  margin: 0;
}

/* ── Primary Cards Matrix ── */
.hd-dl-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.hd-dl-card {
  border: 1px solid var(--line2);
  background: var(--panel);
  padding: 24px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 20px;
  transition: border-color 0.12s ease;
}

.hd-dl-card:hover {
  border-color: var(--spot);
}

.hd-card-title {
  font-family: var(--disp);
  font-weight: 800;
  font-size: 17px;
  color: var(--ink);
  margin: 0 0 6px;
}

.hd-card-file code {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--dim);
}

.hd-card-btn {
  width: 100%;
  height: 42px;
}

/* ── More/Alternative Downloads ── */
.hd-dl-more {
  margin-top: 32px;
  border: 1px solid var(--line);
  background: var(--bg);
}

.hd-more-title {
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
}

.hd-more-list {
  display: flex;
  flex-direction: column;
}

.hd-more-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
}

.hd-more-item:last-child {
  border-bottom: 0;
}

.hd-more-info {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.hd-more-info b {
  font-family: var(--body);
  font-size: 13.5px;
  color: var(--ink);
}

.hd-more-info code {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--dim);
}

.hd-more-btn {
  height: 32px;
  padding: 0 14px;
  font-size: 12px;
}

/* ── Installation Steps ── */
.hd-steps-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hd-step-item {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 14px 18px;
  border: 1px solid var(--line);
  background: var(--bg);
}

.step-idx {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--spot);
  padding: 2px 6px;
  border: 1px solid var(--line2);
  background: var(--panel);
}

.step-p {
  margin: 0;
  font-family: var(--body);
  font-size: 14px;
  color: var(--dim);
  line-height: 1.6;
}

@media (max-width: 900px) {
  .hd-download-frame {
    border-left: 0;
    border-right: 0;
  }
  .hd-dl-hero,
  .hd-dl-section {
    padding: 36px var(--gut);
  }
}
</style>
