import { expect, test, type Locator } from '@playwright/test';
import { installBrowserFixture } from './browserFixture';
import {
  attachJson,
  collectBrowserErrors,
  installPerformanceObserver,
  navigateWithoutMeasurement,
} from './perfMetrics';

async function placeAtMiddle(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    if (scrollTop <= 0) {
      throw new Error(
        `Expected an overflowing scroll container, got ${element.scrollHeight}/${element.clientHeight}`,
      );
    }
    element.scrollTop = scrollTop;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    return element.scrollTop;
  });
}

test('Activity preserves Chat and Drawing scroll offsets within one pixel', async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await installPerformanceObserver(page);
  await installBrowserFixture(page, {
    conversationCount: 77,
    messagesInActiveConversation: 40,
    drawingGenerationCount: 20,
  });

  await page.goto('/');
  const chatScroller = page.locator('.ant-bubble-list-scroll-box');
  await expect(chatScroller).toBeVisible();
  const chatBefore = await placeAtMiddle(chatScroller);

  await navigateWithoutMeasurement(page, 'drawing');
  const drawingScroller = page.getByTestId('drawing-history-scroll');
  await expect(drawingScroller).toBeVisible();
  const drawingBefore = await placeAtMiddle(drawingScroller);

  await navigateWithoutMeasurement(page, 'chat');
  const chatAfter = await chatScroller.evaluate((element) => element.scrollTop);
  expect(Math.abs(chatAfter - chatBefore), 'Chat restored scroll offset').toBeLessThanOrEqual(1);

  await navigateWithoutMeasurement(page, 'drawing');
  const drawingAfter = await drawingScroller.evaluate((element) => element.scrollTop);
  expect(Math.abs(drawingAfter - drawingBefore), 'Drawing restored scroll offset').toBeLessThanOrEqual(1);

  await attachJson(testInfo, 'activity-scroll-restoration.json', {
    chat: { before: chatBefore, after: chatAfter, error: chatAfter - chatBefore },
    drawing: { before: drawingBefore, after: drawingAfter, error: drawingAfter - drawingBefore },
    errors,
  });
  expect(errors.pageErrors).toEqual([]);
});
