<script setup lang="ts">
import { computed } from 'vue';
import { useSiteLocale } from '../i18n';

const locale = useSiteLocale();

const stats = computed(() => {
  switch (locale.value) {
    case 'zh':
      return [
        { val: '100%', label: '本地优先 · AES-256 加密存储' },
        { val: '50+', label: '服务商与多模型直连调度' },
        { val: '127.0.0.1', label: '内置本地 AI 兼容网关' },
        { val: '跨平台', label: 'macOS · Windows · Linux' },
      ];
    case 'zh-tw':
      return [
        { val: '100%', label: '本地優先 · AES-256 加密儲存' },
        { val: '50+', label: '服務商與多模型直連排程' },
        { val: '127.0.0.1', label: '內建本地 AI 相容閘道' },
        { val: '跨平台', label: 'macOS · Windows · Linux' },
      ];
    case 'ja':
      return [
        { val: '100%', label: 'ローカル優先 · AES-256暗号化' },
        { val: '50+', label: 'マルチプロバイダー＆モデル対応' },
        { val: '127.0.0.1', label: 'ローカルAIゲートウェイ内蔵' },
        { val: 'マルチOS', label: 'macOS · Windows · Linux' },
      ];
    case 'ko':
      return [
        { val: '100%', label: '로컬 우선 · AES-256 암호화' },
        { val: '50+', label: '멀티 프로바이더 및 모델 지원' },
        { val: '127.0.0.1', label: '로컬 AI 호환 게이트웨이 내장' },
        { val: '크로스 플랫폼', label: 'macOS · Windows · Linux' },
      ];
    case 'ru':
      return [
        { val: '100%', label: 'Локально · AES-256 шифрование' },
        { val: '50+', label: 'Прямое подключение к моделям' },
        { val: '127.0.0.1', label: 'Встроенный локальный AI-шлюз' },
        { val: 'Кроссплатформенный', label: 'macOS · Windows · Linux' },
      ];
    case 'fr':
      return [
        { val: '100%', label: 'Local-first · Chiffrement AES-256' },
        { val: '50+', label: 'Modèles et fournisseurs directs' },
        { val: '127.0.0.1', label: 'Passerelle API IA intégrée' },
        { val: 'Multiplateforme', label: 'macOS · Windows · Linux' },
      ];
    case 'de':
      return [
        { val: '100%', label: 'Local-First · AES-256-Verschlüsselung' },
        { val: '50+', label: 'Direkte Modellanbindung' },
        { val: '127.0.0.1', label: 'Integriertes lokales KI-Gateway' },
        { val: 'Plattformübergreifend', label: 'macOS · Windows · Linux' },
      ];
    case 'es':
      return [
        { val: '100%', label: 'Local-first · Cifrado AES-256' },
        { val: '50+', label: 'Conexión multimodelo directa' },
        { val: '127.0.0.1', label: 'Pasarela API local integrada' },
        { val: 'Multiplataforma', label: 'macOS · Windows · Linux' },
      ];
    default:
      return [
        { val: '100%', label: 'Local-first · AES-256 encrypted' },
        { val: '50+', label: 'Direct multi-model & provider routing' },
        { val: '127.0.0.1', label: 'Built-in local AI API gateway' },
        { val: 'Cross-platform', label: 'macOS · Windows · Linux' },
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
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 2v20M2 12h20"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="square"
            />
          </svg>
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
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
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
