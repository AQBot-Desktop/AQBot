<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';

const canvasRef = ref<HTMLCanvasElement | null>(null);

const CHARS =
  '01アイウエオカキクケコABCDEFGHIJKLMNOPQRSTUVWXYZ#$%&*+=<>/\\|{}[]░▒▓█@aqbot:~#_$';

let raf = 0;
let running = false;
let reduced = false;

let cols = 0;
let rows = 0;
let cellW = 14;
let cellH = 16;
let grid: Uint16Array | null = null;
let life: Float32Array | null = null;

let mx = -9999;
let my = -9999;
let mActive = false;
let trail: Array<{ x: number; y: number; t: number }> = [];

let onResize: (() => void) | null = null;
let parentEl: HTMLElement | null = null;

function randChar() {
  return CHARS.charCodeAt((Math.random() * CHARS.length) | 0);
}

function resize(canvas: HTMLCanvasElement) {
  const parent = canvas.parentElement;
  if (!parent) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = parent.clientWidth;
  const h = parent.clientHeight;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  cellW = 14;
  cellH = 16;
  cols = Math.ceil(w / cellW) + 1;
  rows = Math.ceil(h / cellH) + 1;
  const n = cols * rows;
  grid = new Uint16Array(n);
  life = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    grid[i] = randChar();
    life[i] = Math.random() * 0.12;
  }
}

function onMove(e: MouseEvent) {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  mx = e.clientX - rect.left;
  my = e.clientY - rect.top;
  mActive = true;
  trail.push({ x: mx, y: my, t: performance.now() });
  if (trail.length > 18) trail.shift();
}

function onLeave() {
  mActive = false;
  mx = -9999;
  my = -9999;
  trail = [];
}

function frame() {
  const canvas = canvasRef.value;
  if (!running || !canvas || !grid || !life) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  ctx.font = '12px "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const now = performance.now();
  trail = trail.filter((p) => now - p.t < 420);

  const radius = 120;
  const radius2 = radius * radius;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const cx = x * cellW + cellW * 0.5;
      const cy = y * cellH + cellH * 0.5;

      let boost = 0;
      if (mActive) {
        const dx = cx - mx;
        const dy = cy - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < radius2) {
          const t = 1 - Math.sqrt(d2) / radius;
          boost = t * t;
          if (Math.random() < 0.28 * boost) {
            grid[i] = randChar();
          }
          life[i] = Math.min(1, life[i] + boost * 0.4);
        }
      }

      for (const p of trail) {
        const dx = cx - p.x;
        const dy = cy - p.y;
        const age = 1 - (now - p.t) / 420;
        const d2 = dx * dx + dy * dy;
        if (d2 < 55 * 55) {
          const t = (1 - Math.sqrt(d2) / 55) * age;
          boost = Math.max(boost, t * 0.75);
          if (Math.random() < 0.1 * t) grid[i] = randChar();
        }
      }

      if (Math.random() < 0.0035) {
        grid[i] = randChar();
        life[i] = Math.min(1, life[i] + 0.06);
      }
      life[i] *= 0.91;

      const a = 0.035 + life[i] * 0.55 + boost * 0.5;
      if (a < 0.03) continue;

      const ch = String.fromCharCode(grid[i]);
      const g = 150 + ((grid[i] * 7) % 70);
      ctx.fillStyle = `rgba(${36 + boost * 50}, ${g}, ${48 + boost * 40}, ${Math.min(0.95, a)})`;
      ctx.fillText(ch, cx, cy);
    }
  }

  if (mActive) {
    const grd = ctx.createRadialGradient(mx, my, 0, mx, my, 140);
    grd.addColorStop(0, 'rgba(63, 186, 64, 0.14)');
    grd.addColorStop(0.4, 'rgba(63, 186, 64, 0.05)');
    grd.addColorStop(1, 'rgba(63, 186, 64, 0)');
    ctx.fillStyle = grd;
    ctx.fillRect(mx - 150, my - 150, 300, 300);
  }

  raf = requestAnimationFrame(frame);
}

onMounted(() => {
  const canvas = canvasRef.value;
  if (!canvas) return;

  parentEl = canvas.parentElement;
  reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  resize(canvas);

  if (reduced) {
    const ctx = canvas.getContext('2d');
    if (!ctx || !grid) return;
    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(63, 186, 64, 0.1)';
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (Math.random() > 0.12) continue;
        const i = y * cols + x;
        ctx.fillText(
          String.fromCharCode(grid[i]),
          x * cellW + cellW * 0.5,
          y * cellH + cellH * 0.5,
        );
      }
    }
    return;
  }

  onResize = () => resize(canvas);
  window.addEventListener('resize', onResize);
  // Listen on hero section so pointer events work (canvas is pointer-events: none)
  parentEl?.addEventListener('mousemove', onMove, { passive: true });
  parentEl?.addEventListener('mouseleave', onLeave);

  running = true;
  raf = requestAnimationFrame(frame);
});

onBeforeUnmount(() => {
  running = false;
  cancelAnimationFrame(raf);
  if (onResize) window.removeEventListener('resize', onResize);
  parentEl?.removeEventListener('mousemove', onMove);
  parentEl?.removeEventListener('mouseleave', onLeave);
});
</script>

<template>
  <canvas ref="canvasRef" class="hero-ascii" aria-hidden="true" />
</template>

<style scoped>
.hero-ascii {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
  opacity: 0.95;
  mask-image: radial-gradient(ellipse 78% 72% at 50% 45%, #000 18%, transparent 78%);
  -webkit-mask-image: radial-gradient(ellipse 78% 72% at 50% 45%, #000 18%, transparent 78%);
}
</style>
