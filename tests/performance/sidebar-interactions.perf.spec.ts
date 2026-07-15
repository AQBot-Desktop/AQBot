import { expect, test } from '@playwright/test';
import { installBrowserFixture } from './browserFixture';
import { collectBrowserErrors, installPerformanceObserver } from './perfMetrics';

const firstVirtualRow = (page: import('@playwright/test').Page) => (
  page.locator('[data-list-mode="virtual"] [data-conv-id]').first()
);

test('large ChatSidebar preserves search, context menu, archive and multi-select behavior', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await installPerformanceObserver(page);
  await installBrowserFixture(page, {
    conversationCount: 500,
    childConversationIndex: 499,
  });

  await page.goto('/');
  await expect(page.locator('[data-list-mode="virtual"]')).toBeVisible();

  const searchButton = page.locator('button[aria-label]').filter({ has: page.locator('.lucide-search') });
  await searchButton.click();
  const searchInput = page.locator('.chat-sidebar-search input');
  await searchInput.fill('Performance conversation');
  await expect(page.locator('[data-list-mode="virtual"]')).toBeVisible();

  await searchInput.fill('Performance conversation 0499');
  await expect(page.locator('[data-conv-id="perf-conversation-0000"]')).toBeVisible();
  await expect(page.locator('[data-conv-id="perf-conversation-0499"]')).toBeVisible();
  await searchInput.fill('');
  await expect(page.locator('[data-list-mode="virtual"]')).toBeVisible();

  const contextRow = firstVirtualRow(page);
  const contextRowId = await contextRow.getAttribute('data-conv-id');
  await contextRow.click({ button: 'right' });
  await expect(page.locator('.ant-dropdown-menu:visible')).toBeVisible();
  await page.keyboard.press('Escape');

  const archiveRow = firstVirtualRow(page);
  const archiveRowId = await archiveRow.getAttribute('data-conv-id');
  expect(archiveRowId).toBeTruthy();
  await archiveRow.hover();
  await archiveRow.locator('.ant-conversations-menu-icon').click();
  await page.getByText('归档', { exact: true }).last().click();
  await expect(page.locator(`[data-conv-id="${archiveRowId}"]`)).toHaveCount(0);
  await expect.poll(() => page.evaluate((id) => {
    const stored = JSON.parse(localStorage.getItem('aqbot_conversations') ?? '[]');
    return stored.find((item: { id: string }) => item.id === id)?.is_archived ?? false;
  }, archiveRowId)).toBe(true);

  await page.getByRole('button', { name: '多选' }).click();
  const selectedRows = page.locator('[data-list-mode="virtual"] [data-conv-id]');
  const firstSelectedId = await selectedRows.nth(0).getAttribute('data-conv-id');
  const secondSelectedId = await selectedRows.nth(1).getAttribute('data-conv-id');
  await selectedRows.nth(0).click();
  await selectedRows.nth(1).click();
  await expect(page.getByText(/2\s*已选/)).toBeVisible();
  await page.getByRole('button', { name: '归档' }).click();
  await expect(page.locator(`[data-conv-id="${firstSelectedId}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-conv-id="${secondSelectedId}"]`)).toHaveCount(0);
  await expect(page.locator('[data-list-mode="virtual"]')).toBeVisible();

  const directDeleteRow = firstVirtualRow(page);
  const directDeleteId = await directDeleteRow.getAttribute('data-conv-id');
  await page.keyboard.down('Control');
  await directDeleteRow.hover();
  const directDeleteButton = directDeleteRow.locator('.aqbot-chat-conversation-menu-delete');
  await expect(directDeleteButton).toBeVisible();
  await directDeleteButton.dispatchEvent('click', { ctrlKey: true });
  await page.keyboard.up('Control');
  await expect(page.locator('.ant-modal-confirm:visible')).toHaveCount(0);
  await expect(page.locator(`[data-conv-id="${directDeleteId}"]`)).toHaveCount(0);

  expect(contextRowId).toBeTruthy();
  expect(errors.pageErrors).toEqual([]);
});

test('application direction reaches the real virtual conversation list', async ({ page }) => {
  await installBrowserFixture(page, {
    conversationCount: 500,
    settingsLanguage: 'ar',
  });

  await page.goto('/');
  const list = page.locator('[data-list-mode="virtual"]');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(list).toHaveClass(/ant-conversations-rtl/);

  const row = firstVirtualRow(page);
  await row.hover();
  await row.locator('.ant-conversations-menu-icon').click();
  await expect(page.locator('.ant-dropdown-placement-bottomLeft:visible')).toBeVisible();
});

test('virtual category rows collapse and reorder through the real DnD/store path', async ({ page }) => {
  await installBrowserFixture(page, {
    conversationCount: 500,
    categoryCount: 3,
  });

  await page.goto('/');
  await expect(page.locator('[data-list-mode="virtual"]')).toBeVisible();
  const firstTitle = page.getByText('Performance category 0', { exact: true });
  const secondTitle = page.getByText('Performance category 1', { exact: true });
  const categorizedConversation = page.locator('[data-conv-id="perf-conversation-0000"]');
  await expect(categorizedConversation).toBeVisible();

  await firstTitle.locator('xpath=ancestor::*[contains(@class,"ant-conversations-group-title")]')
    .locator('.ant-conversations-group-collapse-trigger')
    .click();
  await expect(categorizedConversation).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const categories = JSON.parse(localStorage.getItem('aqbot_conversation_categories') ?? '[]');
    return categories.find((item: { id: string }) => item.id === 'perf-category-0')?.is_collapsed;
  })).toBe(true);

  const source = firstTitle.locator('xpath=ancestor::div[contains(@class,"flex items-center")]');
  const sourceGrip = source.locator('.lucide-grip-vertical');
  const sourceBox = await sourceGrip.boundingBox();
  const targetBox = await secondTitle.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Category drag handles must be visible');
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => page.evaluate(() => {
    const categories = JSON.parse(localStorage.getItem('aqbot_conversation_categories') ?? '[]');
    return categories.map((item: { id: string }) => item.id).slice(0, 2);
  })).toEqual(['perf-category-1', 'perf-category-0']);
});
