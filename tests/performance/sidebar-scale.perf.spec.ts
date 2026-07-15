import { expect, test } from '@playwright/test';
import { CONVERSATION_SCALES, installBrowserFixture } from './browserFixture';
import {
  attachJson,
  collectBrowserErrors,
  enforceInteractionBudget,
  installPerformanceObserver,
  measureClick,
  measureMiddleScroll,
} from './perfMetrics';

async function readVirtualWindow(list: import('@playwright/test').Locator) {
  return list.evaluate((root) => {
    let scroller = root.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
      scroller = scroller.parentElement;
    }
    if (!scroller) throw new Error('Unable to find virtual conversation scroller');
    return {
      ids: Array.from(root.querySelectorAll<HTMLElement>('[data-conv-id]'))
        .map((item) => item.dataset.convId ?? ''),
      clientHeight: scroller.clientHeight,
      scrollTop: scroller.scrollTop,
    };
  });
}

for (const conversationCount of CONVERSATION_SCALES) {
  test(`sidebar fixture with ${conversationCount} conversations records branch and interaction cost`, async ({ page }, testInfo) => {
    const errors = collectBrowserErrors(page);
    await installPerformanceObserver(page);
    const fixture = await installBrowserFixture(page, { conversationCount });

    await page.goto('/');
    const expectedMode = fixture.expandedRowCount <= 159 ? 'native' : 'virtual';
    const list = page.locator(`[data-list-mode="${expectedMode}"]`);
    await expect(list).toBeVisible();
    await expect.poll(() => list.locator('[data-conv-id]').count()).toBeGreaterThanOrEqual(2);

    const initialReadyMs = await page.evaluate(() => performance.now());
    const mountedConversationRows = await list.locator('[data-conv-id]').count();
    const initialDomNodeCount = await page.locator('*').count();

    if (expectedMode === 'native') {
      expect(mountedConversationRows).toBe(conversationCount);
    } else {
      expect(mountedConversationRows).toBeLessThan(conversationCount);
    }

    const firstRow = list.locator('[data-conv-id]').first();
    await firstRow.hover();
    await firstRow.locator('.ant-conversations-menu-icon').click();
    await expect(page.locator('.ant-dropdown-menu:visible')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.ant-dropdown-menu:visible')).toHaveCount(0);

    const target = list.locator('[data-conv-id]').nth(1);
    const targetId = await target.getAttribute('data-conv-id');
    expect(targetId).toBeTruthy();
    const activeSwitch = await measureClick(target, `sidebar-active-${conversationCount}`);
    await expect(list.locator(`[data-conv-id="${targetId}"]`)).toHaveClass(/ant-conversations-item-active/);
    const activeSamples = [activeSwitch];
    for (let sampleIndex = 1; sampleIndex < 20; sampleIndex += 1) {
      activeSamples.push(await measureClick(
        list.locator('[data-conv-id]').nth(sampleIndex % 2),
        `sidebar-active-${conversationCount}-${sampleIndex + 1}`,
      ));
    }
    const activeDurations = activeSamples
      .map((sample) => sample.durationMs)
      .sort((left, right) => left - right);
    const activeP95Ms = activeDurations[Math.ceil(activeDurations.length * 0.95) - 1];

    const virtualWindowBefore = expectedMode === 'virtual'
      ? await readVirtualWindow(list)
      : null;
    const scroll = expectedMode === 'virtual'
      ? await measureMiddleScroll(list, `sidebar-scroll-${conversationCount}`)
      : null;
    const virtualWindowAfter = expectedMode === 'virtual'
      ? await readVirtualWindow(list)
      : null;

    for (const sample of activeSamples) {
      enforceInteractionBudget(sample, { durationMs: 50, maxLongTaskMs: 50 });
    }
    if (process.env.PERF_ENFORCE === '1') {
      expect(activeP95Ms, `sidebar ${conversationCount} active highlight P95`).toBeLessThan(50);
    }
    if (scroll && virtualWindowBefore && virtualWindowAfter) {
      enforceInteractionBudget(scroll, { maxLongTaskMs: 50 });
      expect(virtualWindowAfter.scrollTop).toBeGreaterThan(0);
      expect(virtualWindowAfter.ids[0]).not.toBe(virtualWindowBefore.ids[0]);
      const mountedRowBudget = Math.ceil(virtualWindowAfter.clientHeight / 40) + 2 * 8 + 6;
      expect(virtualWindowAfter.ids.length).toBeLessThanOrEqual(mountedRowBudget);
    }

    const result = {
      fixture: {
        conversationCount,
        expandedRowCount: fixture.expandedRowCount,
        expectedMode,
      },
      enforcementEnabled: process.env.PERF_ENFORCE === '1',
      initialReadyMs,
      initialDomNodeCount,
      mountedConversationRows,
      activeSwitch,
      activeP95Ms,
      activeSamples,
      scroll,
      virtualWindowBefore,
      virtualWindowAfter,
      errors,
    };
    await attachJson(testInfo, `sidebar-${conversationCount}-metrics.json`, result);

    expect(errors.pageErrors).toEqual([]);
  });
}
