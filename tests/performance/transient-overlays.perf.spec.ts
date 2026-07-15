import { expect, test } from '@playwright/test';
import { installBrowserFixture } from './browserFixture';
import { navigateWithoutMeasurement } from './perfMetrics';

test('Activity closes Chat and Drawing image previews instead of restoring stale masks', async ({ page }) => {
  await installBrowserFixture(page, {
    conversationCount: 77,
    messagesInActiveConversation: 10,
    chatAttachment: true,
    drawingGenerationCount: 1,
    drawingImagesPerGeneration: 1,
  });

  await page.goto('/');
  const visiblePreview = page.locator('.ant-image-preview[role="dialog"]:visible');
  const chatAttachment = page.locator('img[alt="fixture.png"]');
  await expect(chatAttachment).toBeVisible();
  await chatAttachment.click();
  await expect(visiblePreview).toHaveCount(1);

  await navigateWithoutMeasurement(page, 'drawing', { bypassBlockingOverlay: true });
  await expect(visiblePreview).toHaveCount(0);
  await navigateWithoutMeasurement(page, 'chat');
  await expect(visiblePreview).toHaveCount(0);

  await navigateWithoutMeasurement(page, 'drawing');
  const drawingImage = page.locator('.drawing-preview-tile img').first();
  await expect(drawingImage).toBeVisible();
  await drawingImage.click();
  await expect(visiblePreview).toHaveCount(1);

  await navigateWithoutMeasurement(page, 'chat', { bypassBlockingOverlay: true });
  await expect(visiblePreview).toHaveCount(0);
  await navigateWithoutMeasurement(page, 'drawing');
  await expect(visiblePreview).toHaveCount(0);
});
