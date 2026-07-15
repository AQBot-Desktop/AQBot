import { expect, test } from '@playwright/test';
import { installBrowserFixture } from './browserFixture';
import {
  attachJson,
  collectBrowserErrors,
  collectHeapAfterGc,
  installPerformanceObserver,
  navigateWithoutMeasurement,
  readResourceSnapshot,
  settleBrowser,
} from './perfMetrics';

const WARMUP_CYCLES = 5;
const MEASURED_CYCLES = 100;

test('100 warm Chat and Drawing cycles do not retain page resources', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors = collectBrowserErrors(page);
  await installPerformanceObserver(page, { trackResources: true });
  await installBrowserFixture(page, {
    conversationCount: 77,
    messagesInActiveConversation: 10,
  });

  await page.goto('/');
  await expect(page.locator('[data-list-mode="native"]')).toBeVisible();

  for (let cycle = 0; cycle < WARMUP_CYCLES; cycle += 1) {
    await navigateWithoutMeasurement(page, 'drawing');
    await navigateWithoutMeasurement(page, 'chat');
  }
  await settleBrowser(page, 250);

  const baselineResources = await readResourceSnapshot(page);
  const baselineHeap = await collectHeapAfterGc(page);
  expect(baselineResources).not.toBeNull();

  const checkpoints = [];
  for (let cycle = 1; cycle <= MEASURED_CYCLES; cycle += 1) {
    await navigateWithoutMeasurement(page, 'drawing');
    await navigateWithoutMeasurement(page, 'chat');
    if (cycle % 10 === 0) {
      await settleBrowser(page, 20);
      checkpoints.push({ cycle, resources: await readResourceSnapshot(page) });
    }
  }
  await settleBrowser(page, 250);

  const finalResources = await readResourceSnapshot(page);
  const finalHeap = await collectHeapAfterGc(page);
  expect(finalResources).not.toBeNull();
  expect(await page.locator('[data-page-scroll-scope="chat"]').getAttribute('data-page-active')).toBe('true');
  expect(await page.locator('[data-page-scroll-scope="drawing"]').getAttribute('data-page-active')).toBe('false');

  const resourceGrowth = baselineResources && finalResources
    ? {
        liveEventListeners: finalResources.liveEventListeners - baselineResources.liveEventListeners,
        activeIntervals: finalResources.activeIntervals - baselineResources.activeIntervals,
        domNodeCount: finalResources.domNodeCount - baselineResources.domNodeCount,
      }
    : null;
  const heapGrowthRatio = baselineHeap && finalHeap && baselineHeap.usedSize > 0
    ? (finalHeap.usedSize - baselineHeap.usedSize) / baselineHeap.usedSize
    : null;

  expect(resourceGrowth?.liveEventListeners).toBeLessThanOrEqual(0);
  expect(resourceGrowth?.activeIntervals).toBeLessThanOrEqual(0);
  // OverlayScrollbars may leave a small constant number of measurement nodes,
  // but a cycle-proportional increase is never allowed.
  expect(resourceGrowth?.domNodeCount).toBeLessThanOrEqual(5);

  if (process.env.PERF_ENFORCE === '1' && heapGrowthRatio !== null) {
    expect(heapGrowthRatio, 'GC-retained JS heap growth after 100 warm cycles').toBeLessThan(0.10);
  }

  await attachJson(testInfo, 'resource-leak-metrics.json', {
    fixture: { conversations: 77, warmupCycles: WARMUP_CYCLES, measuredCycles: MEASURED_CYCLES },
    enforcementEnabled: process.env.PERF_ENFORCE === '1',
    baselineResources,
    finalResources,
    resourceGrowth,
    baselineHeap,
    finalHeap,
    heapGrowthRatio,
    checkpoints,
    errors,
  });

  expect(errors.pageErrors).toEqual([]);
});
