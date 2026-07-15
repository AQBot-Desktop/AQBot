import { expect, test } from '@playwright/test';
import { installBrowserFixture } from './browserFixture';
import {
  attachJson,
  collectBrowserErrors,
  installPerformanceObserver,
  measureClick,
} from './perfMetrics';

const SAMPLE_COUNT = 20;
const MESSAGE_COUNT = 12;

function padded(index: number): string {
  return String(index).padStart(4, '0');
}

test('ordinary conversation first content P95 stays within budget', async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await installPerformanceObserver(page);
  await installBrowserFixture(page, {
    conversationCount: 77,
    messagesInActiveConversation: MESSAGE_COUNT,
    messagesInConversationCount: SAMPLE_COUNT + 1,
  });

  await page.goto('/');
  await expect(page.locator('[data-list-mode="native"]')).toBeVisible();
  await expect(page.locator('[data-aqbot-msg]')).toHaveCount(10);

  const samples = [];
  for (let index = 1; index <= SAMPLE_COUNT; index += 1) {
    const conversationKey = padded(index);
    const conversationId = `perf-conversation-${conversationKey}`;
    const lastMessageId = `perf-message-${conversationKey}-${padded(MESSAGE_COUNT - 1)}`;
    const row = page.locator(`[data-conv-id="${conversationId}"]`);
    const contentSelector = `[data-message-area] [data-aqbot-msg="${lastMessageId}"]`;

    const sample = await measureClick(row, `conversation-first-content-${index}`, {
      contentSelector,
    });
    await expect(page.locator(contentSelector)).toHaveCount(1);
    await expect(row).toHaveClass(/ant-conversations-item-active/);
    expect(sample.firstContentVisibleMs, sample.name).not.toBeNull();
    expect(sample.invokes?.commands.list_messages_page, sample.name).toBe(1);
    samples.push(sample);
  }

  const ordered = samples
    .map((sample) => sample.firstContentVisibleMs ?? Infinity)
    .sort((left, right) => left - right);
  const firstContentP95Ms = ordered[Math.ceil(ordered.length * 0.95) - 1];

  if (process.env.PERF_ENFORCE === '1') {
    expect(firstContentP95Ms, 'ordinary conversation first content P95').toBeLessThanOrEqual(100);
  }

  await attachJson(testInfo, 'conversation-first-content-metrics.json', {
    fixture: {
      conversations: 77,
      sampledConversations: SAMPLE_COUNT,
      messagesPerConversation: MESSAGE_COUNT,
    },
    enforcementEnabled: process.env.PERF_ENFORCE === '1',
    firstContentP95Ms,
    samples,
    errors,
  });

  expect(errors.pageErrors).toEqual([]);
});
