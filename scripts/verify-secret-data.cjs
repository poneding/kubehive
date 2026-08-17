// Verifies Secret data entry rendering: the stored (base64) form is shown by
// default once the detail record hydrates, "Decode base64" toggles the
// decoded preview, and list snapshots stay masked until hydration replaces
// them. Also covers the plain ConfigMap data preview.
const { chromium } = require("playwright");

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";

const cluster = {
  id: "secret-verify",
  name: "secret-verify",
  provider: "Local",
  region: "test",
  version: "v1.31.0",
  status: "healthy",
  nodes: 1,
  cpu: 10,
  memory: 20,
  context: "secret-verify",
  server: "https://127.0.0.1:6443",
  defaultNamespace: "default",
  imported: true,
  disconnected: false,
  error: null,
};

const tlsCrtPlain = "-----BEGIN CERTIFICATE-----\nMIIDyTCcArKgAwIBAgIRAMockSelfSigned1234\n-----END CERTIFICATE-----\n";
const tlsKeyPlain = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfake\n-----END RSA PRIVATE KEY-----\n";
const tlsCrtB64 = Buffer.from(tlsCrtPlain, "utf8").toString("base64");
const tlsKeyB64 = Buffer.from(tlsKeyPlain, "utf8").toString("base64");

function record(kind, name, object) {
  return {
    key: `default/${name}`,
    name,
    namespace: "default",
    uid: `${kind.toLowerCase()}-${name}-uid`,
    resourceVersion: "1",
    apiVersion: kind === "CronJob" ? "batch/v1" : "v1",
    kind,
    createdAt: "2026-08-15T00:00:00Z",
    ageSeconds: 172800,
    object,
  };
}

const secretObject = (masked) => ({
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name: "checkout-api-tls", namespace: "default", uid: "secret-checkout-api-tls-uid", creationTimestamp: "2026-08-15T00:00:00Z", labels: { app: "checkout-api" } },
  type: "kubernetes.io/tls",
  data: {
    "tls.crt": masked ? "••••••••" : tlsCrtB64,
    "tls.key": masked ? "••••••••" : tlsKeyB64,
  },
});

const configMapObject = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "app-config", namespace: "default", uid: "configmap-app-config-uid", creationTimestamp: "2026-08-15T00:00:00Z" },
  data: { "config.yaml": "server:\n  port: 8080\n  host: 0.0.0.0\n" },
};

const descriptors = ["Secret", "ConfigMap"].map((kind) => ({
  apiVersion: "v1", group: "", version: "v1", kind, plural: `${kind.toLowerCase()}s`, namespaced: true,
  verbs: ["get", "list", "watch", "create", "patch", "delete"], categories: [],
}));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));

  await page.addInitScript((fixture) => {
    // Mirrors the backend: broadcast list/watch snapshots mask Secret values,
    // while the get_resource detail fetch serves the stored base64 form.
    const listRecords = [
      fixture.secretList,    // masked
      fixture.configMapRecord, // ConfigMaps are not masked
    ];
    const detailRecords = [fixture.secretDetail, fixture.configMapRecord];
    const state = { cluster: fixture.cluster };
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
            return fixture.descriptors;
          case "cluster_overview":
            return {
              clusterId: state.cluster.id, version: state.cluster.version, nodes: 1, readyNodes: 1,
              cpuPercent: 10, memoryPercent: 20, pods: 0, runningPods: 0, podCapacity: 10,
              storageBytes: 0, storageCapacityBytes: 1,
              workloadHealth: { total: 0, healthy: 0, degraded: 0, failed: 0 },
              nodeUsage: [], issues: [], events: [], updatedAt: new Date().toISOString(),
            };
          case "list_resources": {
            const kind = args?.request?.resource?.kind;
            return { resourceVersion: "1", items: listRecords.filter((item) => item.kind === kind) };
          }
          case "get_resource": {
            const name = args?.target?.name;
            const found = detailRecords.find((item) => item.name === name);
            if (!found) throw new Error(`Mock resource not found: ${name}`);
            return { ...found, manifest: `apiVersion: v1\nkind: ${found.kind}\nmetadata:\n  name: ${found.name}` };
          }
          case "start_resource_watch":
            return "mock-watch";
          case "stop_resource_watch":
            return true;
          case "list_port_forwards":
            return [];
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
  }, {
    cluster,
    descriptors,
    secretList: record("Secret", "checkout-api-tls", secretObject(true)),
    secretDetail: record("Secret", "checkout-api-tls", secretObject(false)),
    configMapRecord: record("ConfigMap", "app-config", configMapObject),
  });

  const results = {};
  const step = async (name, run) => {
    try {
      const value = await run();
      results[name] = value === undefined ? true : value;
    } catch (error) {
      results[name] = `FAIL: ${String(error && (error.message || error)).slice(0, 240)}`;
    }
  };
  const navTo = async (label) => page.locator(`.resource-nav nav button[aria-label="${label}"]`).click();
  const openRow = async (name) => {
    const row = page.locator(".resource-table tbody tr[data-index]").filter({ hasText: name }).first();
    await row.waitFor();
    await row.locator("td:not(.selection-col) .resource-name-line strong").first().click();
    await page.locator(".sheet-right").waitFor();
  };
  const dataEntry = (key) => page.locator(".detail-data-entry").filter({ has: page.locator("summary code", { hasText: key }) }).first();
  const entryPreview = (key) => dataEntry(key).locator("pre").innerText();

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("kubehive.preferences", JSON.stringify({ autoUpdate: false }));
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.evaluate(({ crtB64, keyB64 }) => {
      localStorage.setItem("kubehive.verifyExpected", JSON.stringify({ crtB64, keyB64 }));
    }, { crtB64: tlsCrtB64, keyB64: tlsKeyB64 });
    await page.locator(".cluster-home-avatar").first().click();
    await page.locator(".resource-nav").waitFor();

    // ---- Secret: raw base64 by default after hydration, decode on demand ----
    await navTo("Secrets");
    await page.locator(".page-head h1").getByText("Secrets", { exact: true }).waitFor();
    await openRow("checkout-api-tls");

    await step("secretRawByDefault", async () => {
      const entry = dataEntry("tls.crt");
      await entry.locator("summary").click();
      // Wait for the detail fetch to replace the masked list snapshot.
      await page.waitForFunction((expected) => {
        const entries = [...document.querySelectorAll(".detail-data-entry")];
        const target = entries.find((item) => item.querySelector("summary code")?.textContent === "tls.crt");
        return target && (target.querySelector("pre")?.textContent ?? "") === expected;
      }, tlsCrtB64, { timeout: 8000 });
      return { preview: await entryPreview("tls.crt") };
    });

    await step("secretDecodeToggle", async () => {
      const entry = dataEntry("tls.crt");
      await entry.getByRole("button", { name: "Decode base64" }).click();
      const decoded = await entryPreview("tls.crt");
      if (!decoded.includes("-----BEGIN CERTIFICATE-----")) return { decoded };
      await entry.getByRole("button", { name: "Show encoded" }).click();
      const encoded = await entryPreview("tls.crt");
      return { decodedShown: decoded.includes("-----BEGIN CERTIFICATE-----"), backToRaw: encoded === tlsCrtB64 };
    });

    await step("secretCopyButtons", async () => {
      const entry = dataEntry("tls.key");
      await entry.locator("summary").click();
      // Decode first so both copy actions exist.
      await entry.getByRole("button", { name: "Decode base64" }).click();
      return {
        copyEncoded: await entry.getByRole("button", { name: "Copy encoded" }).count(),
        copyDecoded: await entry.getByRole("button", { name: "Copy decoded" }).count(),
      };
    });

    // Long single-line values must wrap inside the data preview instead of
    // stretching the sheet's layout past the window edge.
    await step("longValuesWrap", async () => {
      return await dataEntry("tls.crt").evaluate((entry) => {
        const pre = entry.querySelector("pre");
        const sheetRect = document.querySelector(".sheet-right").getBoundingClientRect();
        let sheetOverflow = 0;
        document.querySelectorAll(".sheet-right *").forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.right > sheetRect.right + 1) sheetOverflow += 1;
        });
        return {
          preWraps: pre.scrollWidth <= pre.clientWidth + 1,
          sheetOverflow,
        };
      });
    });

    // ---- ConfigMap: plain value stays the default, copy works unchanged ----
    await step("configMapPlainPreview", async () => {
      await page.locator('.sheet-right [aria-label="Close"]').click();
      await navTo("Config Maps");
      await page.locator(".page-head h1").getByText("Config Maps", { exact: true }).waitFor();
      await openRow("app-config");
      const entry = dataEntry("config.yaml");
      await entry.locator("summary").click();
      const preview = await entryPreview("config.yaml");
      return {
        plain: preview.includes("port: 8080"),
        copyValue: await entry.getByRole("button", { name: "Copy value" }).count(),
        noDecodeToggle: await entry.getByRole("button", { name: "Decode base64" }).count() === 0,
      };
    });

    results.runtimeErrors = runtimeErrors;
  } catch (error) {
    results.fatal = String(error && (error.stack || error.message || error));
    results.runtimeErrors = runtimeErrors;
  } finally {
    console.log(JSON.stringify(results, null, 2));
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
