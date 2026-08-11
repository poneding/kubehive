const { chromium } = require("playwright");

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";
const cluster = {
  id: "ui-smoke",
  name: "ui-smoke",
  provider: "Local",
  region: "test",
  version: "v1.31.0",
  status: "healthy",
  nodes: 2,
  cpu: 18,
  memory: 31,
  context: "ui-smoke",
  server: "https://127.0.0.1:6443",
  defaultNamespace: "default",
  imported: true,
  disconnected: false,
  error: null,
};

const descriptors = [
  {
    apiVersion: "v1",
    group: "",
    version: "v1",
    kind: "Pod",
    plural: "pods",
    namespaced: true,
    verbs: ["get", "list", "watch", "create", "delete"],
    categories: ["all"],
  },
];

const pods = [
  {
    key: "pods/default/api-0",
    name: "api-0",
    namespace: "default",
    uid: "api-0-uid",
    resourceVersion: "1",
    apiVersion: "v1",
    kind: "Pod",
    ageSeconds: 120,
    object: {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "api-0", namespace: "default", uid: "api-0-uid" },
      spec: { containers: [{ name: "api", image: "example.test/api:1.0" }] },
      status: { phase: "Running" },
    },
  },
  {
    key: "pods/default/worker-0",
    name: "worker-0",
    namespace: "default",
    uid: "worker-0-uid",
    resourceVersion: "1",
    apiVersion: "v1",
    kind: "Pod",
    ageSeconds: 90,
    object: {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "worker-0", namespace: "default", uid: "worker-0-uid" },
      spec: { containers: [{ name: "worker", image: "example.test/worker:1.0" }] },
      status: { phase: "Running" },
    },
  },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const runtimeErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));

  await page.addInitScript((fixture) => {
    const state = {
      cluster: fixture.cluster,
      descriptors: fixture.descriptors,
      pods: fixture.pods,
      evictAttempts: 0,
      evictions: [],
      proxyUpdates: [],
    };
    window.__kubehiveVerifyUi = state;
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        switch (command) {
          case "backend_info":
            return { name: "kubehive", runtime: "mock", kubernetesClient: "mock", mode: "test" };
          case "list_clusters":
            return [state.cluster];
          case "probe_cluster":
          case "reconnect_cluster":
            return state.cluster;
          case "discover_resources":
            return state.descriptors;
          case "cluster_overview":
            return {
              clusterId: state.cluster.id,
              version: state.cluster.version,
              nodes: state.cluster.nodes,
              readyNodes: state.cluster.nodes,
              cpuPercent: state.cluster.cpu,
              memoryPercent: state.cluster.memory,
              pods: state.pods.length,
              runningPods: state.pods.length,
              podCapacity: 10,
              storageBytes: 0,
              storageCapacityBytes: 1,
              workloadHealth: { total: 0, healthy: 0, degraded: 0, failed: 0 },
              nodeUsage: [],
              issues: [],
              events: [],
              updatedAt: new Date().toISOString(),
            };
          case "list_resources":
            return {
              resourceVersion: String(state.evictions.length + 1),
              items: args?.request?.resource?.kind === "Pod" ? state.pods : [],
            };
          case "get_resource": {
            const item = state.pods.find((pod) => pod.name === args?.target?.name && pod.namespace === args?.target?.namespace);
            if (!item) throw new Error("Mock resource not found");
            return {
              ...item,
              manifest: `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${item.name}\n  namespace: ${item.namespace}\nspec:\n  containers:\n    - name: ${item.object.spec.containers[0].name}`,
            };
          }
          case "pod_metrics":
          case "node_metrics":
            return null;
          case "start_resource_watch":
            return "mock-watch";
          case "stop_resource_watch":
            return true;
          case "list_port_forwards":
            return [];
          case "set_network_proxy":
            state.proxyUpdates.push(args);
            return null;
          case "evict_pod": {
            state.evictAttempts += 1;
            if (state.evictAttempts === 1) throw new Error("Mock eviction failure");
            const request = args?.request;
            state.evictions.push(request);
            state.pods = state.pods.filter((pod) => pod.name !== request?.pod || pod.namespace !== request?.namespace);
            return null;
          }
          case "disconnect_cluster":
          case "cancel_cluster_connection":
            return true;
          default:
            throw new Error(`unmocked command: ${command}`);
        }
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    };
  }, { cluster, descriptors, pods });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("kubehive.preferences", JSON.stringify({ autoUpdate: false }));
    });
    await page.reload({ waitUntil: "networkidle" });

    const home = page.locator(".cluster-home");
    const clusterAvatar = home.locator(".cluster-home-avatar").first();
    await home.waitFor();
    await clusterAvatar.waitFor();
    const clusterAction = page.getByRole("button", { name: "Actions ui-smoke", exact: true });
    await clusterAction.click();
    const clusterMenu = page.locator(".app-context-menu");
    await clusterMenu.waitFor();
    const clusterActions = await clusterMenu.getByRole("menuitem").allTextContents();
    const clusterMenuWorks = ["Open overview", "Close connection", "Settings", "Remove"].every((label) => clusterActions.includes(label));
    await page.keyboard.press("Escape");
    await clusterMenu.waitFor({ state: "detached" });

    await clusterAvatar.click();
    const resourceNav = page.locator(".resource-nav");
    await resourceNav.waitFor();
    await page.getByRole("button", { name: "Pods", exact: true }).click();
    const table = page.locator(".resource-table-wrap.virtualized");
    const apiRow = table.locator("tbody tr[data-index]").filter({ hasText: "api-0" });
    await apiRow.waitFor();
    const resourceListWorks = await table.getAttribute("data-row-count") === "2"
      && await apiRow.count() === 1
      && await table.locator("tbody tr[data-index]").filter({ hasText: "worker-0" }).count() === 1;

    await apiRow.click({ button: "right" });
    const rowMenu = page.locator(".app-context-menu");
    await rowMenu.getByRole("menuitem", { name: "Evict", exact: true }).click();
    const evictionDialog = page.getByRole("dialog", { name: "Evict Pod", exact: true });
    await evictionDialog.waitFor();
    const contextMenuDialog = await evictionDialog.evaluate((dialog) => ({
      modal: dialog.getAttribute("aria-modal") === "true",
      target: dialog.querySelector(".resource-delete-target strong")?.textContent === "api-0",
      policy: dialog.textContent?.includes("policy/v1 Eviction") === true,
      cancelFocused: dialog.querySelector("footer button:focus")?.textContent?.trim() === "Cancel",
    }));
    await evictionDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await evictionDialog.waitFor({ state: "detached" });
    const cancelledWithoutInvoke = await page.evaluate(() => window.__kubehiveVerifyUi.evictAttempts === 0);

    await apiRow.locator("td:not(.selection-col)").first().click();
    const detail = page.locator(".sheet-right");
    await detail.waitFor();
    await detail.getByRole("button", { name: "Evict", exact: true }).click();
    await evictionDialog.waitFor();
    await evictionDialog.getByRole("button", { name: "Evict", exact: true }).click();
    const error = evictionDialog.getByRole("alert");
    await error.waitFor();
    const failedEvictionStaysOpen = await error.textContent() === "Mock eviction failure"
      && await evictionDialog.isVisible()
      && await page.evaluate(() => window.__kubehiveVerifyUi.evictAttempts === 1);

    await evictionDialog.getByRole("button", { name: "Evict", exact: true }).click();
    await evictionDialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__kubehiveVerifyUi.evictions.length === 1);
    await page.waitForFunction(() => ![...document.querySelectorAll(".resource-table tbody tr[data-index]")].some((row) => row.textContent?.includes("api-0")));
    const successfulEviction = await page.evaluate(() => {
      const state = window.__kubehiveVerifyUi;
      return state.evictions.length === 1
        && state.evictions[0]?.clusterId === "ui-smoke"
        && state.evictions[0]?.namespace === "default"
        && state.evictions[0]?.pod === "api-0";
    });
    const successToast = await page.getByRole("status").filter({ hasText: "Eviction requested for Pod/api-0" }).isVisible();
    const refreshedRows = await table.locator("tbody tr[data-index]").count() === 1;
    const detailClosed = await detail.count() === 0;

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.locator(".settings-modal");
    await settings.waitFor();
    const proxy = settings.getByRole("switch", { name: "Enable proxy", exact: true });
    const proxyUpdatesBefore = await page.evaluate(() => window.__kubehiveVerifyUi.proxyUpdates.length);
    await proxy.click();
    await page.waitForFunction((before) => window.__kubehiveVerifyUi.proxyUpdates.length > before, proxyUpdatesBefore);
    const proxyPayloadWorks = await page.evaluate((before) => {
      const update = window.__kubehiveVerifyUi.proxyUpdates.slice(before).at(-1);
      return update?.settings?.enabled === true && update?.settings?.url === "http://127.0.0.1:7890";
    }, proxyUpdatesBefore);
    const settingsToggleWorks = proxyPayloadWorks
      && await proxy.getAttribute("data-state") === "checked"
      && await proxy.getAttribute("aria-checked") === "true";
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await settings.waitFor({ state: "detached" });

    const result = {
      clusterMenuWorks,
      resourceListWorks,
      contextMenuDialog,
      cancelledWithoutInvoke,
      failedEvictionStaysOpen,
      successfulEviction,
      successToast,
      refreshedRows,
      detailClosed,
      settingsToggleWorks,
      runtimeErrors,
    };
    console.log(JSON.stringify(result, null, 2));

    const passed = clusterMenuWorks
      && resourceListWorks
      && Object.values(contextMenuDialog).every(Boolean)
      && cancelledWithoutInvoke
      && failedEvictionStaysOpen
      && successfulEviction
      && successToast
      && refreshedRows
      && detailClosed
      && settingsToggleWorks
      && runtimeErrors.length === 0;
    if (!passed) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
