const { chromium } = require("playwright");

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";
const windowsUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const cluster = {
  id: "deepfonts", name: "deepfonts", provider: "Local", region: "test", version: "v1.31.0",
  status: "healthy", nodes: 2, cpu: 18, memory: 31, context: "deepfonts",
  server: "https://127.0.0.1:6443", defaultNamespace: "default", imported: true,
  disconnected: false, error: null,
};
const descriptors = [{ apiVersion: "v1", group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, verbs: ["get", "list", "watch", "create", "delete"], categories: ["all"] }];
const pods = [{
  key: "pods/default/api-0", name: "api-0", namespace: "default", uid: "api-0-uid",
  resourceVersion: "1", apiVersion: "v1", kind: "Pod", ageSeconds: 120,
  object: {
    apiVersion: "v1", kind: "Pod",
    metadata: { name: "api-0", namespace: "default", uid: "api-0-uid", labels: { "app": "api" }, annotations: { "example.io/note": "annotation" } },
    spec: { containers: [{ name: "api", image: "example.test/api:1.0" }] },
    status: { phase: "Running" },
  },
}];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: windowsUserAgent });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  await page.addInitScript((fixture) => {
    const state = { cluster: fixture.cluster, descriptors: fixture.descriptors, pods: fixture.pods };
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        switch (command) {
          case "backend_info": return { name: "kubehive", runtime: "mock", kubernetesClient: "mock", mode: "test" };
          case "list_clusters": return [state.cluster];
          case "probe_cluster":
          case "reconnect_cluster": return state.cluster;
          case "discover_resources": return state.descriptors;
          case "cluster_overview": return { clusterId: state.cluster.id, version: state.cluster.version, nodes: state.cluster.nodes, readyNodes: state.cluster.nodes, cpuPercent: state.cluster.cpu, memoryPercent: state.cluster.memory, pods: state.pods.length, runningPods: state.pods.length, podCapacity: 10, storageBytes: 0, storageCapacityBytes: 1, workloadHealth: { total: 0, healthy: 0, degraded: 0, failed: 0 }, nodeUsage: [], issues: [], events: [], updatedAt: new Date().toISOString() };
          case "list_resources": return { resourceVersion: "1", items: args?.request?.resource?.kind === "Pod" ? state.pods : [] };
          case "get_resource": {
            const item = state.pods.find((pod) => pod.name === args?.target?.name && pod.namespace === args?.target?.namespace);
            if (!item) throw new Error("Mock resource not found");
            return { ...item, manifest: `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${item.name}\nspec:\n  containers:\n    - name: ${item.object.spec.containers[0].name}` };
          }
          case "pod_metrics":
          case "node_metrics": return null;
          case "start_resource_watch": return "mock-watch";
          case "stop_resource_watch": return true;
          case "list_port_forwards": return [];
          case "pod_logs": return "\u001b[32mINFO\u001b[0m listening on :8080\nrequest served in 12ms";
          case "stream_pod_logs": {
            const streamId = "log-stream-1";
            const emit = args?.onEvent?.onmessage;
            if (typeof emit === "function") {
              emit({ streamId, eventType: "connected", lines: [], error: null });
              emit({ streamId, eventType: "lines", lines: ["\u001b[32mINFO\u001b[0m listening on :8080", "request served in 12ms"], error: null });
            }
            return streamId;
          }
          case "stop_pod_log_stream": return true;
          case "download_logs": return "logs.txt";
          case "start_terminal": {
            const id = "term-mock";
            const emit = args?.onEvent?.onmessage;
            if (typeof emit === "function") {
              setTimeout(() => {
                emit({ sessionId: id, eventType: "connected", data: null });
                emit({ sessionId: id, eventType: "output", data: "$ kubehive\r\n" });
              }, 50);
            }
            return id;
          }
          case "write_terminal":
          case "resize_terminal":
          case "stop_terminal": return null;
          case "list_system_fonts": return [
            { name: "Cascadia Mono", monospace: true },
            { name: "JetBrains Mono", monospace: true },
            { name: "Fira Code", monospace: true },
            { name: "Segoe UI", monospace: false },
            { name: "Arial", monospace: false },
          ];
          case "disconnect_cluster":
          case "cancel_cluster_connection": return true;
          default: return Promise.resolve(null);
        }
      },
    };
  }, { cluster, descriptors, pods });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("kubehive.preferences", JSON.stringify({ language: "en", theme: "dark", autoUpdate: false, appFont: "system", monoFont: "JetBrains Mono" }));
  });
  await page.reload({ waitUntil: "networkidle" });

  // --font-mono must drive every font-mono surface.
  const rootMono = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim());
  const rootMonoFirst = rootMono.split(",")[0].trim().replace(/^"|"$/g, "");
  if (rootMonoFirst !== "JetBrains Mono") throw new Error(`root --font-mono wrong: ${rootMono}`);

  // Connect to the cluster and open the Pod list.
  await page.locator(".cluster-home-avatar").first().click();
  await page.getByRole("button", { name: "Pods", exact: true }).click();
  const row = page.locator(".resource-table tbody tr[data-index]").filter({ hasText: "api-0" });
  await row.waitFor();

  // Every element carrying the font-mono utility must use the chosen mono font.
  const tableMonoFont = await page.evaluate(() => {
    const monoEls = [...document.querySelectorAll(".font-mono, code, kbd, samp, .cluster-home-version")];
    return monoEls.map((el) => getComputedStyle(el).fontFamily);
  });
  if (tableMonoFont.length === 0 || !tableMonoFont.every((family) => family.includes("JetBrains Mono"))) {
    throw new Error(`font-mono surfaces not applied: ${JSON.stringify(tableMonoFont.slice(0, 6))}`);
  }

  // Open the detail sheet, then Logs.
  await row.locator("td:not(.selection-col)").first().click();
  await page.locator(".sheet-right").waitFor();
  const sheetMonoFonts = await page.evaluate(() => {
    const targets = [".detail-property-value code", '[data-property-metadata="labels"] code', '[data-property-metadata="annotations"] code', ".detail-image-address code"];
    const families = [];
    for (const selector of targets) {
      const el = document.querySelector(selector);
      if (el) families.push(getComputedStyle(el).fontFamily);
    }
    return families;
  });
  if (sheetMonoFonts.length === 0 || !sheetMonoFonts.every((family) => family.includes("JetBrains Mono"))) {
    throw new Error(`detail sheet mono fonts wrong: ${JSON.stringify(sheetMonoFonts)}`);
  }

  // Manifest editor (CodeMirror) must use the mono font.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".manifest-editor .cm-content").waitFor();
  const editorFont = await page.evaluate(() => getComputedStyle(document.querySelector(".manifest-editor .cm-content")).fontFamily);
  if (!editorFont.includes("JetBrains Mono")) throw new Error(`editor font wrong: ${editorFont}`);
  const editorRootFont = await page.evaluate(() => getComputedStyle(document.querySelector(".manifest-editor")).fontFamily);
  if (!editorRootFont.includes("JetBrains Mono")) throw new Error(`editor host font wrong: ${editorRootFont}`);
  // Close the edit session, reopen the detail, then check Logs.
  await page.locator(".session-close, .session-tab-close, .workspace-tabs .tab-close").first().click().catch(() => {});
  await page.waitForTimeout(300);
  await row.locator("td:not(.selection-col)").first().click();
  await page.locator(".sheet-right").waitFor();
  await page.locator(".sheet-right").getByRole("button", { name: "Logs", exact: true }).click();
  await page.locator(".logs-scroll-area").waitFor();
  await page.waitForFunction(() => document.querySelector(".logs-scroll-area pre")?.textContent?.includes("listening on"));
  const logFont = await page.evaluate(() => getComputedStyle(document.querySelector(".logs-scroll-area pre")).fontFamily);
  if (!logFont.includes("JetBrains Mono")) throw new Error(`log viewer font wrong: ${logFont}`);
  // Close the logs session, reopen the detail, then check the xterm terminal.
  await page.locator(".session-close, .session-tab-close, .workspace-tabs .tab-close").first().click().catch(() => {});
  await page.waitForTimeout(300);
  await row.locator("td:not(.selection-col)").first().click();
  await page.locator(".sheet-right").waitFor();
  await page.locator(".sheet-right").getByRole("button", { name: "Terminal", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".container-terminal .xterm-rows"));
  await page.waitForTimeout(300);
  const terminalFont = await page.evaluate(() => {
    const rowEl = document.querySelector(".container-terminal .xterm-rows");
    return rowEl ? getComputedStyle(rowEl).fontFamily : "";
  });
  if (!terminalFont.includes("JetBrains Mono")) throw new Error(`terminal font wrong: ${terminalFont}`);

  // The app UI itself follows --font-sans (system default stack on Windows).
  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  console.log("body font:", bodyFont);
  if (!bodyFont.includes("Segoe UI")) throw new Error(`app UI font wrong: ${bodyFont}`);

  if (errors.length) throw new Error(`runtime errors: ${errors.join(" | ")}`);
  console.log("DEEP FONT E2E PASSED");
  await browser.close();
})().catch((error) => { console.error("FAILED:", error.message); process.exit(1); });
