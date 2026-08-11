const { chromium } = require("playwright");

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://localhost:1420";
const mockCluster = {
  id: "bulk-actions", name: "bulk-actions", provider: "Local", region: "local", version: "v1.30",
  status: "healthy", nodes: 1, cpu: 2, memory: 4, context: "bulk-actions",
  server: "https://127.0.0.1:6443", defaultNamespace: "default", imported: true,
  disconnected: false, error: null,
};
const mockDescriptors = [
  { apiVersion: "v1", group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, verbs: ["get", "list", "watch", "create", "delete"], categories: ["all"] },
  { apiVersion: "apps/v1", group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true, verbs: ["get", "list", "watch", "create", "delete"], categories: ["all"] },
];
const mockResource = (name, kind, apiVersion = "v1") => ({
  key: `${kind.toLowerCase()}s/default/${name}`, name, namespace: "default", apiVersion, kind,
  resourceVersion: "1", ageSeconds: 120,
  object: { apiVersion, kind, metadata: { name, namespace: "default" }, spec: {}, status: { phase: kind === "Pod" ? "Running" : undefined } },
});
const mockRows = {
  Pod: [mockResource("api-0", "Pod"), mockResource("worker-0", "Pod"), mockResource("worker-1", "Pod")],
  Deployment: [mockResource("api", "Deployment", "apps/v1")],
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));

  await page.addInitScript((mock) => {
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        switch (command) {
          case "backend_info": return { name: "kubehive", runtime: "mock", kubernetesClient: "mock", mode: "test" };
          case "list_clusters": return [mock.cluster];
          case "probe_cluster": return mock.cluster;
          case "discover_resources": return mock.descriptors;
          case "list_resources": return { resourceVersion: "1", items: mock.rows[args?.request?.resource?.kind] ?? [] };
          case "start_resource_watch": return "mock-watch";
          case "stop_resource_watch": return true;
          case "list_port_forwards": return [];
          case "cluster_overview": return { clusterId: mock.cluster.id, version: "v1.30", nodes: 1, readyNodes: 1, cpuPercent: 0, memoryPercent: 0, pods: 3, runningPods: 3, podCapacity: 10, storageBytes: 0, storageCapacityBytes: 1, workloadHealth: { total: 0, healthy: 0, degraded: 0, failed: 0 }, nodeUsage: [], issues: [], events: [], updatedAt: new Date().toISOString() };
          case "evict_pods": throw new Error("Mock bulk eviction failure");
          default: return null;
        }
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    };
  }, { cluster: mockCluster, descriptors: mockDescriptors, rows: mockRows });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".cluster-home-avatar").click();
  await page.locator('.resource-nav nav button[aria-label="Pods"]').click();

  const table = page.locator(".resource-table-wrap.virtualized");
  await table.locator("tbody tr[data-index]").first().waitFor();
  const refreshButton = page.locator(".table-toolbar .resource-toolbar-refresh");
  const automaticUpdates = await page.getByRole("button", { name: "Toggle auto-refresh", exact: true }).count() === 0
    && await page.getByText("Auto-refresh", { exact: true }).count() === 0
    && await refreshButton.count() === 1
    && await refreshButton.getAttribute("aria-label") === "Refresh"
    && await refreshButton.getAttribute("title") === "Reload the current snapshot and re-establish live updates"
    && await refreshButton.evaluate((button) => button.textContent.trim() === "" && button.getBoundingClientRect().width === button.getBoundingClientRect().height)
    && await page.locator(".page-head .head-actions").getByRole("button", { name: "Refresh", exact: true }).count() === 0
    && await page.locator(".resource-toolbar-divider").count() === 0;
  const rows = table.locator("tbody tr[data-index]");
  const firstTwo = rows.locator(".resource-selection-checkbox");
  await firstTwo.nth(0).click();
  await firstTwo.nth(1).click();

  const bulkBar = page.locator(".bulk-resource-actions");
  const twoSelected = await bulkBar.getByText("2 selected", { exact: true }).isVisible();
  const toolbarLayout = await page.locator(".table-toolbar").evaluate((toolbar) => {
    const bulk = toolbar.querySelector(".bulk-resource-actions");
    const divider = toolbar.querySelector(".resource-toolbar-divider");
    const refresh = toolbar.querySelector(".resource-toolbar-refresh");
    if (!bulk || !divider || !refresh) return false;
    const toolbarBox = toolbar.getBoundingClientRect();
    const bulkBox = bulk.getBoundingClientRect();
    const dividerBox = divider.getBoundingClientRect();
    const refreshBox = refresh.getBoundingClientRect();
    return refreshBox.right >= toolbarBox.right - 12
      && bulkBox.right < dividerBox.left
      && dividerBox.right < refreshBox.left
      && dividerBox.width === 1
      && dividerBox.height > 0;
  });
  const mobileToolbarLayout = await (async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const layout = await page.locator(".table-toolbar").evaluate((toolbar) => {
      const bulk = toolbar.querySelector(".bulk-resource-actions");
      const divider = toolbar.querySelector(".resource-toolbar-divider");
      const refresh = toolbar.querySelector(".resource-toolbar-refresh");
      if (!bulk || !divider || !refresh) return false;
      const toolbarBox = toolbar.getBoundingClientRect();
      const bulkBox = bulk.getBoundingClientRect();
      const dividerBox = divider.getBoundingClientRect();
      const refreshBox = refresh.getBoundingClientRect();
      return toolbar.scrollWidth <= toolbar.clientWidth
        && refreshBox.right >= toolbarBox.right - 12
        && dividerBox.width >= toolbarBox.width - 20
        && dividerBox.height === 1
        && refreshBox.bottom <= dividerBox.top
        && dividerBox.bottom <= bulkBox.top;
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    return layout;
  })();
  const podActions = {
    evict: await bulkBar.getByRole("button", { name: "Evict", exact: true }).isVisible(),
    delete: await bulkBar.getByRole("button", { name: "Delete", exact: true }).isVisible(),
    noToolbarClose: await bulkBar.getByRole("button", { name: /Clear resource selection|Dismiss bulk action result/ }).count() === 0,
    checkboxDidNotOpenDetails: await page.locator(".sheet-right").count() === 0,
  };

  await bulkBar.getByRole("button", { name: "Evict", exact: true }).click();
  const dialog = page.locator(".bulk-resource-dialog");
  await dialog.waitFor();
  const evictionDialog = await dialog.evaluate((element) => ({
    title: element.querySelector("h2")?.textContent === "Evict selected Pods",
    count: element.textContent.includes("2 resources selected"),
    pdb: element.textContent.includes("PodDisruptionBudget"),
    policy: element.textContent.includes("policy/v1 Eviction"),
  }));
  await dialog.getByRole("button", { name: "Evict Pods", exact: true }).click();
  const mockEvictionError = await dialog.getByRole("alert").getByText("Mock bulk eviction failure", { exact: false }).isVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await bulkBar.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.waitFor();
  const deleteDialog = await dialog.evaluate((element) => ({
    title: element.querySelector("h2")?.textContent === "Delete selected resources",
    count: element.textContent.includes("2 resources selected"),
    bounded: element.textContent.includes("bounded concurrency"),
  }));
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  const total = Number(await table.getAttribute("data-row-count"));
  const selectAllCheckbox = page.getByRole("checkbox", { name: "Select all visible resources", exact: true });
  await selectAllCheckbox.click();
  const selectAll = await bulkBar.getByText(`${total} selected`, { exact: true }).isVisible();
  await selectAllCheckbox.click();
  const cleared = await page.locator(".bulk-resource-actions").count() === 0
    && await selectAllCheckbox.getAttribute("data-state") === "unchecked";

  await page.locator('.resource-nav nav button[aria-label="Deployments"]').click();
  const deploymentTable = page.locator(".resource-table-wrap.virtualized");
  await deploymentTable.locator("tbody tr[data-index]").first().waitFor();
  await deploymentTable.locator("tbody tr[data-index] .resource-selection-checkbox").first().click();
  const deploymentBar = page.locator(".bulk-resource-actions");
  const deploymentActions = {
    delete: await deploymentBar.getByRole("button", { name: "Delete", exact: true }).isVisible(),
    noEvict: await deploymentBar.getByRole("button", { name: "Evict", exact: true }).count() === 0,
  };

  await page.locator('.resource-nav nav button[aria-label="Port Forwarding"]').click();
  await page.locator(".page-head h1").getByText("Port Forwarding", { exact: true }).waitFor();
  const pseudoResourceExcluded = await page.getByRole("checkbox", { name: "Select all visible resources", exact: true }).count() === 0;

  const results = {
    automaticUpdates,
    twoSelected,
    toolbarLayout,
    mobileToolbarLayout,
    podActions,
    evictionDialog,
    mockEvictionError,
    deleteDialog,
    selectAll,
    cleared,
    deploymentActions,
    pseudoResourceExcluded,
    runtimeErrors,
  };
  console.log(JSON.stringify(results, null, 2));

  const passed = automaticUpdates
    && twoSelected
    && toolbarLayout
    && mobileToolbarLayout
    && Object.values(podActions).every(Boolean)
    && Object.values(evictionDialog).every(Boolean)
    && mockEvictionError
    && Object.values(deleteDialog).every(Boolean)
    && selectAll
    && cleared
    && Object.values(deploymentActions).every(Boolean)
    && pseudoResourceExcluded
    && runtimeErrors.length === 0;

  await browser.close();
  if (!passed) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
