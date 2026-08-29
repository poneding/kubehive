const { chromium } = require("playwright");

const CLUSTER = {
  id: "demo", name: "demo-cluster", provider: "Local", region: "local", version: "v1.29",
  status: "healthy", nodes: 1, cpu: 2, memory: 4, context: "demo",
  server: "https://127.0.0.1:6443", defaultNamespace: "default", imported: true,
  disconnected: false, error: null,
};
const DESCRIPTORS = [
  { apiVersion: "v1", group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, verbs: ["get", "list", "watch"], categories: ["all"] },
  { apiVersion: "apps/v1", group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true, verbs: ["get", "list", "watch"], categories: ["all"] },
];
const ROWS = {
  Pod: [{ key: "pods/api-server", name: "api-server", namespace: "default", apiVersion: "v1", kind: "Pod", resourceVersion: "1", ageSeconds: 120, object: { metadata: { name: "api-server", namespace: "default" }, status: { phase: "Running" } } }],
  Deployment: [{ key: "deployments/api-server", name: "api-server", namespace: "default", apiVersion: "apps/v1", kind: "Deployment", resourceVersion: "1", ageSeconds: 120, object: { metadata: { name: "api-server", namespace: "default" }, status: { replicas: 1, readyReplicas: 1 } } }],
};

(async () => {
  const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`page: ${error.stack || error.message}`));
  await page.addInitScript((mock) => {
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        switch (cmd) {
          case "backend_info": return { name: "kubehive", runtime: "mock", kubernetesClient: "mock", mode: "dev" };
          case "list_clusters": return [mock.cluster];
          case "probe_cluster": return mock.cluster;
          case "discover_resources": return mock.descriptors;
          case "list_resources": return { resourceVersion: "1", items: mock.rows[args?.request?.resource?.kind] || [] };
          case "pod_metrics": return null;
          default: throw new Error(`unmocked command: ${cmd}`);
        }
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    };
  }, { cluster: CLUSTER, descriptors: DESCRIPTORS, rows: ROWS });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".cluster-home-avatar").first().click();
    await page.getByRole("button", { name: "Pods", exact: true }).click();
    await page.locator("tbody tr[data-index]").first().waitFor();

    const search = page.getByRole("combobox", { name: "Search resources Pods" });
    await page.getByRole("button", { name: "Search resources Pods" }).click();
    await search.fill("api");
    await search.press("Enter");
    await search.fill("");
    const panelVisible = await page.getByRole("listbox", { name: "Recent searches" }).isVisible();
    const firstHistory = await page.getByRole("option", { name: "api" }).isVisible();

    await search.fill("default");
    await search.press("Enter");
    await page.evaluate(() => localStorage.setItem("kubehive.searchHistory.resources:other-cluster", JSON.stringify(["other-cluster-only"])));
    await page.getByRole("button", { name: "Deployments", exact: true }).click();
    await page.locator("tbody tr[data-index]").first().waitFor();
    await page.getByRole("button", { name: "Search resources Deployments" }).click();
    const deploymentSearch = page.getByRole("combobox", { name: "Search resources Deployments" });
    const crossResourceHistory = await page.getByRole("option").allTextContents();
    const foreignHistoryHidden = !crossResourceHistory.includes("other-cluster-only");
    const desktopBounds = await page.locator(".table-search-history").boundingBox();
    if (process.env.KUBEHIVE_SEARCH_HISTORY_SCREENSHOT) await page.screenshot({ path: process.env.KUBEHIVE_SEARCH_HISTORY_SCREENSHOT });
    await page.setViewportSize({ width: 375, height: 812 });
    const closeNavigation = page.getByRole("button", { name: "Close navigation" });
    if (await closeNavigation.isVisible()) await closeNavigation.click();
    await page.locator(".table-search-toggle").click();
    const mobileBounds = await page.locator(".table-search-history").boundingBox();
    if (process.env.KUBEHIVE_SEARCH_HISTORY_SCREENSHOT) await page.screenshot({ path: process.env.KUBEHIVE_SEARCH_HISTORY_SCREENSHOT.replace(/(\.[^.]+)$/, "-mobile$1") });
    const mobileFits = Boolean(mobileBounds && mobileBounds.x >= 0 && mobileBounds.x + mobileBounds.width <= 375);
    await page.setViewportSize({ width: 1440, height: 900 });
    await deploymentSearch.press("ArrowDown");
    await deploymentSearch.press("Enter");
    const keyboardApplied = await deploymentSearch.inputValue() === "default";

    await deploymentSearch.fill("");
    await page.getByRole("button", { name: "Remove api from search history" }).click();
    const afterRemove = await page.evaluate(() => JSON.parse(localStorage.getItem("kubehive.searchHistory.resources:demo") || "[]"));
    await page.getByRole("button", { name: "Clear all" }).click();
    const afterClear = await page.evaluate(() => JSON.parse(localStorage.getItem("kubehive.searchHistory.resources:demo") || "[]"));
    const foreignHistoryPreserved = await page.evaluate(() => JSON.parse(localStorage.getItem("kubehive.searchHistory.resources:other-cluster") || "[]"));
    const panelClosedAfterClear = await page.locator(".table-search-history").count() === 0;

    const desktopAligned = Boolean(desktopBounds && desktopBounds.width === 260);
    const result = { panelVisible, firstHistory, crossResourceHistory, foreignHistoryHidden, desktopBounds, desktopAligned, mobileBounds, mobileFits, keyboardApplied, afterRemove, afterClear, foreignHistoryPreserved, panelClosedAfterClear, errors };
    console.log(JSON.stringify(result, null, 2));
    const passed = panelVisible && firstHistory && crossResourceHistory.join("|") === "default|api" && foreignHistoryHidden && desktopAligned && mobileFits && keyboardApplied && afterRemove.join("|") === "default" && afterClear.length === 0 && foreignHistoryPreserved.join("|") === "other-cluster-only" && panelClosedAfterClear && errors.length === 0;
    if (!passed) process.exit(1);
  } finally {
    await browser.close();
  }
})();
