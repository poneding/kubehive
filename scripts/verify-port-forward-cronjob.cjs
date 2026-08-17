// Verifies the Port Forwarding list (inline pause/resume + stop actions, no
// details sheet, trimmed context menu) and the CronJob Trigger / Suspend /
// Resume actions against the mocked Tauri backend.
const { chromium } = require("playwright");

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";

const cluster = {
  id: "pf-cron-verify",
  name: "pf-cron-verify",
  provider: "Local",
  region: "test",
  version: "v1.31.0",
  status: "healthy",
  nodes: 1,
  cpu: 10,
  memory: 20,
  context: "pf-cron-verify",
  server: "https://127.0.0.1:6443",
  defaultNamespace: "default",
  imported: true,
  disconnected: false,
  error: null,
};

function descriptor(kind, plural, group, version) {
  return { apiVersion: version ? `${group}/${version}` : version || "v1", group, version: version || "v1", kind, plural, namespaced: true, verbs: ["get", "list", "watch", "create", "patch", "delete"], categories: [] };
}

const descriptors = [
  descriptor("Pod", "pods", "", "v1"),
  descriptor("CronJob", "cronjobs", "batch", "v1"),
  descriptor("Job", "jobs", "batch", "v1"),
];

const cronJobManifest = `apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-daily
  namespace: default
spec:
  schedule: "0 2 * * *"
  suspend: false
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backup
              image: example.test/backup:1.0
          restartPolicy: Never
`;

function cronJobRecord(suspended) {
  return {
    key: "default/backup-daily",
    name: "backup-daily",
    namespace: "default",
    uid: "cronjob-uid-1",
    resourceVersion: "1",
    apiVersion: "batch/v1",
    kind: "CronJob",
    createdAt: "2026-08-15T00:00:00Z",
    ageSeconds: 172800,
    object: {
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: { name: "backup-daily", namespace: "default", uid: "cronjob-uid-1", creationTimestamp: "2026-08-15T00:00:00Z" },
      spec: {
        schedule: "0 2 * * *",
        suspend: suspended,
        jobTemplate: {
          metadata: { labels: { app: "backup" } },
          spec: { template: { spec: { containers: [{ name: "backup", image: "example.test/backup:1.0" }], restartPolicy: "Never" } } },
        },
      },
      status: { lastScheduleTime: "2026-08-17T02:00:00Z" },
    },
  };
}

const sessions = [
  { id: "pf-active", clusterId: cluster.id, namespace: "default", targetKind: "pod", targetName: "api-0", pod: "api-0", host: "localhost", protocol: "http", localPort: 8080, remotePort: 80, servicePort: null, status: "Active", error: null },
  { id: "pf-paused", clusterId: cluster.id, namespace: "default", targetKind: "service", targetName: "web", pod: "web-6dcbf", host: "0.0.0.0", protocol: "https", localPort: 8443, remotePort: 443, servicePort: 443, status: "Paused", error: null },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));

  await page.addInitScript((fixture) => {
    const cronJobRecord = new Function(`return (${fixture.cronJobRecord});`)();
    const state = {
      cluster: fixture.cluster,
      descriptors: fixture.descriptors,
      sessions: fixture.sessions.map((session) => ({ ...session })),
      cronjobs: [cronJobRecord(false)],
      jobs: [],
      calls: { pause: [], resume: [], stop: [], trigger: [], suspend: [] },
      triggered: 0,
    };
    window.__kubehiveVerify = state;
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
              clusterId: state.cluster.id, version: state.cluster.version, nodes: 1, readyNodes: 1,
              cpuPercent: 10, memoryPercent: 20, pods: 0, runningPods: 0, podCapacity: 10,
              storageBytes: 0, storageCapacityBytes: 1,
              workloadHealth: { total: 0, healthy: 0, degraded: 0, failed: 0 },
              nodeUsage: [], issues: [], events: [], updatedAt: new Date().toISOString(),
            };
          case "list_resources": {
            const kind = args?.request?.resource?.kind;
            const items = kind === "CronJob" ? state.cronjobs : kind === "Job" ? state.jobs : [];
            return { resourceVersion: "1", items };
          }
          case "get_resource": {
            const kind = args?.target?.resource?.kind;
            const name = args?.target?.name;
            const found = (kind === "CronJob" ? state.cronjobs : state.jobs).find((item) => item.name === name);
            if (!found) throw new Error(`Mock resource not found: ${kind}/${name}`);
            return { ...found, manifest: kind === "CronJob" ? fixture.cronJobManifest : "apiVersion: batch/v1\nkind: Job" };
          }
          case "start_resource_watch":
            return "mock-watch";
          case "stop_resource_watch":
            return true;
          case "list_port_forwards":
            return state.sessions;
          case "pause_port_forward": {
            const session = state.sessions.find((entry) => entry.id === args?.sessionId);
            if (!session) throw new Error("No such session");
            session.status = "Paused";
            state.calls.pause.push(args?.sessionId);
            return { ...session };
          }
          case "resume_port_forward": {
            const session = state.sessions.find((entry) => entry.id === args?.sessionId);
            if (!session) throw new Error("No such session");
            session.status = "Active";
            state.calls.resume.push(args?.sessionId);
            return { ...session };
          }
          case "stop_port_forward": {
            state.calls.stop.push(args?.sessionId);
            const before = state.sessions.length;
            state.sessions = state.sessions.filter((entry) => entry.id !== args?.sessionId);
            return state.sessions.length < before;
          }
          case "set_cronjob_suspend": {
            const request = args?.request;
            state.calls.suspend.push(request?.suspend);
            state.cronjobs = [cronJobRecord(Boolean(request?.suspend))];
            return { ...state.cronjobs[0], manifest: fixture.cronJobManifest };
          }
          case "trigger_cronjob": {
            state.calls.trigger.push(args?.target?.name);
            state.triggered += 1;
            const name = `backup-daily-manual-mock${state.triggered}`;
            const job = {
              key: `default/${name}`,
              name,
              namespace: "default",
              uid: `job-uid-${state.triggered}`,
              resourceVersion: "1",
              apiVersion: "batch/v1",
              kind: "Job",
              createdAt: new Date().toISOString(),
              ageSeconds: 0,
              object: {
                apiVersion: "batch/v1",
                kind: "Job",
                metadata: {
                  name, namespace: "default", uid: `job-uid-${state.triggered}`, creationTimestamp: new Date().toISOString(),
                  ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: "backup-daily", uid: "cronjob-uid-1", controller: true, blockOwnerDeletion: true }],
                },
                spec: { template: { spec: { containers: [{ name: "backup", image: "example.test/backup:1.0" }], restartPolicy: "Never" } } },
                status: {},
              },
            };
            state.jobs.push(job);
            return { ...job, manifest: "apiVersion: batch/v1\nkind: Job" };
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
  }, { cluster, descriptors, sessions, cronJobRecord: cronJobRecord.toString(), cronJobManifest });

  const results = {};

  const navTo = async (label) => page.locator(`.resource-nav nav button[aria-label="${label}"]`).click();
  const rowByText = (text) => page.locator(".resource-table tbody tr[data-index]").filter({ hasText: text }).first();
  // Synthetic contextmenu (real pointer right-clicks auto-scroll the row and
  // the host closes menus on scroll). Construct the MouseEvent page-side: the
  // driver-side dispatchEvent drops clientX/clientY for contextmenu events.
  const openRowMenu = async (row) => {
    await row.evaluate((tr) => {
      const box = tr.getBoundingClientRect();
      tr.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.x + 40, clientY: box.y + 10 }));
    });
  };
  const menuItem = (text) => page.locator(".app-context-menu [role='menuitem']").filter({ hasText: text });
  const menuTexts = async () => {
    await page.locator(".app-context-menu [role='menuitem']").first().waitFor({ state: "attached" });
    return page.locator(".app-context-menu [role='menuitem']").allTextContents();
  };
  const step = async (name, run) => {
    try {
      const value = await run();
      results[name] = value === undefined ? true : value;
    } catch (error) {
      results[name] = `FAIL: ${String(error && (error.message || error)).slice(0, 200)}`;
    }
  };

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("kubehive.preferences", JSON.stringify({ autoUpdate: false }));
    });
    await page.reload({ waitUntil: "networkidle" });

    await page.locator(".cluster-home-avatar").first().click();
    await page.locator(".resource-nav").waitFor();

    // ---- Port Forwarding ----
    await navTo("Port Forwarding");
    await page.locator(".page-head h1").getByText("Port Forwarding", { exact: true }).waitFor();
    const activeRow = rowByText("api-0-80");
    const pausedRow = rowByText("web-443");
    await activeRow.waitFor();
    await pausedRow.waitFor();
    results.rowsRender = await page.locator(".resource-table-wrap").getAttribute("data-row-count") === "2";

    // Action column shows pause + stop directly, with no overflow menu button.
    results.inlineActions = (await activeRow.locator("td.actions-col .row-action-group button").count()) === 2;
    results.noOverflowOnForwardRows = (await activeRow.locator('td.actions-col [aria-label="Row actions"]').count()) === 0;
    results.activeRowHasPause = (await activeRow.locator('td.actions-col button[aria-label="Pause forwarding"]').count()) === 1;
    results.pausedRowHasResume = (await pausedRow.locator('td.actions-col button[aria-label="Resume forwarding"]').count()) === 1;

    // Clicking a forward row must not open the details sheet.
    await activeRow.locator("td .resource-name-line strong").first().click();
    await page.waitForTimeout(400);
    results.noSheetOnRowClick = (await page.locator(".sheet-right").count()) === 0;

    // Context menu keeps only pause/resume + stop.
    await step("menuItems", async () => {
      await openRowMenu(activeRow);
      const items = await menuTexts();
      await page.keyboard.press("Escape");
      return items;
    });

    // Pause via the inline button.
    await step("pauseFlow", async () => {
      await activeRow.locator('td.actions-col button[aria-label="Pause forwarding"]').click();
      await activeRow.locator('td.actions-col button[aria-label="Resume forwarding"]').waitFor({ timeout: 8000 });
    });

    // Menu for the now-paused row contains Resume instead of Pause.
    await step("pausedMenuItems", async () => {
      await openRowMenu(activeRow);
      const items = await menuTexts();
      await page.keyboard.press("Escape");
      return items;
    });

    // Stop via the inline button removes the row.
    await step("stopFlow", async () => {
      await activeRow.locator('td.actions-col button[aria-label="Stop forwarding"]').click();
      await page.waitForFunction(() => document.querySelector(".resource-table-wrap")?.getAttribute("data-row-count") === "1", null, { timeout: 10000 });
      await rowByText("api-0-80").waitFor({ state: "detached", timeout: 2000 }).catch(() => undefined);
      return (await rowByText("web-443").count()) === 1;
    });

    // ---- CronJob trigger / suspend ----
    await navTo("CronJobs");
    await page.locator(".page-head h1").getByText("CronJobs", { exact: true }).waitFor();
    const cronRow = rowByText("backup-daily");
    await cronRow.waitFor();

    await step("cronJobMenu", async () => {
      await openRowMenu(cronRow);
      const items = await menuTexts();
      await menuItem("Suspend").dispatchEvent("click");
      await page.locator(".app-toast.tone-success").filter({ hasText: "Suspended CronJob/backup-daily" }).waitFor({ timeout: 8000 });
      return items;
    });

    // After reload the suspended state flips the menu entry to Resume.
    await step("cronJobMenuFlipsAndTrigger", async () => {
      await openRowMenu(cronRow);
      const items = await menuTexts();
      if (!items.includes("Resume") || items.includes("Suspend")) return items;
      await menuItem("Trigger").dispatchEvent("click");
      await page.locator(".app-toast.tone-success").filter({ hasText: "Created Job backup-daily-manual-mock1" }).waitFor({ timeout: 8000 });
      return items;
    });

    // Details sheet exposes Trigger + Resume actions and Resume closes it.
    await step("sheetActions", async () => {
      // Click the name text itself — the cell center can land on the
      // hover-revealed copy button, which swallows the event.
      await cronRow.locator("td:not(.selection-col) .resource-name-line strong").first().click();
      await page.locator(".sheet-right").waitFor();
      const counts = {
        trigger: await page.locator('.sheet-right [aria-label="Trigger"]').count(),
        resume: await page.locator('.sheet-right [aria-label="Resume"]').count(),
      };
      await page.locator('.sheet-right [aria-label="Resume"]').click();
      await page.locator(".app-toast.tone-success").filter({ hasText: "Resumed CronJob/backup-daily" }).waitFor({ timeout: 8000 });
      await page.locator(".sheet-right").waitFor({ state: "detached" });
      return counts;
    });

    results.backendCalls = await page.evaluate(() => window.__kubehiveVerify.calls);
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
