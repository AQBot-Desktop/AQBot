<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Swiper, SwiperSlide } from 'swiper/vue';
import { Autoplay, Navigation, Pagination } from 'swiper/modules';
import type { Swiper as SwiperType } from 'swiper';
import { useSiteLocale } from '../i18n';

import 'swiper/css';
import 'swiper/css/navigation';
import 'swiper/css/pagination';

export interface Shot {
  src: string;
  alt: string;
}

const props = withDefaults(
  defineProps<{
    heading?: string;
    description?: string;
    shots?: Shot[];
  }>(),
  {
    shots: () => [
      { src: '/screenshots/s1-0412.png', alt: '多模型对话与图表渲染' },
      { src: '/screenshots/s2-0412.png', alt: '多服务商与自定义端点' },
      { src: '/screenshots/s3-0412.png', alt: '本地向量知识库管理' },
      { src: '/screenshots/s4-0412.png', alt: '会话记忆与角色设定' },
      { src: '/screenshots/s5-0412.png', alt: 'AI Agent 工具调用流' },
      { src: '/screenshots/s6-0412.png', alt: '内置本地 API 网关' },
      { src: '/screenshots/s7-0412.png', alt: '模型切换与参数配置' },
      { src: '/screenshots/s8-0412.png', alt: '多会话分组与搜索' },
      { src: '/screenshots/s9-0412.png', alt: 'Agent 权限沙箱审批' },
      { src: '/screenshots/s10-0412.png', alt: '网关概览与调用统计' },
    ],
  },
);

const locale = useSiteLocale();

const defaultHeading = computed(() => {
  return locale.value === 'zh' || locale.value === 'zh-tw'
    ? '原生桌面客户端体验'
    : 'Native Desktop Experience';
});

const defaultDescription = computed(() => {
  return locale.value === 'zh' || locale.value === 'zh-tw'
    ? '界面清晰、操作流畅，多模型调度、本地知识库与网关状态一目了然。'
    : 'Clean layout, fluid workflow — multi-model routing, local knowledge base, and gateway status at a glance.';
});

const modules = [Autoplay, Navigation, Pagination];
const active = ref(0);
const swiperRef = ref<SwiperType | null>(null);
const reducedMotion = ref(false);

onMounted(() => {
  reducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
});

const autoplay = computed(() =>
  reducedMotion.value
    ? false
    : {
        delay: 4500,
        disableOnInteraction: false,
        pauseOnMouseEnter: true,
      },
);

function onSwiper(swiper: SwiperType) {
  swiperRef.value = swiper;
}

function goTo(i: number) {
  swiperRef.value?.slideToLoop(i);
}

function onSlideChange(swiper: SwiperType) {
  active.value = swiper.realIndex;
}
</script>

<template>
  <section class="hd-shots">
    <div class="hd-shots-header">
      <h2 class="hd-shots-title">{{ heading || defaultHeading }}</h2>
      <p class="hd-shots-lead">{{ description || defaultDescription }}</p>
    </div>

    <div class="hd-shots-frame">
      <!-- Top Chrome Bar -->
      <div class="hd-shots-bar">
        <div class="hd-shots-bar-left">
          <span class="hd-shots-dot" />
          <span class="hd-shots-dot" />
          <span class="hd-shots-dot" />
          <span class="hd-shots-title-text">
            {{ shots[active]?.alt || 'AQBot UI' }}
          </span>
        </div>

        <div class="hd-shots-controls">
          <button
            type="button"
            class="hd-shot-nav hd-shot-prev"
            aria-label="Previous"
            @click="swiperRef?.slidePrev()"
          >
            ←
          </button>
          <span class="hd-shot-counter">
            {{ String(active + 1).padStart(2, '0') }} / {{ String(shots.length).padStart(2, '0') }}
          </span>
          <button
            type="button"
            class="hd-shot-nav hd-shot-next"
            aria-label="Next"
            @click="swiperRef?.slideNext()"
          >
            →
          </button>
        </div>
      </div>

      <!-- Swiper Stage -->
      <div class="hd-shots-stage">
        <Swiper
          :modules="modules"
          :slides-per-view="1"
          :loop="true"
          :speed="400"
          :autoplay="autoplay"
          @swiper="onSwiper"
          @slide-change="onSlideChange"
        >
          <SwiperSlide v-for="(shot, i) in shots" :key="i">
            <div class="hd-shot-slide">
              <img
                :src="shot.src"
                :alt="shot.alt"
                class="hd-shot-img"
                loading="lazy"
              />
            </div>
          </SwiperSlide>
        </Swiper>
      </div>

      <!-- Bottom Thumbnail Navigation Strip -->
      <div class="hd-shots-thumb-strip">
        <button
          v-for="(shot, i) in shots"
          :key="i"
          type="button"
          class="hd-shot-thumb"
          :class="{ active: active === i }"
          :aria-label="shot.alt"
          @click="goTo(i)"
        >
          <span class="thumb-n">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="thumb-title">{{ shot.alt }}</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hd-shots {
  padding: 52px var(--gut);
  background: var(--bg);
  border-bottom: 1px solid var(--line2);
}

.hd-shots-header {
  margin-bottom: 24px;
}

.hd-shots-title {
  font-family: var(--disp);
  font-weight: 900;
  font-size: clamp(26px, 3.6vw, 44px);
  letter-spacing: -0.04em;
  color: var(--ink);
  line-height: 1.05;
  margin: 0;
}

.hd-shots-lead {
  color: var(--dim);
  font-size: 15px;
  line-height: 1.7;
  max-width: 64ch;
  margin: 12px 0 0;
}

/* ── Frame Chassis ── */
.hd-shots-frame {
  border: 1px solid var(--line2);
  background: var(--panel);
  overflow: hidden;
}

/* ── Top Chrome Bar ── */
.hd-shots-bar {
  height: 42px;
  border-bottom: 1px solid var(--line2);
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
}

.hd-shots-bar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.hd-shots-dot {
  width: 9px;
  height: 9px;
  border: 1px solid var(--line2);
  background: var(--mass);
  display: inline-block;
}

.hd-shots-title-text {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--ink);
  letter-spacing: 0.04em;
  margin-left: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hd-shots-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.hd-shot-nav {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line2);
  background: var(--panel);
  color: var(--dim);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 13px;
  transition: all 0.12s ease;
}

.hd-shot-nav:hover {
  border-color: var(--spot);
  color: var(--spot);
}

.hd-shot-counter {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}

/* ── Stage ── */
.hd-shots-stage {
  background: #000;
  width: 100%;
}

.hd-shot-slide {
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
}

.hd-shot-img {
  width: 100%;
  height: auto;
  display: block;
  object-fit: contain;
  max-height: 720px;
}

/* ── Bottom Thumbnail Strip ── */
.hd-shots-thumb-strip {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  border-top: 1px solid var(--line2);
  background: var(--bg);
}

.hd-shot-thumb {
  padding: 10px 12px;
  border: 0;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  text-align: left;
  transition: background-color 0.12s ease;
}

.hd-shot-thumb:nth-child(5n) {
  border-right: 0;
}

.hd-shot-thumb:nth-child(n + 6) {
  border-bottom: 0;
}

.hd-shot-thumb:hover {
  background: color-mix(in srgb, var(--spot) 5%, var(--bg));
}

.hd-shot-thumb.active {
  background: color-mix(in srgb, var(--spot) 8%, var(--bg));
  border-top: 2px solid var(--spot);
  margin-top: -2px;
}

.thumb-n {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--faint);
}

.hd-shot-thumb.active .thumb-n {
  color: var(--spot);
}

.thumb-title {
  font-family: var(--body);
  font-size: 11.5px;
  color: var(--dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
}

.hd-shot-thumb.active .thumb-title {
  color: var(--ink);
  font-weight: 500;
}

@media (max-width: 900px) {
  .hd-shots-thumb-strip {
    grid-template-columns: repeat(2, 1fr);
  }
  .hd-shot-thumb:nth-child(2n) {
    border-right: 0;
  }
  .hd-shot-thumb:nth-child(n) {
    border-bottom: 1px solid var(--line);
  }
  .hd-shot-thumb:last-child {
    border-bottom: 0;
  }
}
</style>
