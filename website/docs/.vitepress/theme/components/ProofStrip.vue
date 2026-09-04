<script setup lang="ts">
import { computed } from 'vue';
import { useSiteLocale } from '../i18n';

const locale = useSiteLocale();

const stats = computed(() => {
  switch (locale.value) {
    case 'zh':
      return [
        { val: '100%', icon: 'far fa-hard-drive', label: '本地优先 · AES-256 加密存储' },
        { val: '50+', icon: 'far fa-comments', label: '服务商与多模型直连调度' },
        { val: '127.0.0.1', icon: 'far fa-share-from-square', label: '内置本地 AI 兼容网关' },
        { val: '跨平台', icon: 'far fa-window-maximize', label: 'macOS · Windows · Linux' },
      ];
    case 'zh-tw':
      return [
        { val: '100%', icon: 'far fa-hard-drive', label: '本地優先 · AES-256 加密儲存' },
        { val: '50+', icon: 'far fa-comments', label: '服務商與多模型直連排程' },
        { val: '127.0.0.1', icon: 'far fa-share-from-square', label: '內建本地 AI 相容閘道' },
        { val: '跨平台', icon: 'far fa-window-maximize', label: 'macOS · Windows · Linux' },
      ];
    case 'ja':
      return [
        { val: '100%', icon: 'far fa-hard-drive', label: 'ローカル優先 · AES-256暗号化' },
        { val: '50+', icon: 'far fa-comments', label: 'マルチプロバイダー＆モデル対応' },
        { val: '127.0.0.1', icon: 'far fa-share-from-square', label: 'ローカルAIゲートウェイ内蔵' },
        { val: 'マルチOS', icon: 'far fa-window-maximize', label: 'macOS · Windows · Linux' },
      ];
    case 'ko':
      return [
        { val: '100%', icon: 'far fa-hard-drive', label: '로컬 우선 · AES-256 암호화' },
        { val: '50+', icon: 'far fa-comments', label: '멀티 프로바이더 및 모델 지원' },
        { val: '127.0.0.1', icon: 'far fa-share-from-square', label: '로컬 AI 호환 게이트웨이 내장' },
        { val: '크로스 플랫폼', icon: 'far fa-window-maximize', label: 'macOS · Windows · Linux' },
      ];
    case 'ru':
      return [
        { val: '100%', icon: 'far fa-hard-drive', label: 'Локально · AES-256 шифрование' },
        { val: '50+', icon: 'far fa-comments', label: 'Прямое подключение к моделям' },
        { val: '127.0.0.1', icon: 'far fa-share-from-square', label: 'Встроенный локальный AI-шлюз' },
        { val: 'Кроссплатформенный', icon: 'far fa-window-maximize', label: 'macOS · Windows · Linux' },
      ];
    case 'fr':
      return [
        { val: '100%', icon: 'far fa-hard-drive', label: 'Local-first · Chiffrement AES-256' },
        { val: '50+', icon: 'far fa-comments', label: 'Modèles et fournisseurs directs' },
        { val: '127.0.0.1', icon: 'far fa-share-from-square', label: 'Passerelle API IA intégrée' },
        { val: 'Multiplateforme', icon: 'far fa-window-maximize', label: 'macOS · Windows · Linux' },
      ];
    case 'de':
      return [
        { val: '100%', icon: 'far fa-hard-drive', label: 'Local-First · AES-256-Verschlüsselung' },
        { val: '50+', icon: 'far fa-comments', label: 'Direkte Modellanbindung' },
        { val: '127.0.0.1', icon: 'far fa-share-from-square', label: 'Integriertes lokales KI-Gateway' },
        { val: 'Plattformübergreifend', icon: 'far fa-window-maximize', label: 'macOS · Windows · Linux' },
      ];
    case 'es':
      return [
        { val: '100%', icon: 'far fa-hard-drive', label: 'Local-first · Cifrado AES-256' },
        { val: '50+', icon: 'far fa-comments', label: 'Conexión multimodelo directa' },
        { val: '127.0.0.1', icon: 'far fa-share-from-square', label: 'Pasarela API local integrada' },
        { val: 'Multiplataforma', icon: 'far fa-window-maximize', label: 'macOS · Windows · Linux' },
      ];
    default:
      return [
        { val: '100%', icon: 'far fa-hard-drive', label: 'Local-first · AES-256 encrypted' },
        { val: '50+', icon: 'far fa-comments', label: 'Direct multi-model & provider routing' },
        { val: '127.0.0.1', icon: 'far fa-share-from-square', label: 'Built-in local AI API gateway' },
        { val: 'Cross-platform', icon: 'far fa-window-maximize', label: 'macOS · Windows · Linux' },
      ];
  }
});
</script>

<template>
  <div class="sm-strip-wrap">
    <div class="strip">
      <div v-for="(stat, idx) in stats" :key="idx" class="stat">
        <b>{{ stat.val }}</b>
        <span>
          <i :class="['ic', stat.icon]" aria-hidden="true" />
          {{ stat.label }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sm-strip-wrap {
  width: 100%;
}

.strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-top: 1px solid var(--line2);
  border-bottom: 1px solid var(--line2);
  background: var(--bg);
}

.stat {
  position: relative;
  display: block;
  overflow: hidden;
  padding: 22px var(--gut) 24px;
  border-right: 1px solid var(--line);
  box-sizing: border-box;
  transition: background-color 0.12s ease;
}

.stat:last-child {
  border-right: 0;
}

.stat:hover {
  background: color-mix(in srgb, var(--spot) 5%, transparent);
}

.stat b {
  display: block;
  font-family: var(--disp);
  font-weight: 900;
  font-size: clamp(22px, 2.6vw, 34px);
  letter-spacing: -0.04em;
  line-height: 1;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}

.stat span {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  color: var(--dim);
  font-family: var(--body);
  font-size: 11.5px;
}

.stat:hover span {
  color: var(--ink);
}

.stat .ic {
  width: auto;
  height: auto;
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--spot);
  opacity: 0.9;
}

@media (max-width: 900px) {
  .strip {
    grid-template-columns: 1fr 1fr;
  }
  .strip .stat:nth-child(2n) {
    border-right: 0;
  }
  .strip .stat:nth-child(-n + 2) {
    border-bottom: 1px solid var(--line);
  }
}

@media (max-width: 560px) {
  .strip {
    grid-template-columns: 1fr;
  }
  .strip .stat {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .strip .stat:last-child {
    border-bottom: 0;
  }
}
</style>
