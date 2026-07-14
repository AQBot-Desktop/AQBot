<script setup lang="ts">
import { ref } from 'vue';
import { Swiper, SwiperSlide } from 'swiper/vue';
import { Autoplay, Navigation, Pagination } from 'swiper/modules';
import type { Swiper as SwiperType } from 'swiper';
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';
import { useHomeCopy } from '../../../composables/useHomeCopy';

import 'swiper/css';
import 'swiper/css/navigation';
import 'swiper/css/pagination';

const { copy } = useHomeCopy();

const modules = [Autoplay, Navigation, Pagination];

/* Full set — same as original site carousel (s1–s10) */
const shots = [
  { src: '/screenshots/s1-0412.png', alt: 'Chat with diagram rendering' },
  { src: '/screenshots/s2-0412.png', alt: 'Providers and models' },
  { src: '/screenshots/s3-0412.png', alt: 'Knowledge base' },
  { src: '/screenshots/s4-0412.png', alt: 'Memory' },
  { src: '/screenshots/s5-0412.png', alt: 'Agent ask / tool flow' },
  { src: '/screenshots/s6-0412.png', alt: 'API gateway one-click setup' },
  { src: '/screenshots/s7-0412.png', alt: 'Conversation model picker' },
  { src: '/screenshots/s8-0412.png', alt: 'Conversation navigation' },
  { src: '/screenshots/s9-0412.png', alt: 'Agent permission approval' },
  { src: '/screenshots/s10-0412.png', alt: 'API gateway overview' },
];

const active = ref(0);
const swiperRef = ref<SwiperType | null>(null);

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
  <section class="aq-section showcase">
    <div class="aq-container">
      <div class="head">
        <div class="aq-section-label">{{ copy.showcaseLabel }}</div>
        <h2 class="aq-section-title">{{ copy.showcaseTitle }}</h2>
        <p class="aq-section-desc">{{ copy.showcaseDesc }}</p>
      </div>

      <div class="carousel-wrap">
        <div class="frame main">
          <div class="frame-bar">
            <span class="frame-tag">preview</span>
            <span class="frame-path">~/AQBot/screenshots</span>
          </div>
          <div class="stage">
            <Swiper
              :modules="modules"
              :slides-per-view="1"
              :loop="true"
              :grab-cursor="true"
              :simulate-touch="true"
              :allow-touch-move="true"
              :speed="450"
              :autoplay="{
                delay: 3000,
                disableOnInteraction: false,
                pauseOnMouseEnter: true,
              }"
              :navigation="{
                nextEl: '.showcase-next',
                prevEl: '.showcase-prev',
              }"
              :pagination="{ clickable: true, el: '.showcase-pagination' }"
              class="showcase-swiper"
              @swiper="onSwiper"
              @slide-change="onSlideChange"
            >
              <SwiperSlide v-for="(shot, i) in shots" :key="shot.src">
                <img
                  :src="shot.src"
                  :alt="shot.alt"
                  width="2670"
                  height="1930"
                  :loading="i === 0 ? 'eager' : 'lazy'"
                  draggable="false"
                />
              </SwiperSlide>
            </Swiper>
          </div>
        </div>

        <button type="button" class="carousel-nav showcase-prev" aria-label="Previous">
          <ChevronLeft :size="22" />
        </button>
        <button type="button" class="carousel-nav showcase-next" aria-label="Next">
          <ChevronRight :size="22" />
        </button>
      </div>

      <div class="showcase-pagination" />

      <div class="thumbs" role="tablist">
        <button
          v-for="(shot, i) in shots"
          :key="shot.src"
          type="button"
          class="thumb"
          :class="{ active: active === i }"
          :aria-selected="active === i"
          @click="goTo(i)"
        >
          <img :src="shot.src" :alt="shot.alt" loading="lazy" draggable="false" />
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.showcase {
  padding-top: 40px;
}

.head {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 36px;
}

.head .aq-section-desc {
  text-align: center;
}

.carousel-wrap {
  position: relative;
  max-width: 960px;
  margin: 0 auto;
}

.main {
  max-width: 960px;
  margin: 0 auto;
}

.frame {
  border-radius: var(--aq-radius-lg);
  border: 1px solid var(--aq-border);
  background: var(--aq-bg-1);
  box-shadow: var(--aq-shadow-glow), var(--aq-shadow-md);
  overflow: hidden;
}

.frame-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--aq-bg-2);
  border-bottom: 1px solid var(--aq-border);
  font-family: var(--aq-font-mono);
  font-size: 11px;
}

.frame-tag {
  color: var(--aq-brand);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.frame-path {
  color: var(--aq-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stage {
  position: relative;
}

.showcase-swiper {
  width: 100%;
  cursor: grab;
  user-select: none;
  touch-action: pan-y;
}

.showcase-swiper:active {
  cursor: grabbing;
}

.showcase-swiper :deep(.swiper-slide) {
  background: var(--aq-bg-1);
}

.showcase-swiper :deep(img) {
  display: block;
  width: 100%;
  height: auto;
  pointer-events: none;
}

/* Arrows — hidden until hover (always visible on coarse pointers) */
.carousel-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid var(--aq-border);
  background: var(--aq-bg-1);
  color: var(--aq-text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.2s ease,
    color 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    background 0.2s ease;
  box-shadow: var(--aq-shadow-sm);
}

.carousel-wrap:hover .carousel-nav {
  opacity: 1;
  pointer-events: auto;
}

.carousel-nav:hover {
  color: var(--aq-brand);
  border-color: var(--aq-border-hover);
  background: var(--aq-elevated-hover);
  box-shadow: 0 0 0 1px var(--aq-glow-soft), var(--aq-shadow-sm);
}

.showcase-prev {
  left: 12px;
}

.showcase-next {
  right: 12px;
}

@media (min-width: 1000px) {
  .showcase-prev {
    left: -20px;
  }
  .showcase-next {
    right: -20px;
  }
}

/* Touch / no-hover devices: always show arrows */
@media (hover: none), (pointer: coarse) {
  .carousel-nav {
    opacity: 0.92;
    pointer-events: auto;
  }
}

.showcase-pagination {
  display: flex;
  justify-content: center;
  gap: 6px;
  margin-top: 16px;
  min-height: 10px;
}

.showcase-pagination :deep(.swiper-pagination-bullet) {
  width: 8px;
  height: 8px;
  border-radius: 4px;
  background: var(--aq-text-3);
  opacity: 0.4;
  margin: 0 !important;
  transition: all 0.25s ease;
}

.showcase-pagination :deep(.swiper-pagination-bullet-active) {
  width: 22px;
  background: var(--aq-brand);
  opacity: 1;
}

.thumbs {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
  flex-wrap: wrap;
  max-width: 960px;
  margin-left: auto;
  margin-right: auto;
}

.thumb {
  width: 72px;
  height: 48px;
  padding: 0;
  border-radius: 8px;
  border: 1px solid var(--aq-border);
  overflow: hidden;
  cursor: pointer;
  background: var(--aq-bg-1);
  opacity: 0.55;
  transition: opacity 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.thumb:hover {
  opacity: 0.85;
}

.thumb.active {
  opacity: 1;
  border-color: var(--aq-border-hover);
  box-shadow: 0 0 0 1px var(--aq-glow-soft);
}

@media (max-width: 640px) {
  .thumb {
    width: 56px;
    height: 38px;
  }

  .carousel-nav {
    width: 38px;
    height: 38px;
  }

  .showcase-prev {
    left: 8px;
  }
  .showcase-next {
    right: 8px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .showcase-swiper :deep(.swiper-wrapper) {
    transition-duration: 0ms !important;
  }
}
</style>
