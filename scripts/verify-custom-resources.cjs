// Verifies that installed CRDs are listed under the Custom Resources group and
// that their instances support the manifest editor and deletion.
const { chromium } = require("playwright");

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";

const mockCluster = {
  id: "custom-resources", name: "custom-resources", provider: "Local", region: "local", version: "v1.31.0",
  status: "healthy", nodes: 1, cpu: 5, memory: 12, context: "custom-resources",
  server: "https://127.0.0.1:6443", defaultNamespace: "default", imported: true,
  disconnected: false, error: null,
};

const readWrite = ["get", "list", "watch", "create", "patch", "update", "delete"];
const mockDescriptors = [
  { apiVersion: "v1", group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, verbs: readWrite, categories: ["all"] },
  { apiVersion: "v1", group: "", version: "v1", kind: "Namespace", plural: "namespaces", namespaced: false, verbs: readWrite, categories: [] },
  { apiVersion: "apiextensions.k8s.io/v1", group: "apiextensions.k8s.io", version: "v1", kind: "CustomResourceDefinition", plural: "customresourcedefinitions", namespaced: false, verbs: readWrite, categories: [] },
  // Aggregated APIs and kinds with their own navigation entry stay out of the group.
  { apiVersion: "metrics.k8s.io/v1beta1", group: "metrics.k8s.io", version: "v1beta1", kind: "PodMetrics", plural: "pods", namespaced: true, verbs: ["get", "list"], categories: [] },
  { apiVersion: "autoscaling.k8s.io/v1", group: "autoscaling.k8s.io", version: "v1", kind: "VerticalPodAutoscaler", plural: "verticalpodautoscalers", namespaced: true, verbs: readWrite, categories: [] },
  { apiVersion: "example.com/v1", group: "example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true, verbs: readWrite, categories: [] },
  { apiVersion: "example.com/v1", group: "example.com", version: "v1", kind: "ClusterWidget", plural: "clusterwidgets", namespaced: false, verbs: ["get", "list", "watch"], categories: [] },
  { apiVersion: "cdi.kubevirt.io/v1beta1", group: "cdi.kubevirt.io", version: "v1beta1", kind: "DataVolume", plural: "datavolumes", namespaced: true, verbs: readWrite, categories: [] },
];

const widgetCrd = {
  key: "customresourcedefinitions/widgets.example.com", name: "widgets.example.com", namespace: "—",
  apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition", resourceVersion: "1", ageSeconds: 3600,
  object: {
    apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition",
    metadata: { name: "widgets.example.com" },
    spec: {
      group: "example.com", scope: "Namespaced",
      names: { kind: "Widget", plural: "widgets" },
      versions: [{
        name: "v1", served: true, storage: true,
        additionalPrinterColumns: [{ name: "Phase", jsonPath: ".status.phase", type: "string", priority: 0 }],
      }],
    },
  },
};

const widget = (name, phase) => ({
  key: `widgets/default/${name}`, name, namespace: "default", uid: `${name}-uid`, resourceVersion: "2",
  apiVersion: "example.com/v1", kind: "Widget", ageSeconds: 300,
  object: {
    apiVersion: "example.com/v1", kind: "Widget",
    metadata: { name, namespace: "default", uid: `${name}-uid` },
    spec: { replicas: 2 }, status: { phase },
  },
});

const mockWidgets = [widget("alpha", "Ready"), widget("beta", "Pending")];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));

  await page.addInitScript((mock) => {
    const state = { widgets: mock.widgets, deletions: [], applied: [], crdReads: [] };
    window.__kubehiveVerifyCustomResources = state;
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        switch (command) {
          case "backend_info": return { name: "kubehive", runtime: "mock", kubernetesClient: "mock", mode: "test" };
          case "list_clusters": return [mock.cluster];
          case "probe_cluster":
          case "reconnect_cluster": return mock.cluster;
          case "discover_resources": return mock.descriptors;
          case "cluster_overview": return {
            clusterId: mock.cluster.id, version: mock.cluster.version, nodes: 1, readyNodes: 1, cpuPercent: 5, memoryPercent: 12,
            pods: 1, runningPods: 1, podCapacity: 10, storageBytes: 0, storageCapacityBytes: 1,
            workloadHealth: { total: 0, healthy: 0, degraded: 0, failed: 0 }, nodeUsage: [], issues: [], events: [],
            updatedAt: new Date().toISOString(),
          };
          case "list_resources": {
            const kind = args?.request?.resource?.kind;
            if (kind === "Widget") return { resourceVersion: "2", items: state.widgets };
            if (kind === "Namespace") return { resourceVersion: "1", items: [{ key: "namespaces/default", name: "default", namespace: "—", apiVersion: "v1", kind: "Namespace", object: {} }] };
            if (kind === "CustomResourceDefinition") return { resourceVersion: "1", items: [mock.widgetCrd] };
            return { resourceVersion: "1", items: [] };
          }
          case "get_resource": {
            const target = args?.target;
            if (target?.resource?.kind === "CustomResourceDefinition") {
              state.crdReads.push(target.name);
              // Only the Widget definition is readable; ClusterWidget must fall
              // back to discovery like a cluster that forbids reading CRDs.
              if (target.name !== "widgets.example.com") throw new Error("customresourcedefinitions is forbidden");
              return { ...mock.widgetCrd, manifest: "apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\n" };
            }
            const item = state.widgets.find((entry) => entry.name === target?.name);
            if (!item) throw new Error("Mock resource not found");
            return { ...item, manifest: `apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: ${item.name}\n  namespace: ${item.namespace}\nspec:\n  replicas: 2\n` };
          }
          case "delete_resource":
            state.deletions.push(args?.request);
            state.widgets = state.widgets.filter((entry) => entry.name !== args?.request?.name);
            return null;
          case "apply_manifest": {
            state.applied.push(args?.request);
            const item = state.widgets[0];
            return { ...item, manifest: args?.request?.manifest ?? "" };
          }
          case "start_resource_watch": return "mock-watch";
          case "stop_resource_watch": return true;
          case "list_port_forwards": return [];
          default: return null;
        }
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    };
  }, { cluster: mockCluster, descriptors: mockDescriptors, widgetCrd, widgets: mockWidgets });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("kubehive.preferences", JSON.stringify({ autoUpdate: false }));
  });
  await page.reload({ waitUntil: "networkidle" });

  const clusterAvatar = page.locator(".cluster-home-avatar").first();
  await clusterAvatar.waitFor();
  await clusterAvatar.click();

  const nav = page.locator(".resource-nav");
  await nav.waitFor();
  const customSection = nav.locator("nav section").filter({ has: page.getByText("Custom Resources", { exact: true }) });
  const apiGroups = customSection.locator(".nav-custom-group-toggle");
  await apiGroups.first().waitFor();
  const navEntries = {
    groups: await apiGroups.evaluateAll((buttons) => buttons.map((button) => `${button.getAttribute("aria-label")}:${button.querySelector("small")?.textContent}:${button.getAttribute("aria-expanded")}`)),
    // Every group starts collapsed, so only the static item is reachable.
    visibleItems: await customSection.locator("button:not(.nav-custom-group-toggle)").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
  };
  const navListing = navEntries.groups.join(",") === "cdi.kubevirt.io:1:false,example.com:2:false"
    && navEntries.visibleItems.join(",") === "Custom Resource Definitions";

  await apiGroups.filter({ hasText: "example.com" }).click();
  await customSection.locator('button[aria-label="Widget"]').waitFor();
  const expandedEntries = {
    items: await customSection.locator("button:not(.nav-custom-group-toggle)").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    crdNameTitle: await customSection.locator('button[aria-label="Widget"]').getAttribute("title"),
    otherGroupClosed: await customSection.locator('button[aria-label="DataVolume"]').count() === 0,
  };
  const groupExpansion = expandedEntries.items.join(",") === "Custom Resource Definitions,ClusterWidget,Widget"
    && expandedEntries.crdNameTitle === "widgets.example.com"
    && expandedEntries.otherGroupClosed;

  // Filtering reveals matches that live inside still-collapsed groups.
  await nav.locator(".nav-search input").fill("datavol");
  const filtered = await nav.locator("nav button:not(.nav-custom-group-toggle)").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
  const navFilter = filtered.join(",") === "DataVolume";
  await nav.locator(".nav-search input").fill("");
  await customSection.locator('button[aria-label="DataVolume"]').waitFor({ state: "detached" });

  // The visibility popover buckets installed kinds by API group.
  await nav.getByRole("button", { name: "Configure resource list", exact: true }).click();
  const popover = page.locator(".resource-tree-filter-popover");
  await popover.waitFor();
  const filterSection = popover.locator('section[data-filter-group="Custom Resources"]');
  const filterEntries = {
    count: (await filterSection.locator("> label.resource-tree-filter-group small").textContent())?.trim(),
    items: await filterSection.locator("> div > label > span").allTextContents(),
    apiGroups: await filterSection.locator(".resource-tree-filter-subgroup").evaluateAll((groups) => groups.map((group) => `${group.getAttribute("data-filter-api-group")}:${group.querySelector(".resource-tree-filter-api-group small")?.textContent}:${[...group.querySelectorAll(".resource-tree-filter-api-item > span")].map((item) => item.textContent).join("+")}`)),
    indented: await filterSection.locator(".resource-tree-filter-api-item").first().evaluate((item) => {
      const head = item.parentElement.querySelector(".resource-tree-filter-api-group");
      return item.getBoundingClientRect().left + parseFloat(getComputedStyle(item).paddingLeft) > head.getBoundingClientRect().left + parseFloat(getComputedStyle(head).paddingLeft);
    }),
  };
  // Hiding a whole API group takes one click on its checkbox.
  await filterSection.getByRole("checkbox", { name: "Show group cdi.kubevirt.io", exact: true }).click();
  await page.waitForTimeout(80);
  const groupCleared = (await filterSection.locator('[data-filter-api-group="cdi.kubevirt.io"] .resource-tree-filter-api-group small').textContent())?.trim() === "0/1"
    && (await filterSection.locator("> label.resource-tree-filter-group small").textContent())?.trim() === "3/4";
  await filterSection.getByRole("checkbox", { name: "Show resource Widget", exact: true }).click();
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "detached" });
  const hidden = await customSection.locator('button[aria-label="Widget"]').count() === 0
    && await customSection.locator('button[aria-label="ClusterWidget"]').count() === 1
    // An API group with every kind hidden drops out of the navigation.
    && await apiGroups.filter({ hasText: "cdi.kubevirt.io" }).count() === 0;
  await nav.getByRole("button", { name: "Configure resource list", exact: true }).click();
  await popover.waitFor();
  await popover.getByRole("button", { name: "Show all", exact: true }).click();
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "detached" });
  await customSection.locator('button[aria-label="Widget"]').waitFor();
  const navVisibility = filterEntries.count === "4/4"
    && filterEntries.items.join(",") === "Custom Resource Definitions"
    && filterEntries.apiGroups.join(",") === "cdi.kubevirt.io:1/1:DataVolume,example.com:2/2:ClusterWidget+Widget"
    && filterEntries.indented
    && groupCleared
    && hidden
    && await apiGroups.filter({ hasText: "cdi.kubevirt.io" }).count() === 1;

  await customSection.locator('button[aria-label="Widget"]').click();
  const table = page.locator(".resource-table-wrap.virtualized");
  await table.locator("tbody tr[data-index]").first().waitFor();
  const instancePage = {
    heading: (await page.locator(".page-head h1").textContent())?.trim(),
    eyebrow: (await page.locator(".page-head .eyebrow").textContent())?.trim(),
    summary: (await page.locator(".page-head p").textContent())?.trim(),
    tab: (await page.locator(".workspace-tab-list-content button.active strong").textContent())?.trim(),
    navSelected: await customSection.locator('button[aria-label="Widget"]').evaluate((button) => button.classList.contains("selected")),
    crdListNotSelected: await customSection.locator('button[aria-label="Custom Resource Definitions"]').evaluate((button) => !button.classList.contains("selected")),
    rows: await table.getAttribute("data-row-count"),
    // additionalPrinterColumns come from the CRD object fetched by name.
    printerColumn: await table.locator("thead th").filter({ hasText: "Phase" }).count() === 1,
    printerValue: await table.locator("tbody tr[data-index]").filter({ hasText: "alpha" }).locator("td").filter({ hasText: "Ready" }).count() >= 1,
    apiVersionCell: await table.locator("tbody tr[data-index]").filter({ hasText: "alpha" }).locator("td").filter({ hasText: "example.com/v1" }).count() === 1,
    singleCrdRead: await page.evaluate(() => window.__kubehiveVerifyCustomResources.crdReads.every((name) => name === "widgets.example.com")),
  };
  const instanceListing = instancePage.heading === "Widget"
    && instancePage.eyebrow === "CUSTOM RESOURCE · example.com"
    && instancePage.summary === "widgets.example.com · Namespaced · 2 resources"
    && instancePage.tab === "Widget"
    && instancePage.navSelected
    && instancePage.crdListNotSelected
    && instancePage.rows === "2"
    && instancePage.printerColumn
    && instancePage.printerValue
    && instancePage.apiVersionCell
    && instancePage.singleCrdRead;

  const alphaRow = table.locator("tbody tr[data-index]").filter({ hasText: "alpha" });
  // Collapsing the group that holds the open kind keeps the group marked.
  const exampleGroup = apiGroups.filter({ hasText: "example.com" });
  await exampleGroup.click();
  const collapsedWithActive = await exampleGroup.evaluate((button) => button.classList.contains("has-active") && button.getAttribute("aria-expanded") === "false")
    && await customSection.locator('button[aria-label="Widget"]').count() === 0;
  await exampleGroup.click();
  await customSection.locator('button[aria-label="Widget"]').waitFor();

  await alphaRow.click({ button: "right" });
  const rowMenu = page.locator(".app-context-menu");
  await rowMenu.waitFor();
  const menuItems = await rowMenu.getByRole("menuitem").allTextContents();
  const rowMenuActions = menuItems.join(",") === "Open details,Edit manifest,Delete";

  await rowMenu.getByRole("menuitem", { name: "Edit manifest", exact: true }).click();
  const dock = page.locator(".session-dock");
  await dock.waitFor();
  await dock.locator(".cm-content").waitFor();
  const editorText = (await dock.locator(".cm-content").textContent()) ?? "";
  const editorOpened = editorText.includes("kind: Widget") && editorText.includes("name: alpha")
    && await dock.getByRole("button", { name: "Apply", exact: true }).isEnabled()
    && await dock.locator(".manifest-read-only-notice").count() === 0;
  await dock.locator(".session-tabbar").getByRole("button", { name: /^Close/ }).first().click();

  await alphaRow.click({ button: "right" });
  await rowMenu.waitFor();
  await rowMenu.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const dialog = page.locator(".resource-delete-dialog");
  await dialog.waitFor();
  const dialogTarget = await dialog.locator(".resource-delete-target").evaluate((element) => ({
    name: element.querySelector("strong")?.textContent,
    meta: element.querySelector("small")?.textContent,
  }));
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const deletion = await page.evaluate(() => window.__kubehiveVerifyCustomResources.deletions);
  const deleteRequest = deletion.length === 1
    && deletion[0].name === "alpha"
    && deletion[0].namespace === "default"
    && deletion[0].resource.kind === "Widget"
    && deletion[0].resource.plural === "widgets"
    && deletion[0].resource.apiVersion === "example.com/v1"
    && dialogTarget.name === "alpha"
    && dialogTarget.meta === "Widget · Namespace · default";
  await table.locator("tbody tr[data-index]").filter({ hasText: "alpha" }).waitFor({ state: "detached" });

  // A cluster-scoped kind whose CRD object cannot be read still renders from
  // discovery, and read-only credentials cannot delete it.
  await customSection.locator('button[aria-label="ClusterWidget"]').click();
  await page.locator(".page-head h1").filter({ hasText: "ClusterWidget" }).waitFor();
  const clusterScoped = {
    summary: (await page.locator(".page-head p").textContent())?.trim(),
    namespaceFilter: await page.locator(".table-namespace-combobox").count() === 0,
    createDisabled: await page.locator(".page-head").getByRole("button", { name: "Create", exact: true }).isDisabled(),
  };
  const discoveryFallback = clusterScoped.summary === "clusterwidgets.example.com · Cluster · 0 resources"
    && clusterScoped.namespaceFilter
    && clusterScoped.createDisabled;

  // The resource nav is user-resizable: grid column follows the drag, the
  // filter popover tracks it, and the width survives a reload.
  const paneNavWidth = () => page.locator(".workspace-pane").evaluate((pane) => {
    const nav = pane.querySelector(".resource-nav");
    return Math.round(nav.getBoundingClientRect().width);
  });
  const resizeHandle = page.locator(".nav-resize-handle");
  const dragResize = async (deltaX) => {
    const box = await resizeHandle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + deltaX, box.y + 300, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  };
  const navDefault = await paneNavWidth();
  const resizeHandleA11y = await resizeHandle.getAttribute("role") === "separator"
    && await resizeHandle.getAttribute("aria-orientation") === "vertical";
  await dragResize(60);
  const navWider = await paneNavWidth();
  await page.getByRole("button", { name: "Configure resource list", exact: true }).click();
  await popover.waitFor();
  const popoverWider = Math.round((await popover.boundingBox()).width);
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "detached" });
  const storedWidth = await page.evaluate(() => localStorage.getItem("kubehive.navWidth"));
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".cluster-home-avatar").first().click();
  await page.locator(".resource-nav").waitFor();
  const navAfterReload = await paneNavWidth();
  await dragResize(-500);
  const navClamped = await paneNavWidth();
  await resizeHandle.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(80);
  const navKeyed = await paneNavWidth();
  await resizeHandle.dblclick();
  await page.waitForTimeout(80);
  const navReset = await paneNavWidth();
  const navResize = resizeHandleA11y
    && navDefault === 234
    && navWider === 294
    && popoverWider === 274
    && storedWidth === "294"
    && navAfterReload === 294
    && navClamped === 234
    && navKeyed === 244
    && navReset === 234;

  const results = { navListing, navEntries, groupExpansion, expandedEntries, navFilter, filtered, navVisibility, filterEntries, hidden, instanceListing, instancePage, collapsedWithActive, rowMenuActions, menuItems, editorOpened, deleteRequest, deletion, discoveryFallback, clusterScoped, navDefault, navWider, popoverWider, storedWidth, navAfterReload, navClamped, navKeyed, navReset, navResize, runtimeErrors };
  console.log(JSON.stringify(results, null, 2));

  const passed = navListing && groupExpansion && navFilter && navVisibility && instanceListing && collapsedWithActive && rowMenuActions && editorOpened && deleteRequest && discoveryFallback && navResize && runtimeErrors.length === 0;
  await browser.close();
  if (!passed) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
