const { chromium } = require("playwright");

// Verifies the container log viewer tails the newest lines the way a reader expects:
//   - opening a Logs session lands on the newest line instead of the top of the buffer
//   - the periodic refresh keeps the view pinned while it rests on the bottom edge
//   - scrolling up to read older lines freezes the view, so refreshes stop yanking it
//   - scrolling back to the bottom edge resumes tailing
//   - switching container reopens the log on its newest line
//
// Runs against the dev server with a mocked Tauri backend, so the real session dock
// and its five-second log refresh drive every assertion (no native backend needed).

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";
const bottomEdgeSlack = 8; // mirrors src/log-output-scroll-area.tsx
const appendTimeout = 10_000; // a followed container pushes new lines continuously

const cluster = {
  id: "logtail", name: "logtail", provider: "Local", region: "test", version: "v1.31.0",
  status: "healthy", nodes: 1, cpu: 12, memory: 24, context: "logtail",
  server: "https://127.0.0.1:6443", defaultNamespace: "default", imported: true,
  disconnected: false, error: null,
};
const descriptors = [{ apiVersion: "v1", group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, verbs: ["get", "list", "watch", "create", "delete"], categories: ["all"] }];
const pods = [{
  key: "pods/default/api-0", name: "api-0", namespace: "default", uid: "api-0-uid",
  resourceVersion: "1", apiVersion: "v1", kind: "Pod", ageSeconds: 120,
  object: {
    apiVersion: "v1", kind: "Pod",
    metadata: { name: "api-0", namespace: "default", uid: "api-0-uid", labels: { app: "api" } },
    spec: { containers: [{ name: "api", image: "example.test/api:1.0" }, { name: "sidecar", image: "example.test/sidecar:1.0" }] },
    status: { phase: "Running", containerStatuses: [{ ready: true }, { ready: true }] },
  },
}];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });

  await page.addInitScript((fixture) => {
    const state = { ...fixture, streams: 0, timers: {} };
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        switch (command) {
          case "backend_info": return { name: "kubehive", runtime: "mock", kubernetesClient: "mock", mode: "test" };
          case "list_clusters": return [state.cluster];
          case "probe_cluster":
          case "reconnect_cluster": return state.cluster;
          case "discover_resources": return state.descriptors;
          case "list_resources": return { resourceVersion: "1", items: args?.request?.resource?.kind === "Pod" ? state.pods : [] };
          case "get_resource": {
            const item = state.pods.find((pod) => pod.name === args?.target?.name);
            if (!item) throw new Error("Mock resource not found");
            return { ...item, manifest: `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${item.name}` };
          }
          // A live container: seed the tail, then keep pushing new lines.
          case "stream_pod_logs": {
            const container = args?.request?.container || "api";
            state.streams += 1;
            window.__logStreamStarts = state.streams;
            const streamId = `log-stream-${state.streams}`;
            const emit = args?.onEvent?.onmessage;
            if (typeof emit !== "function") return streamId;
            emit({ streamId, eventType: "connected", lines: [], error: null });
            const line = (index) => `${container} log line ${String(index).padStart(4, "0")}`;
            let produced = 300;
            const seed = [];
            for (let index = 1; index <= produced; index += 1) seed.push(line(index));
            emit({ streamId, eventType: "lines", lines: seed, error: null });
            state.timers[streamId] = setInterval(() => {
              const batch = [];
              for (let index = 0; index < 6; index += 1) { produced += 1; batch.push(line(produced)); }
              emit({ streamId, eventType: "lines", lines: batch, error: null });
            }, 700);
            return streamId;
          }
          case "stop_pod_log_stream": {
            window.__logStreamStops = (window.__logStreamStops || []).concat(args?.streamId);
            const timer = state.timers[args?.streamId];
            if (timer) { clearInterval(timer); delete state.timers[args.streamId]; }
            return true;
          }
          case "pod_logs": {
            const container = args?.request?.container || "api";
            const rows = [];
            for (let index = 1; index <= 300; index += 1) rows.push(`${container} snapshot line ${String(index).padStart(4, "0")}`);
            return rows.join(String.fromCharCode(10));
          }
          case "start_resource_watch": return "mock-watch";
          case "stop_resource_watch": return true;
          default: return null;
        }
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    };
  }, { cluster, descriptors, pods });

  const viewport = page.locator(".logs-output");
  const readViewport = () => viewport.evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    distanceFromBottom: element.scrollHeight - element.scrollTop - element.clientHeight,
    lines: (element.textContent ?? "").trim().split("\n").length,
  }));
  // Wheel gestures scroll asynchronously; wait until the offset stops moving.
  const settleScroll = async () => {
    let previous = -1;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const current = await viewport.evaluate((element) => element.scrollTop);
      if (current === previous) return current;
      previous = current;
      await page.waitForTimeout(50);
    }
    return previous;
  };
  const countLines = () => viewport.evaluate((element) => (element.textContent ?? "").trim().split("\n").length);
  const waitForRefresh = (lines) => page.waitForFunction(
    (previous) => (document.querySelector(".logs-output")?.textContent ?? "").trim().split("\n").length > previous,
    lines,
    { timeout: appendTimeout },
  );
  /** Milliseconds until the next batch appears: a five-second poll could never match this. */
  const timeToNextLines = async () => {
    const lines = await countLines();
    const started = Date.now();
    await waitForRefresh(lines);
    return Date.now() - started;
  };
  const scrollUp = async () => {
    await viewport.hover();
    await page.mouse.wheel(0, -600);
    return settleScroll();
  };

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });

    // Cluster, Pods list, pod detail, then the Logs session.
    await page.locator(".cluster-home-avatar").first().click();
    await page.getByRole("button", { name: "Pods", exact: true }).click();
    const row = page.locator(".resource-table tbody tr[data-index]").filter({ hasText: "api-0" });
    await row.waitFor();
    await row.locator("td:not(.selection-col)").first().click();
    await page.locator(".sheet-right").waitFor();
    await page.locator(".sheet-right").getByRole("button", { name: "Logs", exact: true }).click();
    await viewport.waitFor();

    // 1. The first painted log page rests on the newest line.
    await page.waitForFunction(() => {
      const element = document.querySelector(".logs-output");
      return Boolean(element) && element.scrollHeight > element.clientHeight + 200;
    }, undefined, { timeout: appendTimeout });
    await settleScroll();
    const opened = await readViewport();

    // 2. New lines arrive as the container writes them, not on a poll interval.
    const appendLatencyMs = await timeToNextLines();

    // 3. Staying on the bottom edge keeps the newest line in view.
    await settleScroll();
    const refreshed = await readViewport();

    // 4. Reading older lines must survive the next batch untouched.
    const heldScrollTop = await scrollUp();
    const held = await readViewport();
    await waitForRefresh(held.lines);
    await page.waitForTimeout(300);
    const afterHeldRefresh = await readViewport();

    // 5. Returning to the bottom edge resumes tailing.
    await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await settleScroll();
    const resumed = await readViewport();
    await waitForRefresh(resumed.lines);
    await settleScroll();
    const afterResume = await readViewport();

    // 6. Another container is another log: it opens on its own newest line.
    await scrollUp();
    const beforeSwitch = await readViewport();
    await page.locator(".container-target-combobox .combobox-trigger").click();
    await page.locator(".combobox-popover").getByText("sidecar", { exact: true }).click();
    await page.waitForFunction(() => (document.querySelector(".logs-output")?.textContent ?? "").includes("sidecar log line"), undefined, { timeout: appendTimeout });
    await settleScroll();
    const switched = await readViewport();
    const streams = await page.evaluate(() => ({ starts: window.__logStreamStarts ?? 0, stops: window.__logStreamStops ?? [] }));

    await page.screenshot({ path: "artifacts/log-tailing.png" });

    const result = {
      logOverflowsViewport: opened.scrollHeight > opened.clientHeight + 200,
      openedOnNewestLine: opened.scrollTop > 0 && opened.distanceFromBottom <= bottomEdgeSlack,
      refreshKeepsNewestLine: refreshed.lines > opened.lines && refreshed.distanceFromBottom <= bottomEdgeSlack,
      scrollUpPausesTailing: held.distanceFromBottom > bottomEdgeSlack,
      refreshArrivedWhileHeld: afterHeldRefresh.lines > held.lines,
      heldPositionUntouched: Math.abs(afterHeldRefresh.scrollTop - heldScrollTop) <= 1,
      bottomEdgeResumesTailing: afterResume.lines > resumed.lines && afterResume.distanceFromBottom <= bottomEdgeSlack,
      containerSwitchOpensNewestLine: beforeSwitch.distanceFromBottom > bottomEdgeSlack && switched.distanceFromBottom <= bottomEdgeSlack,
      // A poll would have taken five seconds; a stream shows up within one batch.
      linesArriveWithoutPolling: appendLatencyMs < 2_500,
      // One stream per log target, and the previous one is released on the switch.
      oneStreamPerTarget: streams.starts === 2,
      previousStreamStopped: streams.stops.includes("log-stream-1"),
      errors,
    };
    const samples = { appendLatencyMs, streams, opened, refreshed, held, afterHeldRefresh, resumed, afterResume, beforeSwitch, switched };
    console.log(JSON.stringify({ ...result, samples }, null, 2));
    const failed = Object.entries(result).filter(([name, value]) => name !== "errors" && !value).map(([name]) => name);
    if (failed.length || errors.length) {
      console.error("FAILED:", [...failed, ...errors].join(" | "));
      process.exit(1);
    }
    console.log("LOG TAILING E2E PASSED");
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error("FAILED:", error.message); process.exit(1); });
