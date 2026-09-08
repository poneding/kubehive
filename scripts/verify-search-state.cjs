const assert = require("node:assert/strict");
const { chromium } = require("playwright");

// Exercise navigation and filtering together, including preview replacement,
// same-named CRD kinds, and restoration of each cluster's workspace.
const clusters = ["alpha", "beta"].map((id) => ({
  id, name: `search-${id}`, provider: "Local", region: "local", version: "v1.31",
  status: "healthy", nodes: 1, cpu: 2, memory: 4, context: id,
  server: "https://127.0.0.1:6443", imported: true, disconnected: false,
}));
const descriptor = (kind, plural, group = "", namespaced = true) => ({
  apiVersion: group ? `${group}/v1` : "v1", group, version: "v1", kind, plural,
  namespaced, verbs: ["get", "list", "watch"], categories: [],
});
const descriptors = [
  descriptor("Pod", "pods"),
  descriptor("Deployment", "deployments", "apps"),
  descriptor("Widget", "widgets", "example.com"),
  descriptor("Widget", "widgets", "other.com"),
];
const rowNames = [["api-server", "worker-runner"], ["web-app", "database"], ["alpha-widget", "beta-widget"], ["gamma-widget", "delta-widget"]];
const rows = Object.fromEntries(descriptors.map((resource, index) => [resource.apiVersion, rowNames[index].map((name) => ({
  key: `${resource.apiVersion}/${name}`, name, namespace: "default",
  apiVersion: resource.apiVersion, kind: resource.kind, resourceVersion: "1", ageSeconds: 120,
  object: { apiVersion: resource.apiVersion, kind: resource.kind, metadata: { name, namespace: "default" }, status: { phase: "Running" } },
}))]));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript((mock) => {
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        switch (command) {
          case "backend_info": return { name: "kubehive", runtime: "mock", kubernetesClient: "mock", mode: "test" };
          case "list_clusters": return mock.clusters;
          case "probe_cluster": return mock.clusters.find((cluster) => cluster.id === args.clusterId);
          case "discover_resources": return mock.descriptors;
          case "list_resources": return { resourceVersion: "1", items: mock.rows[args.request.resource.apiVersion] ?? [] };
          case "get_resource": throw new Error("CRD definitions are not readable");
          case "cluster_overview": return {
            clusterId: args.clusterId, version: "v1.31", nodes: 1, readyNodes: 1,
            pods: 2, runningPods: 2, podCapacity: 10, storageBytes: 0, storageCapacityBytes: 1,
            workloadHealth: { total: 0, healthy: 0, degraded: 0, failed: 0 },
            nodeUsage: [], issues: [], events: [], updatedAt: new Date().toISOString(),
          };
          case "list_port_forwards": return [];
          case "start_resource_watch": return "search-state-watch";
          default: return null;
        }
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    };
  }, { clusters, descriptors, rows });

  const search = page.locator(".main-area .table-search input");
  const nav = page.locator(".resource-nav");
  const openResource = (name) => nav.getByRole("button", { name, exact: true }).click();
  const openCustomResource = (group) => nav.getByRole("group", { name: group, exact: true }).getByRole("button", { name: "Widget", exact: true }).click();
  const openCluster = (name) => page.locator(".cluster-rail").getByRole("button", { name: new RegExp(` ${name}$`) }).click();
  const setQuery = async (query) => {
    if (!await search.isVisible()) await page.locator(".main-area .table-search-toggle").click();
    await search.fill(query);
  };
  const assertState = async (query, names) => {
    await page.waitForFunction(({ query, names }) => {
      const input = document.querySelector(".main-area .table-search input");
      const table = document.querySelector(".main-area .resource-table-wrap");
      const visible = [...document.querySelectorAll(".main-area tbody tr[data-index] .name-col")].map((cell) => cell.textContent.trim()).sort();
      return input?.value === query && table?.dataset.rowCount === String(names.length)
        && JSON.stringify(visible) === JSON.stringify(names.slice().sort());
    }, { query, names });
    if (query) assert(await search.isVisible(), "A restored filter must be visible");
  };

  try {
    await page.goto(process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420", { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });
    await openCluster("search-alpha");
    await openResource("Pods");
    await assertState("", rowNames[0]);
    await setQuery("API");
    // No Enter or explicit save: typing must survive the very next navigation.
    await openResource("Deployments");
    await assertState("", rowNames[1]);
    await setQuery("web");
    await openResource("Pods");
    await assertState("API", ["api-server"]);
    assert(!await search.evaluate((input) => document.activeElement === input), "Restoration must not steal focus");
    assert.equal(await page.locator(".table-search-history").count(), 0);

    // Clearing one list must persist without touching the other list's query.
    await page.locator(".main-area .table-search-clear").click();
    await assertState("", rowNames[0]);
    assert(await search.evaluate((input) => document.activeElement === input));
    await openResource("Deployments");
    await assertState("web", ["web-app"]);
    await openResource("Pods");
    await assertState("", rowNames[0]);
    await setQuery("no-matching-resource");
    await assertState("no-matching-resource", []);
    await openResource("Deployments");
    await openResource("Pods");
    await assertState("no-matching-resource", []);

    // Pinned tabs and Overview use the same per-resource state as previews.
    await setQuery("API");
    await nav.getByRole("button", { name: "Pods", exact: true }).dblclick();
    await nav.getByRole("button", { name: "Deployments", exact: true }).dblclick();
    const tabs = page.locator(".workspace-tab-list-content");
    await tabs.getByRole("button", { name: /^Pods/ }).click();
    await assertState("API", ["api-server"]);
    await tabs.getByRole("button", { name: /^Deployments/ }).click();
    await assertState("web", ["web-app"]);
    await tabs.getByRole("button", { name: "Overview", exact: true }).click();
    await tabs.getByRole("button", { name: /^Pods/ }).click();
    await assertState("API", ["api-server"]);

    // Full CRD names isolate kinds that share a display name across API groups.
    await nav.locator('.nav-custom-group-toggle[aria-label="example.com"]').click();
    await nav.locator('.nav-custom-group-toggle[aria-label="other.com"]').click();
    await openCustomResource("example.com");
    await assertState("", rowNames[2]);
    await setQuery("alpha");
    await openCustomResource("other.com");
    await assertState("", rowNames[3]);
    await setQuery("delta");
    await openCustomResource("example.com");
    await assertState("alpha", ["alpha-widget"]);
    await openResource("Pods");
    await assertState("API", ["api-server"]);
    await openCustomResource("other.com");
    await assertState("delta", ["delta-widget"]);

    await openCluster("search-beta");
    await openResource("Pods");
    await assertState("", rowNames[0]);
    await setQuery("worker");
    await openCluster("search-alpha");
    await assertState("delta", ["delta-widget"]);
    await openResource("Pods");
    await assertState("API", ["api-server"]);
    await openCluster("search-beta");
    await assertState("worker", ["worker-runner"]);
    await page.locator(".brand-mark").click();
    await openCluster("search-alpha");
    await assertState("API", ["api-server"]);

    // Workspace reload restores values too, while a cleared query stays clear.
    await page.locator(".main-area .table-search-clear").click();
    await assertState("", rowNames[0]);
    await page.reload({ waitUntil: "networkidle" });
    await openCluster("search-alpha");
    await assertState("", rowNames[0]);
    await openResource("Deployments");
    await assertState("web", ["web-app"]);
    await openCluster("search-beta");
    await assertState("worker", ["worker-runner"]);
    assert.deepEqual(errors, []);
    console.log("Search state verified: previews, pinned tabs, Overview, clearing, empty results, CRD identity, cluster isolation, home and reload.");
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
