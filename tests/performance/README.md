# AQBot production performance harness

These Playwright tests run against a production Vite build and seed the browser
mock backend with deterministic localStorage fixtures. They measure interaction
settle time, first visible page content, visible image load/decode,
source-reported page commits, invoke count/bytes, Long Tasks, mounted conversation
rows, and total DOM nodes without requiring a Tauri database.

Run the complete release-gate suite (the package script sets
`PERF_ENFORCE=1` on every platform):

```bash
pnpm test:perf
```

The direct Playwright command is metrics-only unless `PERF_ENFORCE=1` is set.
In metrics-only mode, tests still enforce correctness: the page must render without an
uncaught exception, the native/virtual branch must match the expanded row count,
virtualization must keep the mounted row count bounded, the 159/160 row boundary
must keep the first-screen Ant UI geometry within 1 px and the exact pixel
difference within 0.5%, Chat/Drawing scroll restoration must stay within 1 px,
and 100 warm Chat/Drawing cycles must not retain listeners, intervals, or
cycle-proportional DOM nodes. Warm page samples also reject repeat conversation,
provider, message-version, or drawing-history IPC loads.
Metrics are emitted as per-test JSON attachments and as
`test-results/performance-results.json`.

Collect metrics without wall-clock/heap budgets on an unstable shared runner:

```bash
pnpm exec playwright test --config=playwright.perf.config.ts
```

The enforced budgets are 50 ms for an active-conversation switch, 100 ms for a
warm Chat/Drawing switch, and 150 ms for a Roles transition. Module navigation
records every Long Task with its start/end offsets and commit overlap, while the
explicit 1,000-row sidebar scroll gate rejects Long Tasks of 50 ms or more. The
suite also requires React commit P95 to stay within 50 ms and GC-retained
Chromium JS heap growth after 100 warm cycles to stay below 10%. Do not use the
release-gate command on shared or heavily loaded CI hosts.

Navigation duration ends only after the target page has committed and its active
content selector is present. The probe deliberately avoids geometry/style reads
in that commit frame so measurement itself cannot force layout of the retained
Activity tree.

`pageCommitMs`, `reactCommitMs`, and invoke byte counts come from the
application's conditional `window.__AQBOT_PERF__` instrumentation. Unsupported
CDP heap collection is recorded as `null` rather than treated as a successful
measurement.

To reuse a separately started production preview, set `PERF_BASE_URL`; otherwise
the configuration always runs `pnpm build` followed by `pnpm preview`:

```bash
PERF_BASE_URL=http://127.0.0.1:4173 \
  pnpm test:perf
```

The default project uses Playwright's bundled Chromium. A machine that has not
run `pnpm exec playwright install chromium` can opt into an installed Chrome
without changing the checked-in configuration:

```bash
PERF_BROWSER_CHANNEL=chrome \
  pnpm test:perf
```
