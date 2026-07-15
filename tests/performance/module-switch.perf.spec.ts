import { expect, test } from '@playwright/test';
import { installBrowserFixture } from './browserFixture';
import {
  attachJson,
  collectBrowserErrors,
  enforceInteractionBudget,
  installPerformanceObserver,
  measureNavigation,
  navigateWithoutMeasurement,
  type PageKey,
} from './perfMetrics';

const LIGHT_PAGES: PageKey[] = [
  'roles',
  'skills',
  'knowledge',
  'memory',
  'gateway',
  'files',
  'settings',
];

test('warm heavy and lightweight module switches emit production metrics', async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await installPerformanceObserver(page);
  await installBrowserFixture(page, {
    conversationCount: 77,
    messagesInActiveConversation: 24,
    drawingImagesPerGeneration: 1,
  });

  await page.goto('/');
  await expect(page.locator('[data-list-mode="native"]')).toBeVisible();
  await expect(page.locator('[data-aqbot-msg]')).toHaveCount(10);

  // Populate both Activity-backed pages and every lightweight resource cache before sampling.
  await navigateWithoutMeasurement(page, 'drawing');
  await navigateWithoutMeasurement(page, 'chat');
  for (const pageKey of LIGHT_PAGES) {
    await navigateWithoutMeasurement(page, pageKey);
    await navigateWithoutMeasurement(page, 'chat');
  }

  const heavyPageSamples = [];
  for (let cycle = 0; cycle < 10; cycle += 1) {
    heavyPageSamples.push(await measureNavigation(page, 'chat', 'drawing'));
    heavyPageSamples.push(await measureNavigation(page, 'drawing', 'chat'));
  }
  const lightPageSamples = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (const pageKey of LIGHT_PAGES) {
      lightPageSamples.push(await measureNavigation(page, 'chat', pageKey));
      lightPageSamples.push(await measureNavigation(page, pageKey, 'chat'));
    }
  }
  const samples = [...heavyPageSamples, ...lightPageSamples];
  const percentile95 = (values: number[]) => {
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.ceil(ordered.length * 0.95) - 1];
  };
  const pageSwitchP95 = {
    chatDrawingMs: percentile95(heavyPageSamples.map((sample) => sample.durationMs)),
    cachedLightMs: percentile95(lightPageSamples.map((sample) => sample.durationMs)),
    cachedLightByPageMs: Object.fromEntries(LIGHT_PAGES.map((pageKey) => [
      pageKey,
      percentile95(
        lightPageSamples
          .filter((sample) => sample.name.includes(pageKey))
          .map((sample) => sample.durationMs),
      ),
    ])),
    reactCommitMs: percentile95(samples.map((sample) => sample.reactCommitMs ?? Infinity)),
  };

  await expect(page.locator('[data-aqbot-msg]')).toHaveCount(10);
  await expect(page.locator('[data-page-scroll-scope="chat"]')).toHaveAttribute('data-page-active', 'true');
  await expect(page.locator('[data-page-scroll-scope="drawing"]')).toHaveAttribute('data-page-active', 'false');

  for (const sample of samples) {
    expect(Number.isFinite(sample.durationMs)).toBe(true);
    expect(sample.domNodeCount).toBeGreaterThan(0);
    expect(sample.firstContentVisibleMs, `${sample.name} first content`).not.toBeNull();
    expect(sample.pageCommitMs, `${sample.name} source page commit`).not.toBeNull();
    expect(sample.reactCommitMs, `${sample.name} React render/commit`).not.toBeNull();
    expect(sample.reactCommitMs, `${sample.name} React render/commit`).toBeGreaterThanOrEqual(0);
    expect(sample.invokes, `${sample.name} invoke instrumentation`).not.toBeNull();
    expect(sample.imageReadiness?.allSettled, `${sample.name} visible images`).toBe(true);
    expect(sample.imageReadiness?.completeCount).toBe(sample.imageReadiness?.visibleCount);
    enforceInteractionBudget(sample, {
      durationMs: heavyPageSamples.includes(sample) ? 100 : 150,
    });
    if (process.env.PERF_ENFORCE === '1') {
      expect.soft(sample.reactCommitMs, `${sample.name} React render/commit budget`).toBeLessThanOrEqual(50);
    }
  }

  const warmCommands = samples.map((sample) => sample.invokes?.commands ?? {});
  for (const commands of warmCommands) {
    expect(commands.list_conversations ?? 0).toBe(0);
    expect(commands.list_providers ?? 0).toBe(0);
    expect(commands.list_message_versions_batch ?? 0).toBe(0);
    expect(commands.list_drawing_generations ?? 0).toBe(0);
  }
  if (process.env.PERF_ENFORCE === '1') {
    expect(pageSwitchP95.chatDrawingMs, 'warm Chat/Drawing P95').toBeLessThanOrEqual(100);
    expect(pageSwitchP95.cachedLightMs, 'all cached light modules P95').toBeLessThanOrEqual(150);
    for (const [pageKey, durationMs] of Object.entries(pageSwitchP95.cachedLightByPageMs)) {
      expect(durationMs, `${pageKey} cached transition P95`).toBeLessThanOrEqual(150);
    }
    expect(pageSwitchP95.reactCommitMs, 'React commit P95').toBeLessThanOrEqual(50);
  }

  await attachJson(testInfo, 'module-switch-metrics.json', {
    fixture: { conversations: 77, activeMessages: 24, renderedMessageWindow: 10 },
    enforcementEnabled: process.env.PERF_ENFORCE === '1',
    pageSwitchP95,
    samples,
    errors,
  });

  expect(errors.pageErrors).toEqual([]);
});
