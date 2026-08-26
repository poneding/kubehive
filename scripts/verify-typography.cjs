const { chromium } = require("playwright");

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";

const cluster = {
  id: "typography",
  name: "typography",
  provider: "Local",
  region: "test",
  version: "v1.31.0",
  status: "healthy",
  nodes: 2,
  cpu: 18,
  memory: 31,
  context: "typography",
  server: "https://127.0.0.1:6443",
  defaultNamespace: "default",
  imported: true,
  disconnected: false,
  error: null,
};

const descriptors = [{
  apiVersion: "v1",
  group: "",
  version: "v1",
  kind: "Pod",
  plural: "pods",
  namespaced: true,
  verbs: ["get", "list", "watch", "create", "delete"],
  categories: ["all"],
}];

// Long, technical values: labels, annotations, and image addresses are the text
// that regressed hardest at the previous 8-9px sizes.
const pods = [{
  key: "pods/default/checkout-api",
  name: "checkout-api",
  namespace: "default",
  uid: "checkout-api-uid",
  resourceVersion: "1",
  apiVersion: "v1",
  kind: "Pod",
  ageSeconds: 120,
  object: {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "checkout-api",
      namespace: "default",
      uid: "checkout-api-uid",
      labels: {
        "app.kubernetes.io/name": "checkout-api",
        "app.kubernetes.io/component": "api-server",
        "team.example.io/owner": "platform-engineering",
      },
      annotations: {
        "example.io/description": "A deliberately long annotation value verifies that technical text stays readable and wraps instead of overflowing the inspector.",
        "nginx.ingress.kubernetes.io/proxy-read-timeout": "300",
      },
    },
    spec: {
      containers: [{
        name: "api",
        image: "registry.example.internal:5000/platform/checkout-api/worker:2026.08.13-build.abcdef0123456789",
        imagePullPolicy: "IfNotPresent",
        env: [{ name: "LOG_LEVEL", value: "info" }],
      }],
    },
    status: { phase: "Running", containerStatuses: [{ name: "api", ready: true, restartCount: 0, image: "registry.example.internal:5000/platform/checkout-api/worker:2026.08.13-build.abcdef0123456789", state: { running: {} } }] },
  },
}];

(async () => {
  // executablePath lets a workstation without `npx playwright install` reuse a
  // local Chrome/Chromium; CI keeps the bundled browser.
  const browser = await chromium.launch({ headless: true, executablePath: process.env.KUBEHIVE_TEST_BROWSER || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const runtimeErrors = [];
  page.on("console", (message) => {
    // Tauri serves no favicon, so the browser prototype always logs that 404.
    if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico")) runtimeErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));
  await page.addInitScript(({ fixtureCluster, fixtureDescriptors, fixturePods }) => {
    const state = { cluster: fixtureCluster, descriptors: fixtureDescriptors, pods: fixturePods };
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
            return { resourceVersion: "1", items: args?.request?.resource?.kind === "Pod" ? state.pods : [] };
          case "get_resource": {
            const item = state.pods.find((pod) => pod.name === args?.target?.name && pod.namespace === args?.target?.namespace);
            if (!item) throw new Error("Mock resource not found");
            return { ...item, manifest: "apiVersion: v1\nkind: Pod\nmetadata:\n  name: checkout-api" };
          }
          case "pod_metrics":
          case "node_metrics":
            return null;
          case "start_resource_watch":
            return "mock-watch";
          case "list_port_forwards":
            return [];
          case "set_network_proxy":
            return null;
          default:
            return true;
        }
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    };
  }, { fixtureCluster: cluster, fixtureDescriptors: descriptors, fixturePods: pods });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("kubehive.preferences", JSON.stringify({ language: "en", theme: "dark", autoUpdate: false }));
  });
  await page.reload({ waitUntil: "networkidle" });

  // The platform stacks are the whole point of the mono fix: assert the resolved
  // custom properties rather than a single element's computed font.
  const platform = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const classes = [...document.documentElement.classList].filter((name) => name.startsWith("platform-"));
    return {
      platformClass: classes[0] ?? "",
      sans: root.getPropertyValue("--font-sans").trim(),
      mono: root.getPropertyValue("--font-mono").trim(),
      bodyFont: getComputedStyle(document.body).fontFamily,
    };
  });
  const expectedFaces = {
    "platform-windows": { sans: "Segoe UI Variable Text", mono: "Cascadia Mono" },
    "platform-macos": { sans: "-apple-system", mono: "ui-monospace" },
    "platform-linux": { sans: "Inter", mono: "ui-monospace" },
  }[platform.platformClass] ?? { sans: "", mono: "" };
  // A generic `monospace` request is what Windows resolves to a serif CJK face,
  // so the stack must always name a real face before the generic keyword.
  const monoNamesRealFace = platform.mono.split(",")[0].trim().replace(/^"|"$/g, "") !== "monospace";

  await page.locator(".cluster-home-avatar").first().click();
  await page.getByRole("button", { name: "Pods", exact: true }).click();
  const row = page.locator(".resource-table tbody tr[data-index]").filter({ hasText: "checkout-api" });
  await row.waitFor();
  const listTypography = await page.evaluate(() => {
    const size = (selector) => Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
    return {
      tableHeader: size(".resource-table th"),
      rowName: size(".resource-name strong"),
      navItem: size(".resource-nav nav button"),
      pageTitle: size(".page-head h1"),
      badge: size(".ui-badge"),
      searchInput: size(".table-search input"),
    };
  });

  // Plain text cell: the name cell carries an inline copy button that swallows clicks.
  await row.locator("td").nth(6).click();
  await page.locator(".sheet-right").waitFor();
  await page.locator('[data-property-metadata="labels"] code').first().waitFor();

  const sheetTypography = await page.evaluate(() => {
    const read = (selector) => {
      const element = document.querySelector(selector);
      const style = getComputedStyle(element);
      return { size: Number.parseFloat(style.fontSize), family: style.fontFamily };
    };
    return {
      labelKey: read('[data-property-metadata="labels"] code'),
      labelValue: read('[data-property-metadata="labels"] strong'),
      annotationKey: read('[data-property-metadata="annotations"] button strong'),
      annotationValue: read('[data-property-metadata="annotations"] button span'),
      image: read(".detail-image-address code"),
      environment: read(".detail-env-row code"),
      propertyValue: read(".detail-property-value strong"),
      sectionHeading: read(".detail-section-heading h3"),
    };
  });

  const overflow = await page.evaluate(() => {
    const fits = (selector) => [...document.querySelectorAll(selector)].every((element) => element.scrollWidth <= element.clientWidth + 1);
    const noTextClipping = (selector) => [...document.querySelectorAll(selector)].every((element) => element.scrollHeight <= element.clientHeight + 1);
    return {
      drawer: fits(".drawer-body"),
      labels: fits(".detail-label-list"),
      annotations: fits(".detail-annotation-list"),
      image: fits(".detail-image-address"),
      mounts: fits(".detail-mount-table"),
      badges: noTextClipping(".ui-badge"),
      environmentRows: noTextClipping(".detail-env-row"),
      tableCells: noTextClipping(".resource-table td"),
      labelChips: noTextClipping(".detail-label-list > button"),
    };
  });

  // Collapsed metadata must still reveal two label rows at the larger size. Long
  // annotation keys/values legitimately exceed one row, so the annotation list is
  // only required to keep its "Show all" affordance.
  const collapsedMetadata = await page.evaluate(() => {
    const labelList = document.querySelector(".detail-label-list.two-lines");
    const labelStyle = getComputedStyle(labelList);
    const labelBounds = labelList.getBoundingClientRect();
    const labelRows = [...labelList.children].filter((child) => {
      const rect = child.getBoundingClientRect();
      return rect.top >= labelBounds.top - 1 && rect.bottom <= labelBounds.bottom + 1;
    }).length;
    const chipHeight = Math.max(...[...labelList.children].map((child) => child.getBoundingClientRect().height));
    return {
      labelRows,
      collapsedHeight: Number.parseFloat(labelStyle.maxHeight),
      twoChipRows: chipHeight * 2 + Number.parseFloat(labelStyle.rowGap || "0"),
      annotationShowAll: Boolean(document.querySelector('[data-property-metadata="annotations"] .detail-show-all')),
    };
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const narrow = await page.evaluate(() => {
    const fits = (selector) => [...document.querySelectorAll(selector)].every((element) => element.scrollWidth <= element.clientWidth + 1);
    return {
      page: document.documentElement.scrollWidth <= innerWidth,
      drawer: fits(".drawer-body"),
      annotations: fits(".detail-annotation-list"),
      image: fits(".detail-image-address"),
      mounts: fits(".detail-mount-table"),
    };
  });

  const result = { platform, listTypography, sheetTypography, overflow, collapsedMetadata, narrow, runtimeErrors };
  console.log(JSON.stringify(result, null, 2));

  const monoTargets = [sheetTypography.labelKey, sheetTypography.annotationKey, sheetTypography.annotationValue, sheetTypography.image, sheetTypography.environment];
  const expectedMonoFace = expectedFaces.mono;
  const passed = platform.platformClass !== ""
    && platform.sans.includes(expectedFaces.sans)
    && platform.mono.includes(expectedMonoFace)
    && platform.bodyFont.includes(expectedFaces.sans)
    && monoNamesRealFace
    // Every readable string is at least 10px; micro uppercase labels stay >= 9px.
    && listTypography.tableHeader >= 10
    && listTypography.rowName >= 12
    && listTypography.navItem >= 12
    && listTypography.badge >= 11
    && listTypography.searchInput >= 11
    && listTypography.pageTitle >= 20
    && monoTargets.every((target) => target.size >= 10 && target.family.includes(expectedMonoFace))
    && sheetTypography.labelValue.size >= 10
    && sheetTypography.propertyValue.size >= 11
    && sheetTypography.sectionHeading.size >= 12
    && Object.values(overflow).every(Boolean)
    && collapsedMetadata.labelRows >= 2
    && collapsedMetadata.collapsedHeight >= collapsedMetadata.twoChipRows
    && collapsedMetadata.annotationShowAll
    && Object.values(narrow).every(Boolean)
    && runtimeErrors.length === 0;

  await browser.close();
  if (!passed) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
