import { expect, test, type Page } from '@playwright/test';
import { installBrowserFixture } from './browserFixture';
import {
  attachJson,
  collectBrowserErrors,
  installPerformanceObserver,
  measureConversationListGeometry,
  type ConversationListGeometry,
} from './perfMetrics';

interface NormalizedGeometry {
  groupTop: number;
  groupLeft: number;
  groupWidth: number;
  groupHeight: number;
  itemTop: number;
  itemLeft: number;
  itemWidth: number;
  itemHeight: number;
  labelTop: number;
  labelLeft: number;
  labelHeight: number;
}

interface ScreenshotDifference {
  width: number;
  height: number;
  differingPixels: number;
  differenceRatio: number;
}

async function compareScreenshots(
  page: Page,
  first: Buffer,
  second: Buffer,
): Promise<ScreenshotDifference> {
  return page.evaluate(async ({ firstBase64, secondBase64 }) => {
    const decode = (base64: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Unable to decode sidebar screenshot'));
      image.src = `data:image/png;base64,${base64}`;
    });
    const [firstImage, secondImage] = await Promise.all([
      decode(firstBase64),
      decode(secondBase64),
    ]);
    if (firstImage.width !== secondImage.width || firstImage.height !== secondImage.height) {
      throw new Error(
        `Sidebar screenshot dimensions differ: ${firstImage.width}x${firstImage.height} vs ${secondImage.width}x${secondImage.height}`,
      );
    }

    const canvas = document.createElement('canvas');
    canvas.width = firstImage.width;
    canvas.height = firstImage.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.drawImage(firstImage, 0, 0);
    const firstPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(secondImage, 0, 0);
    const secondPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let differingPixels = 0;
    for (let offset = 0; offset < firstPixels.length; offset += 4) {
      if (
        firstPixels[offset] !== secondPixels[offset]
        || firstPixels[offset + 1] !== secondPixels[offset + 1]
        || firstPixels[offset + 2] !== secondPixels[offset + 2]
        || firstPixels[offset + 3] !== secondPixels[offset + 3]
      ) {
        differingPixels += 1;
      }
    }
    const totalPixels = canvas.width * canvas.height;
    return {
      width: canvas.width,
      height: canvas.height,
      differingPixels,
      differenceRatio: totalPixels === 0 ? 0 : differingPixels / totalPixels,
    };
  }, {
    firstBase64: first.toString('base64'),
    secondBase64: second.toString('base64'),
  });
}

function normalize(geometry: ConversationListGeometry): NormalizedGeometry {
  return {
    groupTop: geometry.group.y - geometry.root.y,
    groupLeft: geometry.group.x - geometry.root.x,
    groupWidth: geometry.group.width,
    groupHeight: geometry.group.height,
    itemTop: geometry.item.y - geometry.root.y,
    itemLeft: geometry.item.x - geometry.root.x,
    itemWidth: geometry.item.width,
    itemHeight: geometry.item.height,
    labelTop: geometry.label.y - geometry.item.y,
    labelLeft: geometry.label.x - geometry.item.x,
    labelHeight: geometry.label.height,
  };
}

async function assertUiClassContract(page: Page) {
  const list = page.locator('[data-list-mode]');
  await expect(list).toHaveClass(/ant-conversations/);
  await expect(list.locator('.ant-conversations-group-title').first()).toBeVisible();
  await expect(list.locator('[data-conv-id]').first()).toHaveClass(/ant-conversations-item/);
  await expect(list.locator('[data-conv-id] .ant-conversations-label').first()).toBeVisible();
}

test('159 native rows and 160 virtual rows preserve first-screen geometry', async ({ page }, testInfo) => {
  const nativeErrors = collectBrowserErrors(page);
  await installPerformanceObserver(page);
  const nativeFixture = await installBrowserFixture(page, { conversationCount: 158 });
  expect(nativeFixture.expandedRowCount).toBe(159);
  await page.goto('/');
  await expect(page.locator('[data-list-mode="native"]')).toBeVisible();
  await assertUiClassContract(page);
  const nativeGeometry = await measureConversationListGeometry(page);
  const nativeScreenshot = await page.getByTestId('chat-sidebar-content').screenshot();

  const virtualPage = await page.context().newPage();
  const virtualErrors = collectBrowserErrors(virtualPage);
  await installPerformanceObserver(virtualPage);
  const virtualFixture = await installBrowserFixture(virtualPage, { conversationCount: 159 });
  expect(virtualFixture.expandedRowCount).toBe(160);
  await virtualPage.goto('/');
  await expect(virtualPage.locator('[data-list-mode="virtual"]')).toBeVisible();
  await assertUiClassContract(virtualPage);
  const virtualGeometry = await measureConversationListGeometry(virtualPage);
  const virtualScreenshot = await virtualPage.getByTestId('chat-sidebar-content').screenshot();
  const screenshotDifference = await compareScreenshots(
    virtualPage,
    nativeScreenshot,
    virtualScreenshot,
  );

  const native = normalize(nativeGeometry);
  const virtual = normalize(virtualGeometry);
  const geometryDiffs = Object.fromEntries(
    (Object.keys(native) as Array<keyof NormalizedGeometry>).map((key) => [
      key,
      Math.abs(native[key] - virtual[key]),
    ]),
  ) as Record<keyof NormalizedGeometry, number>;

  for (const [name, difference] of Object.entries(geometryDiffs)) {
    expect.soft(difference, `${name} native/virtual geometry difference`).toBeLessThanOrEqual(1);
  }
  expect(nativeGeometry.mode).toBe('native');
  expect(virtualGeometry.mode).toBe('virtual');
  expect(nativeGeometry.groupClasses).toContain('ant-conversations-group-title');
  expect(virtualGeometry.groupClasses).toContain('ant-conversations-group-title');
  expect(nativeGeometry.itemClasses).toContain('ant-conversations-item');
  expect(virtualGeometry.itemClasses).toContain('ant-conversations-item');
  expect(
    screenshotDifference.differenceRatio,
    'native/virtual sidebar pixel difference',
  ).toBeLessThanOrEqual(0.005);

  await testInfo.attach('sidebar-159-native.png', {
    body: nativeScreenshot,
    contentType: 'image/png',
  });
  await testInfo.attach('sidebar-160-virtual.png', {
    body: virtualScreenshot,
    contentType: 'image/png',
  });
  await attachJson(testInfo, 'sidebar-boundary-geometry.json', {
    nativeExpandedRows: nativeFixture.expandedRowCount,
    virtualExpandedRows: virtualFixture.expandedRowCount,
    native: nativeGeometry,
    virtual: virtualGeometry,
    geometryDiffs,
    screenshotDifference,
    errors: { native: nativeErrors, virtual: virtualErrors },
  });

  expect(nativeErrors.pageErrors).toEqual([]);
  expect(virtualErrors.pageErrors).toEqual([]);
  await virtualPage.close();
});
