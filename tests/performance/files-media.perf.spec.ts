import { expect, test } from '@playwright/test';
import { installBrowserFixture } from './browserFixture';
import { installPerformanceObserver } from './perfMetrics';

async function previewInvokeCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const state = (window as Window & {
      __AQBOT_PERF__?: { invokes?: Array<{ command: string }> };
    }).__AQBOT_PERF__;
    return state?.invokes?.filter(({ command }) => command === 'read_attachment_preview').length ?? 0;
  });
}

async function navigateToFiles(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('nav button').nth(7).click();
  await expect(page.getByTestId('files-content')).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test('warm Files roundtrip reuses stored-media sources without preview IPC', async ({ page }) => {
  await installPerformanceObserver(page);
  await installBrowserFixture(page, {
    conversationCount: 77,
    drawingGenerationCount: 3,
    drawingImagesPerGeneration: 1,
  });

  await page.goto('/');
  await navigateToFiles(page);
  await expect.poll(() => previewInvokeCount(page)).toBe(3);
  const coldPreviewInvokes = await previewInvokeCount(page);

  await page.locator('nav button').nth(0).click();
  await expect(page.locator('[data-page-scroll-scope="chat"][data-page-active="true"]')).toBeVisible();
  await navigateToFiles(page);

  expect(await previewInvokeCount(page) - coldPreviewInvokes).toBe(0);
});
