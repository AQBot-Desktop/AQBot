import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

export type PageKey =
  | 'chat'
  | 'drawing'
  | 'roles'
  | 'skills'
  | 'knowledge'
  | 'memory'
  | 'gateway'
  | 'files'
  | 'settings';

export interface ImageReadinessMetric {
  visibleCount: number;
  completeCount: number;
  decodedCount: number;
  failedCount: number;
  timedOutCount: number;
  allSettled: boolean;
  settledMs: number;
}

export interface InvokeMetric {
  callCount: number;
  requestBytes: number;
  responseBytes: number;
  failedCount: number;
  commands: Record<string, number>;
}

export interface InteractionMetric {
  name: string;
  durationMs: number;
  observationDurationMs: number;
  firstContentVisibleMs: number | null;
  imageReadiness: ImageReadinessMetric | null;
  pageCommitMs: number | null;
  reactCommitMs: number | null;
  invokes: InvokeMetric | null;
  domNodeCount: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  maxLongTaskMs: number;
  longTasks: InteractionLongTask[];
}

export interface InteractionLongTask {
  startOffsetMs: number;
  endOffsetMs: number;
  durationMs: number;
  startedBeforeInteractionEnd: boolean;
  overlappedPageCommit: boolean;
  attribution: BrowserLongTaskAttribution[];
}

export interface ResourceSnapshot {
  liveEventListeners: number;
  activeIntervals: number;
  totalEventListenersAdded: number;
  totalEventListenersRemoved: number;
  totalIntervalsCreated: number;
  totalIntervalsCleared: number;
  domNodeCount: number;
}

export interface HeapSnapshot {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize: number | null;
}

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConversationListGeometry {
  mode: string | null;
  rootClasses: string[];
  groupClasses: string[];
  itemClasses: string[];
  labelClasses: string[];
  root: ElementBox;
  group: ElementBox;
  item: ElementBox;
  label: ElementBox;
}

interface BrowserLongTaskAttribution {
  name: string;
  containerType: string;
  containerName: string;
  containerId: string;
  containerSrc: string;
}

interface BrowserLongTask {
  startTime: number;
  duration: number;
  attribution: BrowserLongTaskAttribution[];
}

interface BrowserInvokeEntry {
  command: string;
  startedAt: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  ok: boolean;
}

interface BrowserPageCommitEntry {
  page: string;
  at: number;
  renderDurationMs: number;
}

interface BrowserListenerRegistration {
  target: EventTarget;
  type: string;
  original: EventListenerOrEventListenerObject;
  actual: EventListenerOrEventListenerObject;
  capture: boolean;
}

interface BrowserResourceState {
  liveListeners: Map<string, BrowserListenerRegistration>;
  activeIntervals: Set<number>;
  totalListenersAdded: number;
  totalListenersRemoved: number;
  totalIntervalsCreated: number;
  totalIntervalsCleared: number;
}

interface BrowserPerfState {
  longTasks: BrowserLongTask[];
  invokes: BrowserInvokeEntry[];
  pageCommits: BrowserPageCommitEntry[];
  resources: BrowserResourceState;
}

type SidebarPageKey = Exclude<PageKey, 'settings'>;

const NAV_INDEX: Record<SidebarPageKey, number> = {
  chat: 0,
  drawing: 1,
  roles: 2,
  skills: 3,
  knowledge: 4,
  memory: 5,
  gateway: 6,
  files: 7,
};

const PAGE_READY_SELECTOR: Record<PageKey, string> = {
  chat: '[data-page-scroll-scope="chat"][data-page-active="true"]',
  drawing: '[data-page-scroll-scope="drawing"][data-page-active="true"]',
  roles: '[data-page-scroll-scope="roles"][data-page-active="true"]',
  skills: '[data-page-scroll-scope="skills"][data-page-active="true"]',
  knowledge: '[data-page-scroll-scope="knowledge"][data-page-active="true"]',
  memory: '[data-page-scroll-scope="memory"][data-page-active="true"]',
  gateway: '[data-page-scroll-scope="gateway"][data-page-active="true"]',
  files: '[data-page-scroll-scope="files"][data-page-active="true"]',
  settings: '[data-page-scroll-scope="settings"][data-page-active="true"]',
};

const PAGE_CONTENT_SELECTOR: Record<PageKey, string> = {
  chat: '[data-page-scroll-scope="chat"][data-page-active="true"] [data-message-area]',
  drawing: '[data-page-scroll-scope="drawing"][data-page-active="true"] [data-testid="drawing-history-frame"]',
  roles: PAGE_READY_SELECTOR.roles,
  skills: PAGE_READY_SELECTOR.skills,
  knowledge: PAGE_READY_SELECTOR.knowledge,
  memory: PAGE_READY_SELECTOR.memory,
  gateway: PAGE_READY_SELECTOR.gateway,
  files: PAGE_READY_SELECTOR.files,
  settings: PAGE_READY_SELECTOR.settings,
};

function sidebarNavigationButton(page: Page, pageKey: SidebarPageKey): Locator {
  return page.locator('nav button').nth(NAV_INDEX[pageKey]);
}

function navigationButton(page: Page, from: PageKey | null, to: PageKey): Locator {
  if (to === 'settings' || from === 'settings') {
    return page.getByTestId('settings-toggle');
  }
  return sidebarNavigationButton(page, to);
}

export function collectBrowserErrors(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  return { pageErrors, consoleErrors };
}

export async function installPerformanceObserver(
  page: Page,
  options: { trackResources?: boolean } = {},
): Promise<void> {
  await page.addInitScript(({ trackResources }) => {
    const perfWindow = window as Window & { __AQBOT_PERF__?: Partial<BrowserPerfState> };
    const existing = perfWindow.__AQBOT_PERF__ ?? {};
    const resources: BrowserResourceState = {
      liveListeners: new Map(),
      activeIntervals: new Set(),
      totalListenersAdded: 0,
      totalListenersRemoved: 0,
      totalIntervalsCreated: 0,
      totalIntervalsCleared: 0,
    };
    const state: BrowserPerfState = {
      longTasks: existing.longTasks ?? [],
      invokes: existing.invokes ?? [],
      pageCommits: existing.pageCommits ?? [],
      resources,
    };
    perfWindow.__AQBOT_PERF__ = state;

    if (trackResources) {
      const targetIds = new WeakMap<object, number>();
      const listenerIds = new WeakMap<object, number>();
      let nextTargetId = 1;
      let nextListenerId = 1;
      const objectId = (ids: WeakMap<object, number>, value: object, next: () => number) => {
        const current = ids.get(value);
        if (current !== undefined) return current;
        const id = next();
        ids.set(value, id);
        return id;
      };
      const captureOf = (eventOptions?: boolean | AddEventListenerOptions | EventListenerOptions) => (
        typeof eventOptions === 'boolean' ? eventOptions : Boolean(eventOptions?.capture)
      );
      const originalAddEventListener = EventTarget.prototype.addEventListener;
      const originalRemoveEventListener = EventTarget.prototype.removeEventListener;

      EventTarget.prototype.addEventListener = function addTrackedEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (!listener) return originalAddEventListener.call(this, type, listener, options);
        const capture = captureOf(options);
        const targetId = objectId(targetIds, this, () => nextTargetId++);
        const listenerId = objectId(listenerIds, listener as object, () => nextListenerId++);
        const key = `${targetId}:${type}:${listenerId}:${capture ? 1 : 0}`;
        if (resources.liveListeners.has(key)) return;

        const once = typeof options === 'object' && Boolean(options.once);
        let actual: EventListenerOrEventListenerObject = listener;
        if (once) {
          actual = function trackedOnceListener(this: EventTarget, event: Event) {
            if (resources.liveListeners.delete(key)) resources.totalListenersRemoved += 1;
            if (typeof listener === 'function') listener.call(this, event);
            else listener.handleEvent(event);
          };
        }
        resources.liveListeners.set(key, { target: this, type, original: listener, actual, capture });
        resources.totalListenersAdded += 1;

        const signal = typeof options === 'object' ? options.signal : undefined;
        if (signal) {
          originalAddEventListener.call(signal, 'abort', () => {
            if (resources.liveListeners.delete(key)) resources.totalListenersRemoved += 1;
          }, { once: true });
        }
        return originalAddEventListener.call(this, type, actual, options);
      };

      EventTarget.prototype.removeEventListener = function removeTrackedEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) {
        if (!listener) return originalRemoveEventListener.call(this, type, listener, options);
        const capture = captureOf(options);
        const targetId = targetIds.get(this);
        const listenerId = listenerIds.get(listener as object);
        const key = targetId === undefined || listenerId === undefined
          ? null
          : `${targetId}:${type}:${listenerId}:${capture ? 1 : 0}`;
        const registration = key ? resources.liveListeners.get(key) : undefined;
        if (registration && key) {
          resources.liveListeners.delete(key);
          resources.totalListenersRemoved += 1;
          return originalRemoveEventListener.call(this, type, registration.actual, options);
        }
        return originalRemoveEventListener.call(this, type, listener, options);
      };

      const originalSetInterval = window.setInterval.bind(window) as (
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => number;
      const originalClearInterval = window.clearInterval.bind(window) as (id?: number) => void;
      const trackedSetInterval = function trackedSetInterval(
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ): number {
        const id = originalSetInterval(handler, timeout, ...args);
        resources.activeIntervals.add(id);
        resources.totalIntervalsCreated += 1;
        return id;
      };
      const trackedClearInterval = function trackedClearInterval(id?: number): void {
        if (id !== undefined && resources.activeIntervals.delete(id)) {
          resources.totalIntervalsCleared += 1;
        }
        originalClearInterval(id);
      };
      Object.defineProperty(window, 'setInterval', {
        configurable: true,
        writable: true,
        value: trackedSetInterval,
      });
      Object.defineProperty(window, 'clearInterval', {
        configurable: true,
        writable: true,
        value: trackedClearInterval,
      });
    }

    if (typeof PerformanceObserver === 'undefined') return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const attribution = (entry as PerformanceEntry & {
            attribution?: Array<{
              name?: string;
              containerType?: string;
              containerName?: string;
              containerId?: string;
              containerSrc?: string;
            }>;
          }).attribution ?? [];
          state.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
            attribution: attribution.map((item) => ({
              name: item.name ?? '',
              containerType: item.containerType ?? '',
              containerName: item.containerName ?? '',
              containerId: item.containerId ?? '',
              containerSrc: item.containerSrc ?? '',
            })),
          });
        }
        if (state.longTasks.length > 2_000) state.longTasks.splice(0, 1_000);
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      // Long Task API is optional. Timing and DOM metrics remain available.
    }
  }, { trackResources: options.trackResources ?? false });
}

async function measureElementAction(
  locator: Locator,
  name: string,
  action: 'click' | 'scroll-middle',
  navigation?: { targetPage?: PageKey; contentSelector: string },
): Promise<InteractionMetric> {
  return locator.evaluate(async (element, args) => {
    const perfState = (window as Window & { __AQBOT_PERF__?: BrowserPerfState }).__AQBOT_PERF__;
    const start = performance.now();
    const invokeStartIndex = Array.isArray(perfState?.invokes) ? perfState.invokes.length : null;
    const pageCommitStartIndex = Array.isArray(perfState?.pageCommits)
      ? perfState.pageCommits.length
      : null;

    const firstContentPromise = args.contentSelector
      ? (async () => {
          const deadline = start + 5_000;
          while (performance.now() < deadline) {
            // Every navigation selector is already scoped to the active page.
            // Avoid geometry/style reads here: doing them in the same frame as
            // an Activity reconnect forces layout for the full retained tree
            // and contaminates the Long Task measurement.
            if (document.querySelector(args.contentSelector)) {
              return performance.now() - start;
            }
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
          return null;
        })()
      : Promise.resolve<number | null>(null);

    if (args.action === 'click') {
      (element as HTMLElement).click();
    } else {
      let scroller = element.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
        scroller = scroller.parentElement;
      }
      if (!scroller) throw new Error('Unable to find the conversation list scroll container');
      scroller.scrollTop = Math.max(1, (scroller.scrollHeight - scroller.clientHeight) / 2);
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    let firstContentVisibleMs: number | null;
    let interactionEnd: number;
    if (args.targetPage && pageCommitStartIndex !== null) {
      const commitDeadline = start + 5_000;
      while (performance.now() < commitDeadline) {
        const targetCommitted = perfState?.pageCommits
          .slice(pageCommitStartIndex)
          .some((entry) => entry.page === args.targetPage && entry.at >= start);
        if (targetCommitted) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      firstContentVisibleMs = await firstContentPromise;
      interactionEnd = performance.now();
    } else {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      interactionEnd = performance.now();
      firstContentVisibleMs = await firstContentPromise;
    }

    const imageReadiness = args.contentSelector
      ? await (async (): Promise<ImageReadinessMetric> => {
          const contentRoot = document.querySelector(args.contentSelector);
          const visibleImages = contentRoot
            ? Array.from(contentRoot.querySelectorAll('img'))
            : [];
          const settleOne = async (image: HTMLImageElement) => {
            let timedOut = false;
            if (!image.complete) {
              await Promise.race([
                new Promise<void>((resolve) => {
                  image.addEventListener('load', () => resolve(), { once: true });
                  image.addEventListener('error', () => resolve(), { once: true });
                }),
                new Promise<void>((resolve) => setTimeout(() => {
                  timedOut = true;
                  resolve();
                }, 2_000)),
              ]);
            }
            const complete = image.complete && image.naturalWidth > 0;
            let decoded = false;
            if (complete && typeof image.decode === 'function') {
              try {
                await Promise.race([
                  image.decode(),
                  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('decode timeout')), 2_000)),
                ]);
                decoded = true;
              } catch {
                decoded = false;
              }
            } else if (complete) {
              decoded = true;
            }
            return { complete, decoded, failed: !complete && !timedOut, timedOut };
          };
          const results = await Promise.all(visibleImages.map(settleOne));
          return {
            visibleCount: visibleImages.length,
            completeCount: results.filter((result) => result.complete).length,
            decodedCount: results.filter((result) => result.decoded).length,
            failedCount: results.filter((result) => result.failed).length,
            timedOutCount: results.filter((result) => result.timedOut).length,
            allSettled: results.every((result) => !result.timedOut),
            settledMs: performance.now() - start,
          };
        })()
      : null;

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const observationEnd = performance.now();
    const longTasks = (perfState?.longTasks ?? []).filter((entry) => (
      entry.startTime >= start - 0.1 && entry.startTime <= observationEnd
    ));
    const pageCommit = args.targetPage && pageCommitStartIndex !== null
      ? perfState?.pageCommits
        .slice(pageCommitStartIndex)
        .find((entry) => entry.page === args.targetPage && entry.at >= start)
      : undefined;
    const invokeEntries = invokeStartIndex === null
      ? null
      : (perfState?.invokes ?? [])
        .slice(invokeStartIndex)
        .filter((entry) => entry.startedAt >= start);
    const invokes = invokeEntries === null
      ? null
      : invokeEntries.reduce<InvokeMetric>((metric, entry) => {
          metric.callCount += 1;
          metric.requestBytes += entry.requestBytes;
          metric.responseBytes += entry.responseBytes;
          if (!entry.ok) metric.failedCount += 1;
          metric.commands[entry.command] = (metric.commands[entry.command] ?? 0) + 1;
          return metric;
        }, {
          callCount: 0,
          requestBytes: 0,
          responseBytes: 0,
          failedCount: 0,
          commands: {},
        });
    const interactionLongTasks = longTasks.map((entry): InteractionLongTask => {
      const startOffsetMs = entry.startTime - start;
      const endOffsetMs = startOffsetMs + entry.duration;
      const pageCommitOffsetMs = pageCommit ? pageCommit.at - start : null;
      return {
        startOffsetMs,
        endOffsetMs,
        durationMs: entry.duration,
        startedBeforeInteractionEnd: entry.startTime <= interactionEnd,
        overlappedPageCommit: pageCommitOffsetMs !== null
          && startOffsetMs <= pageCommitOffsetMs
          && endOffsetMs >= pageCommitOffsetMs,
        attribution: entry.attribution ?? [],
      };
    });
    const durations = interactionLongTasks.map((entry) => entry.durationMs);

    return {
      name: args.name,
      durationMs: interactionEnd - start,
      observationDurationMs: observationEnd - start,
      firstContentVisibleMs,
      imageReadiness,
      pageCommitMs: pageCommit ? pageCommit.at - start : null,
      reactCommitMs: pageCommit?.renderDurationMs ?? null,
      invokes,
      domNodeCount: document.getElementsByTagName('*').length,
      longTaskCount: longTasks.length,
      longTaskTotalMs: durations.reduce((total, duration) => total + duration, 0),
      maxLongTaskMs: durations.length > 0 ? Math.max(...durations) : 0,
      longTasks: interactionLongTasks,
    };
  }, {
    name,
    action,
    targetPage: navigation?.targetPage ?? null,
    contentSelector: navigation?.contentSelector ?? null,
  });
}

export async function waitForPage(page: Page, pageKey: PageKey): Promise<void> {
  await expect(page.locator(PAGE_READY_SELECTOR[pageKey])).toBeVisible();
}

export async function navigateWithoutMeasurement(
  page: Page,
  pageKey: PageKey,
  options: { bypassBlockingOverlay?: boolean } = {},
): Promise<void> {
  const settingsActive = await page.locator(PAGE_READY_SELECTOR.settings).count() > 0;
  if (settingsActive && pageKey !== 'settings') {
    const settingsButton = page.getByTestId('settings-toggle');
    if (options.bypassBlockingOverlay) await settingsButton.dispatchEvent('click');
    else await settingsButton.click();
    await expect(page.locator(PAGE_READY_SELECTOR.settings)).toHaveCount(0);
    if (await page.locator(PAGE_READY_SELECTOR[pageKey]).isVisible().catch(() => false)) {
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      return;
    }
  }

  const navButton = pageKey === 'settings'
    ? page.getByTestId('settings-toggle')
    : sidebarNavigationButton(page, pageKey);
  if (options.bypassBlockingOverlay) {
    // Ant image previews are intentionally modal and intercept pointer input.
    // Dispatch the real React click so this helper can exercise Activity's
    // programmatic page-disconnect cleanup without closing the preview first.
    await navButton.dispatchEvent('click');
  } else {
    await navButton.click();
  }
  await waitForPage(page, pageKey);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

export async function measureNavigation(
  page: Page,
  from: PageKey,
  to: PageKey,
): Promise<InteractionMetric> {
  const metric = await measureElementAction(
    navigationButton(page, from, to),
    `${from}->${to}`,
    'click',
    { targetPage: to, contentSelector: PAGE_CONTENT_SELECTOR[to] },
  );
  await waitForPage(page, to);
  return metric;
}

export async function measureClick(
  locator: Locator,
  name: string,
  options: { contentSelector?: string } = {},
): Promise<InteractionMetric> {
  return measureElementAction(
    locator,
    name,
    'click',
    options.contentSelector
      ? { contentSelector: options.contentSelector, targetPage: undefined }
      : undefined,
  );
}

export async function measureMiddleScroll(locator: Locator, name: string): Promise<InteractionMetric> {
  return measureElementAction(locator, name, 'scroll-middle');
}

export async function readResourceSnapshot(page: Page): Promise<ResourceSnapshot | null> {
  return page.evaluate(() => {
    const resources = (window as Window & { __AQBOT_PERF__?: BrowserPerfState })
      .__AQBOT_PERF__?.resources;
    if (!resources) return null;
    return {
      liveEventListeners: resources.liveListeners.size,
      activeIntervals: resources.activeIntervals.size,
      totalEventListenersAdded: resources.totalListenersAdded,
      totalEventListenersRemoved: resources.totalListenersRemoved,
      totalIntervalsCreated: resources.totalIntervalsCreated,
      totalIntervalsCleared: resources.totalIntervalsCleared,
      domNodeCount: document.getElementsByTagName('*').length,
    };
  });
}

export async function collectHeapAfterGc(page: Page): Promise<HeapSnapshot | null> {
  let session;
  try {
    session = await page.context().newCDPSession(page);
    await session.send('HeapProfiler.enable');
    await session.send('HeapProfiler.collectGarbage');
    const usage = await session.send('Runtime.getHeapUsage') as {
      usedSize: number;
      totalSize: number;
      embedderHeapUsedSize?: number;
    };
    return {
      usedSize: usage.usedSize,
      totalSize: usage.totalSize,
      embedderHeapUsedSize: usage.embedderHeapUsedSize ?? null,
    };
  } catch {
    return null;
  } finally {
    await session?.detach().catch(() => {});
  }
}

export async function measureConversationListGeometry(page: Page): Promise<ConversationListGeometry> {
  return page.locator('[data-list-mode]').evaluate((root) => {
    const group = root.querySelector<HTMLElement>('.ant-conversations-group-title');
    const item = root.querySelector<HTMLElement>('[data-conv-id]');
    const label = item?.querySelector<HTMLElement>('.ant-conversations-label') ?? null;
    if (!group || !item || !label) {
      throw new Error('Conversation list geometry requires a group, item, and label');
    }
    const box = (element: Element): ElementBox => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return {
      mode: root.getAttribute('data-list-mode'),
      rootClasses: Array.from(root.classList),
      groupClasses: Array.from(group.classList),
      itemClasses: Array.from(item.classList),
      labelClasses: Array.from(label.classList),
      root: box(root),
      group: box(group),
      item: box(item),
      label: box(label),
    };
  });
}

export async function settleBrowser(page: Page, delayMs = 100): Promise<void> {
  await page.evaluate(async (delay) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }, delayMs);
}

export async function attachJson(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
    contentType: 'application/json',
  });
}

export function enforceInteractionBudget(
  metric: InteractionMetric,
  budget: { durationMs?: number; maxLongTaskMs?: number },
): void {
  if (process.env.PERF_ENFORCE !== '1') return;
  if (budget.durationMs !== undefined) {
    expect.soft(metric.durationMs, `${metric.name} interaction-settle budget`).toBeLessThanOrEqual(budget.durationMs);
  }
  if (budget.maxLongTaskMs !== undefined) {
    expect.soft(metric.maxLongTaskMs, `${metric.name} Long Task budget`).toBeLessThan(budget.maxLongTaskMs);
  }
}
