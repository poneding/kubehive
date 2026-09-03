const { chromium } = require("playwright");

// Verifies container-session Pod targeting against a mocked Tauri backend:
//   - a Deployment session lists every Pod of the Deployment's ReplicaSets
//   - a session opened on a Deployment-owned Pod shows the same Pod target
//     combobox (resolved through the owner chain) and preselects that Pod
//   - a standalone Pod keeps its single-Pod session without a Pod combobox
//   - a workload with no Pods explains itself instead of a dead "Unavailable"
//     state, and no log stream pretends to connect

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";

const cluster = {
  id: "podtargets", name: "podtargets", provider: "Local", region: "test", version: "v1.31.0",
  status: "healthy", nodes: 1, cpu: 12, memory: 24, context: "podtargets",
  server: "https://127.0.0.1:6443", defaultNamespace: "default", imported: true,
  disconnected: false, error: null,
};

const descriptors = ["Pod", "ReplicaSet", "Deployment", "StatefulSet", "DaemonSet"].map((kind) => ({
  apiVersion: kind === "Pod" ? "v1" : "apps/v1", group: kind === "Pod" ? "" : "apps",
  version: "v1", kind, plural: kind.toLowerCase() + "s",
  namespaced: true, verbs: ["get", "list", "watch", "create", "delete"], categories: [],
}));

const record = (kind, name, uid, spec, metadata = {}) => ({
  key: `default/${name}`, name, namespace: "default", uid, resourceVersion: "1",
  apiVersion: kind === "Pod" ? "v1" : "apps/v1", kind, ageSeconds: 60,
  object: {
    apiVersion: kind === "Pod" ? "v1" : "apps/v1", kind,
    metadata: { name, namespace: "default", uid, labels: metadata.labels ?? {}, ownerReferences: metadata.ownerReferences ?? [] },
    spec: spec ?? {},
    status: metadata.status ?? { phase: "Running" },
  },
});

const podRecord = (name, uid, ownerUid, ownerKind = "ReplicaSet", containers = [{ name: "web" }, { name: "sidecar" }], statuses = [{ ready: true }, { ready: true }]) =>
  record("Pod", name, uid, { containers, initContainers: [] }, {
    labels: { app: "shop" },
    ownerReferences: [{ apiVersion: "apps/v1", kind: ownerKind, name: `${ownerKind === "ReplicaSet" ? "shop-7d6f9b5c6" : "shop"}`, uid: ownerUid, controller: true }],
    status: { phase: "Running", containerStatuses: statuses },
  });

const records = {
  Pod: [
    podRecord("shop-7d6f9b5c6-aaa", "pod-a", "rs-shop"),
    podRecord("shop-7d6f9b5c6-bbb", "pod-b", "rs-shop"),
    podRecord("shop-7d6f9b5c6-ccc", "pod-c", "rs-shop"),
    record("Pod", "standalone-x1", "pod-standalone", { containers: [{ name: "tool" }], initContainers: [] }, { labels: { app: "cron" }, status: { phase: "Running", containerStatuses: [{ ready: true }] } }),
  ],
  ReplicaSet: [
    record("ReplicaSet", "shop-7d6f9b5c6", "rs-shop", {
      selector: { matchLabels: { app: "shop" } },
      template: { metadata: { labels: { app: "shop" } }, spec: { containers: [{ name: "web" }, { name: "sidecar" }] } },
    }, {
      labels: { app: "shop" },
      ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "shop", uid: "dep-shop", controller: true }],
    }),
  ],
  Deployment: [
    record("Deployment", "shop", "dep-shop", {
      selector: { matchLabels: { app: "shop" } },
      template: { metadata: { labels: { app: "shop" } }, spec: { containers: [{ name: "web" }] } },
      replicas: 3,
    }, { labels: { app: "shop" } }),
    // Scaled to zero: no ReplicaSets, no Pods.
    record("Deployment", "idle", "dep-idle", {
      selector: { matchLabels: { app: "idle" } },
      template: { metadata: { labels: { app: "idle" } }, spec: { containers: [{ name: "app" }] } },
      replicas: 0,
    }, { labels: { app: "idle" } }),
  ],
  StatefulSet: [],
  DaemonSet: [],
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });

  await page.addInitScript((fixture) => {
    const state = { ...fixture, timers: {} };
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        const kind = args?.request?.resource?.kind ?? args?.target?.resource?.kind ?? "";
        switch (command) {
          case "backend_info": return { name: "kubehive", runtime: "mock", kubernetesClient: "mock", mode: "test" };
          case "list_clusters": return [state.cluster];
          case "probe_cluster":
          case "reconnect_cluster": return state.cluster;
          case "discover_resources": return state.descriptors;
          case "list_resources": {
            const items = state.records[kind] ?? [];
            // The mock serves every kind un-filtered; the UI filters by owner uid.
            return { resourceVersion: "1", items };
          }
          case "get_resource": {
            const item = (state.records[kind] ?? []).find((entry) => entry.name === (args?.target?.name ?? args?.request?.name));
            if (!item) throw new Error("Mock resource not found");
            return { ...item, manifest: `apiVersion: ${item.apiVersion}\nkind: ${item.kind}\nmetadata:\n  name: ${item.name}\n  namespace: ${item.namespace}` };
          }
          case "start_terminal": {
            const emit = args?.onEvent?.onmessage;
            window.__terminalStarts = (window.__terminalStarts || 0) + 1;
            if (typeof emit === "function") emit({ sessionId: "term-1", eventType: "connected", data: "Connected" });
            return "term-1";
          }
          case "write_terminal":
          case "resize_terminal": return null;
          case "stop_terminal": return true;
          case "stream_pod_logs": {
            window.__logStreamStarts = (window.__logStreamStarts || 0) + 1;
            const streamId = `log-stream-${window.__logStreamStarts}`;
            const emit = args?.onEvent?.onmessage;
            if (typeof emit === "function") {
              emit({ streamId, eventType: "connected", lines: [], error: null });
              emit({ streamId, eventType: "lines", lines: ["web log line"], error: null });
            }
            return streamId;
          }
          case "stop_pod_log_stream": return true;
          case "pod_logs": return "snapshot log line";
          case "start_resource_watch": return "mock-watch";
          case "stop_resource_watch": return true;
          default: return null;
        }
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    };
  }, { cluster, descriptors, records });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const dockState = () => page.evaluate(() => ({
    pod: document.querySelector(".pod-target-combobox .combobox-trigger strong")?.textContent.trim() ?? null,
    container: document.querySelector(".container-target-combobox .combobox-trigger strong")?.textContent.trim() ?? null,
    notice: document.querySelector(".session-target-notice")?.textContent.replace(/\s+/g, " ").trim() ?? null,
    noticeTitle: document.querySelector(".session-target-notice")?.getAttribute("title") ?? null,
  }));

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const avatar = page.locator(".cluster-home-avatar").first();
    await avatar.waitFor({ timeout: 45000 });
    await avatar.click();
    await page.waitForTimeout(1500);

    // ── 1. Deployment session lists the Pods of its ReplicaSets ──────────────
    await page.getByRole("button", { name: "Deployments", exact: true }).click();
    const shopRow = page.locator(".resource-table tbody tr").filter({ hasText: "shop" }).first();
    await shopRow.waitFor();
    await shopRow.click();
    await page.locator(".sheet-right").waitFor();
    await page.locator(".sheet-right").getByRole("button", { name: "Logs", exact: true }).click();
    await page.locator(".pod-target-combobox .combobox-trigger").waitFor();
    await page.waitForFunction(() => document.querySelector(".pod-target-combobox .combobox-trigger strong")?.textContent.trim() !== "Unavailable" && document.querySelector(".pod-target-combobox .combobox-trigger strong")?.textContent.trim() !== "Resolving...");
    const deploymentPod = (await page.locator(".pod-target-combobox .combobox-trigger strong").textContent()).trim();
    await page.locator(".pod-target-combobox .combobox-trigger").click();
    await page.locator(".combobox-popover").waitFor();
    const deploymentOptions = await page.locator(".combobox-popover button span strong").allTextContents();
    await page.locator(".pod-target-combobox .combobox-trigger").click(); // toggle the popover closed
    await page.waitForTimeout(300);
    await page.waitForFunction(() => document.querySelector(".container-target-combobox .combobox-trigger strong")?.textContent.trim().length > 0);
    const deploymentContainer = (await page.locator(".container-target-combobox .combobox-trigger strong").textContent()).trim();

    // ── 2. Session from a Deployment-owned Pod gets the same Pod combobox ─────
    await page.locator(".sheet-right").getByRole("button", { name: "Close", exact: true }).click().catch(() => {});
    await page.getByRole("button", { name: "Pods", exact: true }).click();
    const podRow = page.locator(".resource-table tbody tr").filter({ hasText: "shop-7d6f9b5c6-bbb" }).first();
    await podRow.waitFor();
    await podRow.locator("td:not(.selection-col)").first().click();
    await page.locator(".sheet-right").waitFor();
    await page.locator(".sheet-right").getByRole("button", { name: "Terminal", exact: true }).click();
    await page.locator(".pod-target-combobox .combobox-trigger").waitFor();
    await page.waitForFunction(() => document.querySelector(".pod-target-combobox .combobox-trigger strong")?.textContent.trim() === "shop-7d6f9b5c6-bbb");
    const ownedPodPreselect = (await page.locator(".pod-target-combobox .combobox-trigger strong").textContent()).trim();
    await page.locator(".pod-target-combobox .combobox-trigger").click();
    await page.locator(".combobox-popover").waitFor();
    const ownedPodOptions = await page.locator(".combobox-popover button span strong").allTextContents();
    await page.locator(".pod-target-combobox .combobox-trigger").click(); // toggle the popover closed
    await page.waitForTimeout(300);

    // ── 3. Standalone Pod keeps a single-Pod session, no Pod combobox ────────
    const standaloneRow = page.locator(".resource-table tbody tr").filter({ hasText: "standalone-x1" }).first();
    await standaloneRow.click();
    await page.locator(".sheet-right").getByRole("button", { name: "Logs", exact: true }).click();
    await page.waitForTimeout(1500);
    const standaloneHasPodSelector = await page.locator(".pod-target-combobox").count();
    const standaloneContainer = (await page.locator(".container-target-combobox .combobox-trigger strong").textContent()).trim();

    // ── 4. Workload with no Pods explains itself instead of dead controls ────
    await page.getByRole("button", { name: "Deployments", exact: true }).click();
    const idleRow = page.locator(".resource-table tbody tr").filter({ hasText: "idle" }).first();
    await idleRow.click();
    await page.locator(".sheet-right").getByRole("button", { name: "Logs", exact: true }).click();
    await page.locator(".session-target-notice").waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    const empty = await dockState();
    const emptyPodLabel = (await page.locator(".pod-target-combobox .combobox-trigger strong").textContent()).trim();
    const streamStarts = await page.evaluate(() => window.__logStreamStarts ?? 0);
    const logPaneText = (await page.locator(".logs-output").textContent().catch(() => "") ?? "").trim();
    const terminalStarts = await page.evaluate(() => window.__terminalStarts ?? 0);
    const emptyLogPane = logPaneText.slice(0, 200);

    const result = {
      deploymentPod,
      deploymentOptions,
      deploymentContainer,
      ownedPodPreselect,
      ownedPodOptions,
      standaloneHasPodSelector,
      standaloneContainer,
      empty,
      emptyPodLabel,
      emptyLogPane,
      streamStarts,
      terminalStarts,
      runtimeErrors: errors,
    };
    console.log(JSON.stringify(result, null, 2));
    await page.screenshot({ path: "artifacts/pod-targeting.png", fullPage: true });

    const sorted = (values) => [...values].sort();
    const valid =
      deploymentOptions.length === 3 && sorted(deploymentOptions).join("|") === sorted(["shop-7d6f9b5c6-aaa", "shop-7d6f9b5c6-bbb", "shop-7d6f9b5c6-ccc"]).join("|")
      && ["shop-7d6f9b5c6-aaa", "shop-7d6f9b5c6-bbb", "shop-7d6f9b5c6-ccc"].includes(deploymentPod)
      && deploymentContainer === "web"
      && ownedPodOptions.length === 3 && ownedPodOptions.includes("shop-7d6f9b5c6-bbb")
      && ownedPodPreselect === "shop-7d6f9b5c6-bbb"
      && standaloneHasPodSelector === 0
      && standaloneContainer === "tool"
      && empty.pod === "Unavailable" && empty.container === "Unavailable"
      && empty.notice?.includes("Deployment") && empty.notice?.includes("idle") && empty.notice?.includes("default")
      && emptyPodLabel === "Unavailable"
      && streamStarts === 2 // the shop Deployment and the standalone Pod Logs session streamed; the idle Deployment did not
      && terminalStarts === 1 // only the owned-Pod Terminal session started
      && emptyLogPane.includes("No pods are available for Deployment idle") && !emptyLogPane.includes("web log line")
      && errors.length === 0;
    await browser.close();
    if (!valid) process.exit(1);
    console.log("POD TARGETING E2E PASSED");
    process.exit(0);
    return;
  } catch (error) {
    await page.screenshot({ path: "artifacts/pod-targeting-failure.png", fullPage: true }).catch(() => undefined);
    console.error(error);
    await browser.close();
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
