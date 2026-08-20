// Verifies the Helm release values panel in the details sheet: the supplied
// values open by default, the segmented control swaps in the chart defaults
// and the computed merge, counts follow the active document, a release
// without supplied values shows the empty state, long values wrap inside the
// sheet instead of widening it.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";

const cluster = {
  id: "helm-verify",
  name: "helm-verify",
  provider: "Local",
  region: "test",
  version: "v1.31.0",
  status: "healthy",
  nodes: 1,
  cpu: 10,
  memory: 20,
  context: "helm-verify",
  server: "https://127.0.0.1:6443",
  defaultNamespace: "default",
  imported: true,
  disconnected: false,
  error: null,
};

const longValue = `sha256:${"a1b2c3d4".repeat(24)}`;

const suppliedValues = "image:\n  tag: 2.2.0\nreplicaCount: 4\n";
const defaultValues = `image:\n  digest: ${longValue}\n  pullPolicy: IfNotPresent\n  repository: checkout\n  tag: 2.1.0\ningress:\n  enabled: false\nreplicaCount: 1\n`;
const computedValues = `image:\n  digest: ${longValue}\n  pullPolicy: IfNotPresent\n  repository: checkout\n  tag: 2.2.0\ningress:\n  enabled: false\nreplicaCount: 4\n`;

// A document tall enough to overflow the preview's 320px cap, so the vertical
// scrollbar is real and can be scrolled to its end.
const tallValues = `${Array.from({ length: 40 }, (_, index) => `key${String(index).padStart(2, "0")}: value-${index}`).join("\n")}\n`;

function releaseSecret(name, revision, chart) {
  return {
    key: `default/sh.helm.release.v1.${name}.v${revision}`,
    name: `sh.helm.release.v1.${name}.v${revision}`,
    namespace: "default",
    uid: `helm-${name}-v${revision}-uid`,
    resourceVersion: "1",
    apiVersion: "v1",
    kind: "Secret",
    createdAt: "2026-08-15T00:00:00Z",
    ageSeconds: 172800,
    object: {
      apiVersion: "v1",
      kind: "Secret",
      type: "helm.sh/release.v1",
      metadata: {
        name: `sh.helm.release.v1.${name}.v${revision}`,
        namespace: "default",
        uid: `helm-${name}-v${revision}-uid`,
        creationTimestamp: "2026-08-15T00:00:00Z",
        labels: { owner: "helm", name, status: "deployed", version: String(revision), chart },
      },
      // The stored payload always stays masked in list snapshots; the values
      // panel reads it through the get_helm_release command instead.
      data: { release: "••••••••" },
    },
  };
}

const releases = {
  "sh.helm.release.v1.checkout.v3": {
    name: "checkout",
    namespace: "default",
    revision: 3,
    status: "deployed",
    chart: "checkout-1.4.0",
    appVersion: "2.1.0",
    suppliedValues,
    suppliedValueCount: 2,
    defaultValues,
    defaultValueCount: 3,
    computedValues,
    computedValueCount: 3,
  },
  "sh.helm.release.v1.plain.v1": {
    name: "plain",
    namespace: "default",
    revision: 1,
    status: "deployed",
    chart: "plain-0.1.0",
    appVersion: "1.0.0",
    suppliedValues: "",
    suppliedValueCount: 0,
    defaultValues: "replicaCount: 1\n",
    defaultValueCount: 1,
    computedValues: "replicaCount: 1\n",
    computedValueCount: 1,
  },
  "sh.helm.release.v1.tall.v1": {
    name: "tall",
    namespace: "default",
    revision: 1,
    status: "deployed",
    chart: "tall-1.0.0",
    appVersion: "1.0.0",
    suppliedValues: tallValues,
    suppliedValueCount: 40,
    defaultValues: tallValues,
    defaultValueCount: 40,
    computedValues: tallValues,
    computedValueCount: 40,
  },
};

const descriptors = ["Secret"].map((kind) => ({
  apiVersion: "v1", group: "", version: "v1", kind, plural: `${kind.toLowerCase()}s`, namespaced: true,
  verbs: ["get", "list", "watch", "create", "patch", "delete"], categories: [],
}));

const fixture = {
  cluster,
  descriptors,
  releases,
  secrets: [releaseSecret("checkout", 3, "checkout-1.4.0"), releaseSecret("plain", 1, "plain-0.1.0"), releaseSecret("tall", 1, "tall-1.0.0")],
};

function installMockBackend(fixtureData) {
  const state = { cluster: fixtureData.cluster };
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
          return fixtureData.descriptors;
        case "cluster_overview":
          return {
            clusterId: state.cluster.id, version: state.cluster.version, nodes: 1, readyNodes: 1,
            cpuPercent: 10, memoryPercent: 20, pods: 0, runningPods: 0, podCapacity: 10,
            storageBytes: 0, storageCapacityBytes: 1,
            workloadHealth: { total: 0, healthy: 0, degraded: 0, failed: 0 },
            nodeUsage: [], issues: [], events: [], updatedAt: new Date().toISOString(),
          };
        case "list_resources":
          return { resourceVersion: "1", items: fixtureData.secrets };
        case "get_resource": {
          const name = args?.target?.name;
          const found = fixtureData.secrets.find((item) => item.name === name);
          if (!found) throw new Error(`Mock resource not found: ${name}`);
          return { ...found, manifest: `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${found.name}` };
        }
        case "get_helm_release": {
          const values = fixtureData.releases[args?.request?.secretName];
          if (!values) throw new Error(`Mock Helm release not found: ${args?.request?.secretName}`);
          return values;
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
}

function measureScrollbar(element) {
  const documentSurface = element.querySelector(".helm-values-document");
  const stage = element.querySelector(".helm-values-document-stage");
  const scrollRoot = element.querySelector(".helm-values-code-scroll");
  const viewportNode = element.querySelector(".helm-values-code-viewport");
  const track = element.querySelector('[data-orientation="vertical"][data-slot="scroll-area-scrollbar"]');
  const thumb = track?.querySelector('[data-slot="scroll-area-thumb"]');
  if (!documentSurface || !stage || !scrollRoot || !viewportNode || !track || !thumb) return null;
  const rect = (node) => {
    const bounds = node.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
  };
  const trackRect = track.getBoundingClientRect();
  const thumbRect = thumb.getBoundingClientRect();
  const point = document.elementFromPoint(thumbRect.left + thumbRect.width / 2, thumbRect.bottom - 2);
  const clippingValues = new Set(["hidden", "clip", "auto", "scroll"]);
  const clippingAncestors = [];
  const viewerClippingAncestors = [];
  for (let node = track.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    const clipX = clippingValues.has(style.overflowX);
    const clipY = clippingValues.has(style.overflowY);
    if (!clipX && !clipY) continue;
    const bounds = node.getBoundingClientRect();
    const entry = {
      className: String(node.className || node.tagName),
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      containsTrack: (!clipX || (trackRect.left >= bounds.left - 1 && trackRect.right <= bounds.right + 1))
        && (!clipY || (trackRect.top >= bounds.top - 1 && trackRect.bottom <= bounds.bottom + 1)),
    };
    clippingAncestors.push(entry);
    if (documentSurface.contains(node)) viewerClippingAncestors.push(entry);
  }
  return {
    devicePixelRatio: window.devicePixelRatio,
    clippingAncestors,
    viewerClippingAncestors,
    document: rect(documentSurface),
    stage: rect(stage),
    root: rect(scrollRoot),
    viewport: { ...rect(viewportNode), scrollTop: viewportNode.scrollTop, maximum: viewportNode.scrollHeight - viewportNode.clientHeight },
    track: rect(track),
    thumb: rect(thumb),
    horizontalScrollbar: Boolean(element.querySelector('[data-orientation="horizontal"]')),
    topmostAtThumbBottom: point?.getAttribute("data-slot") || point?.tagName || null,
  };
}

function assertScrollbarGeometry(top, bottom) {
  assert.ok(top && bottom);
  assert.equal(bottom.horizontalScrollbar, false);
  assert.deepEqual(bottom.viewerClippingAncestors, []);
  assert.ok(bottom.clippingAncestors.every((ancestor) => ancestor.containsTrack), `an ancestor clips the track: ${JSON.stringify(bottom)}`);
  assert.ok(bottom.root.right <= bottom.track.left + 1, `track overlaps viewport: ${JSON.stringify(bottom)}`);
  assert.ok(bottom.track.right <= bottom.stage.right + 1, JSON.stringify(bottom));
  assert.ok(Math.abs(bottom.track.top - bottom.stage.top) <= 1, JSON.stringify(bottom));
  assert.ok(bottom.stage.bottom - bottom.track.bottom >= 5 && bottom.stage.bottom - bottom.track.bottom <= 7, JSON.stringify(bottom));
  assert.ok(Math.abs(bottom.viewport.scrollTop - bottom.viewport.maximum) <= 1);
  assert.ok(Math.abs(top.thumb.top - top.track.top) <= 1, JSON.stringify(top));
  assert.ok(Math.abs(bottom.track.bottom - bottom.thumb.bottom) <= 1, JSON.stringify(bottom));
  assert.ok(bottom.stage.bottom - bottom.thumb.bottom >= 5, JSON.stringify(bottom));
  assert.equal(bottom.topmostAtThumbBottom, "scroll-area-thumb");
}

async function sampleThumbPixels(page, geometry) {
  const clip = {
    x: Math.floor(geometry.track.left),
    y: Math.floor(geometry.track.top),
    width: Math.ceil(geometry.track.right) - Math.floor(geometry.track.left),
    height: Math.ceil(geometry.track.bottom) - Math.floor(geometry.track.top),
  };
  const data = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(async ({ imageData, imageClip, thumb }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${imageData}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const scaleX = image.width / imageClip.width;
    const scaleY = image.height / imageClip.height;
    const sample = (cssX, cssY) => {
      const x = Math.max(0, Math.min(image.width - 1, Math.round((cssX - imageClip.x) * scaleX)));
      const y = Math.max(0, Math.min(image.height - 1, Math.round((cssY - imageClip.y) * scaleY)));
      const index = (y * image.width + x) * 4;
      return [pixels[index], pixels[index + 1], pixels[index + 2]];
    };
    const x = thumb.left + thumb.width / 2;
    const middle = sample(x, thumb.top + thumb.height / 2);
    const nearBottom = sample(x, thumb.bottom - 2);
    const exposedTrack = sample(x, Math.max(imageClip.y + .5, thumb.top - 2));
    const colorDistance = middle.reduce((total, value, index) => total + Math.abs(value - nearBottom[index]), 0);
    const trackSeparation = nearBottom.reduce((total, value, index) => total + Math.abs(value - exposedTrack[index]), 0);
    return { colorDistance, trackSeparation, middle, nearBottom, exposedTrack, scaleX, scaleY };
  }, { imageData: data, imageClip: clip, thumb: geometry.thumb });
}

async function inspectScrollbarScenario(browser, scenario) {
  const context = await browser.newContext({ viewport: scenario.viewport, deviceScaleFactor: scenario.dpr });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));
  await page.addInitScript(installMockBackend, fixture);
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(({ sheetWidth, theme }) => {
      localStorage.clear();
      localStorage.setItem("kubehive.preferences", JSON.stringify({ autoUpdate: false, theme }));
      localStorage.setItem("kubehive.detailWidth", String(sheetWidth));
    }, scenario);
    await page.reload({ waitUntil: "networkidle" });
    const avatar = page.locator(".cluster-home-avatar").first();
    if (await avatar.isVisible().catch(() => false)) await avatar.click();
    await page.locator(".resource-nav").waitFor();
    await page.locator('.resource-nav nav button[aria-label="Helm Releases"]').click();
    await page.locator(".page-head h1").getByText("Helm Releases", { exact: true }).waitFor();
    const row = page.locator(".resource-table tbody tr[data-index]").filter({ hasText: "tall" }).first();
    await row.waitFor();
    await row.locator("td:not(.selection-col) .resource-name-line strong").first().click();
    const section = page.locator('.sheet-right [data-detail-section="helm-values"]');
    await section.waitFor();
    await section.locator("pre").waitFor();
    if (scenario.resizeTo) {
      await page.setViewportSize(scenario.resizeTo);
      await page.waitForTimeout(200);
    }
    await section.scrollIntoViewIfNeeded();
    const viewport = section.locator(".helm-values-code-viewport");
    await viewport.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.waitForTimeout(200);
    const bottom = await section.evaluate(measureScrollbar);
    const pixels = await sampleThumbPixels(page, bottom);
    await viewport.evaluate((node) => { node.scrollTop = 0; });
    await page.waitForTimeout(100);
    const top = await section.evaluate(measureScrollbar);
    assertScrollbarGeometry(top, bottom);
    assert.ok(pixels.colorDistance <= 30, `thumb bottom is clipped in ${scenario.name}: ${JSON.stringify(pixels)}`);
    assert.ok(pixels.trackSeparation >= 30, `thumb cannot be distinguished from track in ${scenario.name}: ${JSON.stringify(pixels)}`);
    const layout = await section.evaluate((element) => {
      const sheet = document.querySelector(".sheet-right");
      const sheetRect = sheet.getBoundingClientRect();
      const outsideSheet = (node) => {
        const bounds = node.getBoundingClientRect();
        return bounds.width > 0 && (bounds.left < sheetRect.left - 1 || bounds.right > sheetRect.right + 1);
      };
      const describe = (node) => {
        const bounds = node.getBoundingClientRect();
        return { className: String(node.className), left: bounds.left, right: bounds.right };
      };
      const sheetOverflow = [...sheet.querySelectorAll("*")].filter(outsideSheet).map(describe);
      const valuesOverflow = [...element.querySelectorAll("*")].filter(outsideSheet).map(describe);
      const tabsFit = [...element.querySelectorAll('.helm-values-view-tabs [role="tab"]')].every((tab) => tab.scrollWidth <= tab.clientWidth + 1);
      const copyFloating = (() => {
        const copyButton = element.querySelector(".helm-values-copy");
        if (!copyButton) return null;
        const stage = element.querySelector(".helm-values-document-stage");
        const style = getComputedStyle(copyButton);
        const rect = copyButton.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        return {
          positioned: style.position === "absolute",
          iconOnly: copyButton.innerText.trim() === "",
          hidden: style.opacity === "0",
          inStage: rect.left >= stageRect.left && rect.right <= stageRect.right + 1 && rect.top >= stageRect.top && rect.bottom <= stageRect.bottom + 1,
          topRight: rect.left >= stageRect.right - 44 && rect.top <= stageRect.top + 22,
        };
      })();
      return {
        dark: document.documentElement.classList.contains("theme-dark"),
        light: document.documentElement.classList.contains("theme-light"),
        sheetWidth: sheetRect.width,
        sheetOverflow,
        valuesOverflow,
        tabsFit,
        toolbarRemoved: element.querySelector(".helm-values-document-toolbar") === null,
        copyFloating,
      };
    });
    assert.ok(Math.abs(layout.sheetWidth - (scenario.expectedSheetWidth ?? scenario.sheetWidth)) <= 1, JSON.stringify(layout));
    assert.deepEqual(layout.valuesOverflow, [], JSON.stringify(layout));
    assert.equal(layout.tabsFit, true, JSON.stringify(layout));
    assert.equal(layout.toolbarRemoved, true, JSON.stringify(layout));
    assert.ok(layout.copyFloating, JSON.stringify(layout));
    assert.equal(layout.copyFloating.positioned, true, JSON.stringify(layout));
    assert.equal(layout.copyFloating.iconOnly, true, JSON.stringify(layout));
    assert.equal(layout.copyFloating.hidden, true, JSON.stringify(layout));
    assert.equal(layout.copyFloating.inStage, true, JSON.stringify(layout));
    assert.equal(layout.copyFloating.topRight, true, JSON.stringify(layout));
    assert.equal(layout[scenario.theme], true, JSON.stringify(layout));
    assert.deepEqual(runtimeErrors, []);
    await viewport.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.waitForTimeout(100);
    await page.screenshot({ path: `artifacts/helm-release-values-${scenario.name}.png`, clip: await section.boundingBox() });
    return {
      dpr: bottom.devicePixelRatio,
      browserWidth: page.viewportSize().width,
      sheetWidth: layout.sheetWidth,
      theme: scenario.theme,
      viewportTrackGap: bottom.track.left - bottom.root.right,
      trackBottomInset: bottom.stage.bottom - bottom.track.bottom,
      thumbBottomInset: bottom.track.bottom - bottom.thumb.bottom,
      pixels,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));

  await page.addInitScript(installMockBackend, fixture);

  const results = {};
  const step = async (name, run) => {
    try {
      const value = await run();
      results[name] = value === undefined ? true : value;
    } catch (error) {
      results[name] = `FAIL: ${String(error && (error.message || error)).slice(0, 2_000)}`;
    }
  };
  const section = () => page.locator('.sheet-right [data-detail-section="helm-values"]');
  const preview = () => section().locator("pre").innerText();
  const activeTab = () => section().locator('.helm-values-view-tabs button[aria-selected="true"]').innerText();
  const openRow = async (name) => {
    const row = page.locator(".resource-table tbody tr[data-index]").filter({ hasText: name }).first();
    await row.waitFor();
    await row.locator("td:not(.selection-col) .resource-name-line strong").first().click();
    await page.locator(".sheet-right").waitFor();
    await section().waitFor();
  };
  const closeSheet = () => page.locator(".sheet-right .detail-sheet-header > button").last().click();
  const enterCluster = async () => {
    const avatar = page.locator(".cluster-home-avatar").first();
    if (await avatar.isVisible().catch(() => false)) await avatar.click();
    await page.locator(".resource-nav").waitFor();
  };
  const openReleaseRow = async (name) => {
    await page.locator('.resource-nav nav button[aria-label="Helm Releases"]').click();
    await page.locator(".page-head h1").getByText("Helm Releases", { exact: true }).waitFor();
    await openRow(name);
  };
  // The panel holds a loading state until get_helm_release resolves; both
  // outcomes end in a preview or an empty state.
  const settled = (expectPreview) => page.waitForFunction((preview) => {
    const element = document.querySelector('[data-detail-section="helm-values"]');
    if (!element) return false;
    return preview ? Boolean(element.querySelector("pre")) : Boolean(element.querySelector(".detail-container-empty"));
  }, expectPreview, { timeout: 8000 });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("kubehive.preferences", JSON.stringify({ autoUpdate: false }));
    });
    await page.reload({ waitUntil: "networkidle" });
    await enterCluster();
    await openReleaseRow("checkout");

    // ---- Supplied values open first ----
    await step("suppliedByDefault", async () => {
      await page.waitForFunction(() => {
        const pre = document.querySelector('[data-detail-section="helm-values"] pre');
        return pre && pre.textContent.includes("replicaCount: 4");
      }, null, { timeout: 8000 });
      const text = await preview();
      const result = {
        activeTab: (await activeTab()).replace(/\s+/g, " ").trim(),
        supplied: text.includes("replicaCount: 4") && text.includes("tag: 2.2.0"),
        withoutDefaults: !text.includes("pullPolicy"),
        count: await section().locator(".ui-badge").first().innerText(),
      };
      assert.equal(result.activeTab, "Supplied 2");
      assert.equal(result.supplied, true);
      assert.equal(result.withoutDefaults, true);
      assert.equal(result.count, "2");
      return result;
    });

    // ---- Chart defaults and the computed merge ----
    await step("chartDefaultsTab", async () => {
      await section().getByRole("tab", { name: /Chart defaults/ }).click();
      const text = await preview();
      const result = {
        defaults: text.includes("tag: 2.1.0") && text.includes("pullPolicy: IfNotPresent"),
        count: await section().locator(".ui-badge").first().innerText(),
      };
      assert.equal(result.defaults, true);
      assert.equal(result.count, "3");
      return result;
    });

    await step("computedTab", async () => {
      await section().getByRole("tab", { name: /Computed/ }).click();
      const text = await preview();
      const result = {
        overrideWins: text.includes("tag: 2.2.0") && !text.includes("tag: 2.1.0"),
        defaultsKept: text.includes("pullPolicy: IfNotPresent"),
        replicas: text.includes("replicaCount: 4"),
        count: await section().locator(".ui-badge").first().innerText(),
      };
      assert.equal(result.overrideWins, true);
      assert.equal(result.defaultsKept, true);
      assert.equal(result.replicas, true);
      assert.equal(result.count, "3");
      return result;
    });

    await step("tabKeyboard", async () => {
      const computed = section().getByRole("tab", { name: /Computed/ });
      await computed.focus();
      await computed.press("ArrowRight");
      const active = section().locator('.helm-values-view-tabs [role="tab"][aria-selected="true"]');
      const result = {
        wrapsToSupplied: (await active.innerText()).replace(/\s+/g, " ").trim() === "Supplied 2",
        focusFollowsSelection: await active.evaluate((node) => node === document.activeElement),
        panelLabelled: await section().locator('[role="tabpanel"]').evaluate((panel) => panel.getAttribute("aria-labelledby") === document.activeElement?.id),
      };
      assert.equal(result.wrapsToSupplied, true);
      assert.equal(result.focusFollowsSelection, true);
      assert.equal(result.panelLabelled, true);
      return result;
    });

    // ---- Copy is a floating icon button in the stage's top-right corner, revealed on hover ----
    await step("copyAction", async () => {
      const button = section().getByRole("button", { name: /^Copy .+ values$/ });
      assert.equal(await button.count(), 1);
      const placement = await button.evaluate((node) => {
        const stage = node.closest(".helm-values-document-stage").getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        return {
          inStage: rect.left >= stage.left && rect.right <= stage.right + 1 && rect.top >= stage.top && rect.bottom <= stage.bottom + 1,
          topRight: rect.left >= stage.right - 44 && rect.top <= stage.top + 22,
          absolute: getComputedStyle(node).position === "absolute",
          iconOnly: node.innerText.trim() === "",
          hidden: getComputedStyle(node).opacity === "0",
        };
      });
      assert.equal(placement.inStage, true);
      assert.equal(placement.topRight, true);
      assert.equal(placement.absolute, true);
      assert.equal(placement.iconOnly, true);
      assert.equal(placement.hidden, true);
      await section().locator(".helm-values-document-stage").hover();
      await page.waitForTimeout(250);
      const revealed = await button.evaluate((node) => getComputedStyle(node).opacity === "1");
      assert.equal(revealed, true);
      return { ...placement, revealed };
    });

    await page.screenshot({ path: "artifacts/helm-release-values.png" });

    // ---- Long values wrap inside the sheet ----
    await step("longValuesWrap", async () => {
      const result = await section().evaluate((element) => {
        const pre = element.querySelector("pre");
        const sheetRect = document.querySelector(".sheet-right").getBoundingClientRect();
        let sheetOverflow = 0;
        element.querySelectorAll("*").forEach((node) => {
          const rect = node.getBoundingClientRect();
          if (rect.width > 0 && (rect.left < sheetRect.left - 1 || rect.right > sheetRect.right + 1)) sheetOverflow += 1;
        });
        return { preWraps: pre.scrollWidth <= pre.clientWidth + 1, sheetOverflow };
      });
      assert.equal(result.preWraps, true);
      assert.equal(result.sheetOverflow, 0);
      return result;
    });

    // ---- A release without supplied values shows the empty state ----
    await step("emptySuppliedValues", async () => {
      await closeSheet();
      await openRow("plain");
      await settled(false);
      const result = {
        empty: await section().locator(".detail-container-empty").innerText(),
        noPreview: await section().locator("pre").count() === 0,
        defaultsStillReachable: await (async () => {
          await section().getByRole("tab", { name: /Chart defaults/ }).click();
          return (await preview()).includes("replicaCount: 1");
        })(),
      };
      assert.equal(result.empty, "No values were supplied for this revision.");
      assert.equal(result.noPreview, true);
      assert.equal(result.defaultsStillReachable, true);
      return result;
    });

    // ---- The track lives in its own gutter and remains complete at both ends ----
    await step("scrollbarGutter", async () => {
      await closeSheet();
      await openRow("tall");
      await settled(true);
      await section().scrollIntoViewIfNeeded();
      const viewport = section().locator(".helm-values-code-viewport");
      await viewport.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await page.waitForTimeout(200);
      const bottom = await section().evaluate(measureScrollbar);
      const pixels = await sampleThumbPixels(page, bottom);
      await viewport.evaluate((node) => { node.scrollTop = 0; });
      await page.waitForTimeout(100);
      const top = await section().evaluate(measureScrollbar);
      assertScrollbarGeometry(top, bottom);
      assert.ok(pixels.colorDistance <= 20, `thumb bottom is not painted like its middle: ${JSON.stringify(pixels)}`);
      assert.ok(pixels.trackSeparation >= 30, `thumb bottom blends into its track: ${JSON.stringify(pixels)}`);
      await viewport.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await page.waitForTimeout(100);
      await page.screenshot({ path: "artifacts/helm-release-values-scrollbar.png", clip: await section().boundingBox() });
      return { top, bottom, pixels };
    });

    await step("scrollbarMatrix", async () => {
      const scenarios = [
        { name: "narrow-dpr1-light", viewport: { width: 1280, height: 900 }, sheetWidth: 320, dpr: 1, theme: "light" },
        { name: "default-dpr125-dark", viewport: { width: 1440, height: 900 }, sheetWidth: 410, dpr: 1.25, theme: "dark" },
        { name: "wide-dpr2-light", viewport: { width: 1600, height: 1000 }, sheetWidth: 640, dpr: 2, theme: "light" },
        { name: "viewport320-dpr1-dark", viewport: { width: 1280, height: 900 }, resizeTo: { width: 320, height: 900 }, sheetWidth: 320, expectedSheetWidth: 280, dpr: 1, theme: "dark" },
      ];
      const matrix = {};
      for (const scenario of scenarios) matrix[scenario.name] = await inspectScrollbarScenario(browser, scenario);
      return matrix;
    });

    results.runtimeErrors = runtimeErrors;
  } catch (error) {
    results.fatal = String(error && (error.stack || error.message || error));
    results.runtimeErrors = runtimeErrors;
  } finally {
    const failedSteps = Object.entries(results).filter(([, value]) => typeof value === "string" && value.startsWith("FAIL:"));
    const failed = failedSteps.length > 0 || Boolean(results.fatal) || (results.runtimeErrors?.length ?? 0) > 0;
    console.log(JSON.stringify(results, null, 2));
    await browser.close();
    if (failed) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
