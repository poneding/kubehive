const { chromium } = require("playwright");

// Verifies the shared find popover keeps keyboard focus while typing in the
// manifest editor: after the first keystroke the CodeMirror editor must not
// steal the caret back (which used to make the rest of the query leak into
// the document), and Escape must close the popover and hand focus back to
// the editor.
//
// Runs against the dev server with a mocked Tauri backend so it exercises
// the real app in a plain browser (the native backend is not required).

const CLUSTER = {
  id: "demo", name: "demo-cluster", provider: "Local", region: "local", version: "v1.29",
  status: "healthy", nodes: 1, cpu: 2, memory: 4, context: "demo",
  server: "https://127.0.0.1:6443", defaultNamespace: "default", imported: true,
  disconnected: false, error: null,
};
const DESCRIPTORS = [
  { apiVersion: "v1", group: "", version: "v1", kind: "ConfigMap", plural: "configmaps", namespaced: true, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], categories: [] },
  { apiVersion: "v1", group: "", version: "v1", kind: "Secret", plural: "secrets", namespaced: true, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], categories: [] },
  { apiVersion: "v1", group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], categories: ["all"] },
  { apiVersion: "apps/v1", group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], categories: ["all"] },
];
const MANIFEST = `apiVersion: v1
kind: ConfigMap
metadata:
  name: new-resource
  namespace: default
data:
  key: value`;
const ROW = {
  key: "configmaps/new-resource", name: "new-resource", namespace: "default",
  apiVersion: "v1", kind: "ConfigMap", resourceVersion: "1",
  ageSeconds: 120, object: { metadata: { name: "new-resource", namespace: "default" }, data: { key: "value" } },
};

(async () => {
  const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://localhost:1420";
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.addInitScript((mock) => {
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => {
        switch (cmd) {
          case "backend_info": return { name: "kubehive", runtime: "mock", kubernetesClient: "mock", mode: "dev" };
          case "list_clusters": return [mock.cluster];
          case "probe_cluster": return mock.cluster;
          case "discover_resources": return mock.descriptors;
          case "list_resources": return { resourceVersion: "1", items: [mock.row] };
          case "get_resource": return { ...mock.row, manifest: mock.manifest };
          case "pod_metrics": return null;
          case "apply_manifest": return { ...mock.row, manifest: mock.manifest };
          default: throw new Error(`unmocked command: ${cmd}`);
        }
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    };
  }, { cluster: CLUSTER, descriptors: DESCRIPTORS, row: ROW, manifest: MANIFEST });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });

    // Open the cluster workspace, then the ConfigMap detail -> Edit session.
    await page.locator(".cluster-home-avatar").first().click();
    await page.getByRole("button", { name: "Config Maps", exact: true }).click();
    await page.locator("tbody tr[data-index]").first().waitFor();
    await page.locator("tbody tr[data-index]").first().click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator('.manifest-editor[data-format="yaml"] .cm-editor').waitFor();

    // Type the query with real keystrokes; focus must stay in the popover.
    const cm = page.locator(".manifest-editor .cm-content");
    await cm.press("Control+f");
    const input = page.getByRole("textbox", { name: "Find text" });
    await input.pressSequentially("apiVersion", { delay: 30 });
    const searchKeepsFocus = await page.evaluate(() => document.activeElement?.closest(".text-search-popover") === document.querySelector(".text-search-popover"));
    const searchCount = await page.locator(".text-search-count").textContent();

    // Escape closes the popover and returns focus to the editor.
    await input.press("Escape");
    await page.waitForTimeout(80);
    const searchRestoresFocus = await page.evaluate(() => document.activeElement?.closest(".cm-content") === document.querySelector(".manifest-editor .cm-content"));
    const popoverClosed = await page.locator(".text-search-popover").count() === 0;
    const docText = await page.locator(".manifest-editor .cm-content").evaluate((el) => [...el.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n"));
    const docIntact = docText === MANIFEST;

    // The editor caret must be painted with the theme caret color, not
    // CodeMirror's default black (invisible on the dark editor surface).
    const caretVisible = await page.evaluate(() => {
      const cursor = document.querySelector(".manifest-editor .cm-cursor");
      if (!cursor) return false;
      const color = getComputedStyle(cursor).borderLeftColor;
      return color !== "rgb(0, 0, 0)";
    });

    const result = { searchKeepsFocus, searchCount, searchRestoresFocus, popoverClosed, docIntact, caretVisible, errors };
    console.log(JSON.stringify(result, null, 2));
    if (errors.length || !searchKeepsFocus || searchCount !== "1/1" || !searchRestoresFocus || !popoverClosed || !docIntact || !caretVisible) process.exit(1);
  } finally {
    await browser.close();
  }
})();
