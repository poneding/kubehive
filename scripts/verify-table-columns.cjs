const { chromium, webkit } = require("playwright");

const CLUSTER = {
  id: "demo", name: "demo-cluster", provider: "Local", region: "local", version: "v1.29",
  status: "healthy", nodes: 1, cpu: 2, memory: 4, context: "demo",
  server: "https://127.0.0.1:6443", defaultNamespace: "default", imported: true,
  disconnected: false, error: null,
};
const DESCRIPTORS = [
  { apiVersion: "v1", group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, verbs: ["get", "list", "watch", "delete"], categories: ["all"] },
];
const podName = (index) => `checkout-api-${index % 3 === 0 ? "long-production-name-".repeat(9) : ""}7d8f9b6c5d-${String(index).padStart(5, "0")}`;
const POD = (index) => ({
  key: `pods/checkout-api-7d8f9b6c5d-${index}`,
  name: podName(index),
  namespace: "payments-production",
  apiVersion: "v1",
  kind: "Pod",
  resourceVersion: "1",
  ageSeconds: 3_600 + index,
  object: {
    metadata: { name: podName(index), namespace: "payments-production", ownerReferences: [{ kind: "ReplicaSet", name: "checkout-api-7d8f9b6c5d" }] },
    spec: { nodeName: `ip-10-0-1-${index}.us-west-2.compute.internal`, containers: [{ name: "api", image: "registry.example.test/payments/checkout-api:1.4.2" }] },
    status: { phase: "Running", containerStatuses: [{ name: "api", ready: true, restartCount: index, state: { running: {} }, image: "registry.example.test/payments/checkout-api:1.4.2" }] },
  },
});
const ROWS = { Pod: Array.from({ length: 30 }, (_, index) => POD(index)) };

const WIDTHS_KEY = "kubehive.tableColumnWidths.resource:Pods";

const trackReport = () => {
  const viewport = document.querySelector(".workspace-scroll");
  const table = viewport.querySelector(".resource-table");
  const width = (selector) => {
    const node = viewport.querySelector(selector);
    return node ? Math.round(node.getBoundingClientRect().width) : 0;
  };
  const tracks = [...table.querySelectorAll("colgroup col")];
  // WebKit gives <col> no box, so the track total falls back to the header
  // cells — the same numbers under a fixed layout, on every engine.
  const trackWidths = tracks.every((track) => track.getBoundingClientRect().width > 0)
    ? tracks.map((track) => track.getBoundingClientRect().width)
    : [...table.querySelectorAll("thead th")].map((th) => th.getBoundingClientRect().width);
  // Room the table has before the workspace must pan: the scrollport less the
  // content inset and the panel's own borders, all read from the live styles.
  const panel = viewport.querySelector(".resource-table-panel");
  const content = viewport.querySelector(".workspace-scroll-content");
  const px = (style, ...sides) => sides.reduce((total, side) => total + (Number.parseFloat(style[side]) || 0), 0);
  const room = Math.round(viewport.clientWidth
    - px(getComputedStyle(content), "paddingLeft", "paddingRight")
    - px(getComputedStyle(panel), "borderLeftWidth", "borderRightWidth"));
  return {
    action: width("th.actions-col"),
    panel: Math.round(panel.clientWidth),
    room,
    age: width('th[data-column-id="age"]'),
    controlledBy: width('th[data-column-id="controlledBy"]'),
    name: width("th.name-col"),
    namespace: width('th[data-column-id="namespace"]'),
    restarts: width('th[data-column-id="restarts"]'),
    selection: width("th.selection-col"),
    table: Math.round(table.getBoundingClientRect().width),
    trackTotal: Math.round(trackWidths.reduce((total, trackWidth) => total + trackWidth, 0)),
    overflow: viewport.scrollWidth - viewport.clientWidth,
    viewport: viewport.clientWidth,
  };
};

const dragNameHandle = (page, dx) => dragHandle(page, "name", dx);

async function dragHandle(page, columnId, dx) {
  const handle = page.locator(`th[data-column-id="${columnId}"] .table-column-resize-handle`);
  const box = await handle.boundingBox();
  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // Keep the press-time distance from the cursor to the column edge constant.
  const grabOffset = await page.evaluate((id) => {
    const header = document.querySelector(`th[data-column-id="${id}"]`);
    return header ? header.getBoundingClientRect().right : null;
  }, columnId).then((edge) => edge === null ? null : startX - edge);
  await page.mouse.move(startX, y);
  await page.mouse.down();
  const gaps = [];
  for (let step = 1; step <= 6; step += 1) {
    const pointer = startX + (dx * step) / 6;
    await page.mouse.move(pointer, y);
    gaps.push(await page.evaluate(async ({ id, x }) => {
      // Read after the next animation frame so the measurement sees the DOM
      // React has committed for this pointer move, not the previous one.
      await new Promise(requestAnimationFrame);
      const guide = document.querySelector(".table-resize-guide");
      return guide ? Math.round(guide.getBoundingClientRect().left - x) : null;
    }, { id: columnId, x: pointer }));
  }
  const tracking = await page.evaluate((id) => {
    const header = document.querySelector(`th[data-column-id="${id}"]`);
    const guide = document.querySelector(".table-resize-guide");
    return { edge: header.getBoundingClientRect().right, guide: guide ? guide.getBoundingClientRect().left : null };
  }, columnId);
  await page.mouse.up();
  // Check the first movement too: no initial lag followed by a catch-up jump.
  const guideFollowsCursor = gaps.every((gap) => gap !== null && Math.abs(gap + grabOffset) <= 1);
  return { grabOffset: grabOffset === null ? null : Math.round(grabOffset), guideOnEdge: tracking.guide !== null && Math.abs(tracking.guide - tracking.edge) <= 1, guideGaps: gaps, guideFollowsCursor };
}

async function traceNameDrag(page, offsets, gripOffset = 0) {
  const measure = () => page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    const header = document.querySelector('th[data-column-id="name"]');
    const grip = header.querySelector(".table-column-resize-handle");
    const guide = document.querySelector(".table-resize-guide");
    const rect = header.getBoundingClientRect();
    // The visible divider is the grip's pseudo-element, not the header edge
    // or the wider pointer target. A one-pixel tolerance hid their misalignment.
    const divider = getComputedStyle(grip, "::after");
    const dividerWidth = Number.parseFloat(divider.width);
    const dividerLeft = grip.getBoundingClientRect().right - Number.parseFloat(divider.right) - dividerWidth;
    return {
      edge: rect.right, width: rect.width,
      guide: guide?.getBoundingClientRect().left ?? null,
      guideWidth: guide?.getBoundingClientRect().width ?? null,
      dividerLeft, dividerWidth,
      min: Number(grip.getAttribute("aria-valuemin")), max: Number(grip.getAttribute("aria-valuemax")),
    };
  });
  const grip = await page.locator('th[data-column-id="name"] .table-column-resize-handle').boundingBox();
  const x = grip.x + grip.width / 2 + gripOffset;
  const y = grip.y + grip.height / 2;
  const before = await measure();
  await page.mouse.move(x, y);
  await page.mouse.down();
  const pressed = await measure();
  const frames = [];
  for (const offset of offsets) {
    await page.mouse.move(x + offset, y);
    frames.push({ offset, ...await measure() });
  }
  await page.mouse.up();
  const released = await measure();
  const last = frames.at(-1);
  return {
    gripOffset, before, frames, released,
    guideVisibleOnPress: pressed.guide !== null && Math.abs(pressed.guide - before.edge) <= 1,
    guideAlignedWithHandle: [pressed, ...frames].every((frame) => frame.guide !== null
      && Math.abs(frame.guide - frame.dividerLeft) < .01 && Math.abs(frame.guideWidth - frame.dividerWidth) < .01),
    tracksEveryMove: frames.every((frame) => {
      const width = Math.min(before.max, Math.max(before.min, before.width + frame.offset));
      const edge = before.edge + width - before.width;
      return Math.abs(frame.width - width) <= 1 && Math.abs(frame.edge - edge) <= 1
        && frame.guide !== null && Math.abs(frame.guide - edge) <= 1;
    }),
    pressAndReleaseStable: pressed.width === before.width && pressed.edge === before.edge
      && released.width === last.width && released.edge === last.edge && released.guide === null,
  };
}

async function openPods(page) {
  await page.locator(".cluster-home-avatar").first().click();
  await page.getByRole("button", { name: "Pods", exact: true }).click();
  await page.locator(".workspace-scroll tbody tr[data-index]").first().waitFor();
}

(async () => {
  const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";
  const browserType = process.env.KUBEHIVE_TEST_BROWSER === "webkit" ? webkit : chromium;
  const browser = await browserType.launch({ headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
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
    await openPods(page);

    // 1. Above the minimum width the table owns the panel exactly, and the room
    //    goes to identities and references rather than counters and ages.
    const measured = [];
    for (const width of [1600, 1400, 1200, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(120);
      measured.push({ window: width, ...await page.evaluate(trackReport) });
    }
    const [widest, ...narrower] = measured;
    const fitting = measured.filter((row) => row.overflow === 0);
    // Every track adds up to the table, and the table to the panel it sits in:
    // no rounding leftover, no stray pixel of horizontal scroll.
    const fillsPanel = fitting.length >= 2 && fitting.every((row) => row.trackTotal === row.table && row.table === row.room);
    const identitiesAbsorb = narrower.every((row) => widest.name > row.name && widest.namespace > row.namespace && widest.controlledBy > row.controlledBy);
    // Counters and timestamps stop at their comfortable width while the room
    // keeps going to the identity column; the fixed tracks never move at all.
    const narrowestFitting = fitting[fitting.length - 1];
    const steadyColumns = fitting.every((row) => row.age <= 88 && row.restarts <= 95)
      && (widest.name - narrowestFitting.name) > 4 * (widest.age - narrowestFitting.age)
      && measured.every((row) => row.action === 44 && row.selection === 36);
    // The floors leave the default Pods columns fitting a 1200px window.
    const defaultColumnsFitLaptop = measured.every((row) => row.window > 1_100 === (row.overflow === 0));

    // 2. Below it the table holds one floor and the workspace pans sideways.
    const floors = [];
    for (const width of [900, 700]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(120);
      floors.push({ window: width, ...await page.evaluate(trackReport) });
    }
    const scrollsBelowFloor = floors.every((row) => row.overflow > 0 && row.table > row.room);
    const stableFloor = floors[0].table === floors[1].table;
    const floorReachesFullContent = await page.evaluate(() => {
      const viewport = document.querySelector(".workspace-scroll");
      viewport.scrollLeft = viewport.scrollWidth;
      const table = document.querySelector(".resource-table").getBoundingClientRect();
      const action = document.querySelector("th.actions-col").getBoundingClientRect();
      return action.right <= table.right + 1 && action.right - 1 <= viewport.getBoundingClientRect().right;
    });

    // 3. Dragging tracks the pointer and takes the room from the right.
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(120);
    const before = await page.evaluate(trackReport);
    const longNamesEllipsize = await page.locator("td.name-col strong").evaluateAll((names) => names.some((name) =>
      name.textContent.length > 100 && name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === "ellipsis"));
    const tracking = await dragNameHandle(page, 180);
    const afterGrow = await page.evaluate(trackReport);
    const dragFollowsPointer = Math.abs(afterGrow.name - (before.name + 180)) <= 2;
    // The guide line follows every movement, including the first one.
    const guideFollowsCursor = tracking.guideFollowsCursor;
    const rightSideAbsorbs = afterGrow.overflow === 0 && afterGrow.namespace < before.namespace && afterGrow.table === before.table;
    const persisted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), WIDTHS_KEY);

    // 4. Once the columns on the right are down to their floors the table grows
    //    and the workspace pans: the grip keeps following the pointer either way.
    await dragNameHandle(page, 700);
    const afterLimit = await page.evaluate(trackReport);
    const dragKeepsTracking = Math.abs(afterLimit.name - (afterGrow.name + 700)) <= 2
      && afterLimit.overflow > 0 && afterLimit.table > afterLimit.room
      && [afterLimit.namespace, afterLimit.controlledBy].every((width) => width === 100)
      && afterLimit.age === 62 && afterLimit.restarts === 60;

    // 4b. A late column is as free as the first one — the columns after it give
    //     up their room, then the table grows. The bug this guards: a resize
    //     bounded by the window leaves the last columns unable to move at all.
    await page.evaluate((key) => localStorage.removeItem(key), WIDTHS_KEY);
    await page.reload({ waitUntil: "networkidle" });
    await openPods(page);
    const lateBefore = await page.evaluate(trackReport);
    const lateDrag = await dragHandle(page, "controlledBy", 150);
    const lateAfter = await page.evaluate(trackReport);
    const lateColumnTracksPointer = Math.abs(lateAfter.controlledBy - (lateBefore.controlledBy + 150)) <= 2
      && lateAfter.name === lateBefore.name && lateDrag.guideFollowsCursor;

    // 4c. A pinned width raises the table's floor: the window pans rather than
    //     taking back the width the user asked for.
    const narrowed = [];
    for (const width of [1_400, 1_200]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(120);
      narrowed.push({ window: width, ...await page.evaluate(trackReport) });
    }
    const pinnedWidthHoldsFloor = narrowed.every((row) => row.controlledBy === lateAfter.controlledBy && row.overflow > 0);
    await page.setViewportSize({ width: 1_600, height: 900 });
    await page.waitForTimeout(120);

    // 4d. Long names cannot move the edge independently of the mouse. Exercise
    //     small movements, reversals, off-centre presses, clamping and a drag
    //     with only one pointermove: none may lag or add a catch-up correction.
    const preciseDrags = [];
    for (const scenario of [
      { name: "slow grow", offsets: [1, 2, 3, 4, 5, 6, 8, 12, 20] },
      { name: "slow shrink", offsets: [-1, -2, -3, -4, -5, -6, -8, -12, -20] },
      { name: "reverse direction", offsets: [4, 6, 10, 8, 4, 0, -4, -10, 0, 8] },
      { name: "single movement", offsets: [64] },
      { name: "left of divider", gripOffset: -4, offsets: [4, 8, 5, 0, -5, -12] },
      { name: "right of divider", gripOffset: 4, offsets: [-4, -8, -5, 0, 5, 12] },
      { name: "minimum width", offsets: [-260, -280, -220, -180] },
    ]) {
      preciseDrags.push({ name: scenario.name, ...await traceNameDrag(page, scenario.offsets, scenario.gripOffset) });
    }
    const everyMovementTracks = preciseDrags.every((drag) => drag.tracksEveryMove);
    const guideVisibleOnPress = preciseDrags.every((drag) => drag.guideVisibleOnPress);
    const pressAndReleaseStable = preciseDrags.every((drag) => drag.pressAndReleaseStable);

    // 4e. Older saved settings may pin every visible column. Resizing Name
    //     must not add the layout's spare space to its requested width again.
    const savedWidths = { name: 220, namespace: 100, status: 94, containers: 72, restarts: 60, node: 100, controlledBy: 100, age: 62 };
    await page.evaluate(({ key, widths }) => localStorage.setItem(key, JSON.stringify(widths)), { key: WIDTHS_KEY, widths: savedWidths });
    await page.reload({ waitUntil: "networkidle" });
    await openPods(page);
    const savedWidthDrags = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      savedWidthDrags.push(await traceNameDrag(page, [1, 2, 4, 2, 0, -4, 8]));
    }
    const savedWidthsTrack = savedWidthDrags[0].before.width === savedWidths.name
      && savedWidthDrags.every((drag) => drag.tracksEveryMove && drag.guideVisibleOnPress && drag.pressAndReleaseStable);

    // 4f. The same state can arise through the UI: resize a late column, then
    //     hide the final automatic column. Check another press after growing
    //     the window, which leaves even more space for the layout to fill.
    await page.evaluate((key) => localStorage.removeItem(key), WIDTHS_KEY);
    await page.reload({ waitUntil: "networkidle" });
    await openPods(page);
    await dragHandle(page, "controlledBy", -30);
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.getByRole("checkbox", { name: "Age", exact: true }).click();
    await page.keyboard.press("Escape");
    const hiddenLastColumnDrags = [await traceNameDrag(page, [1, 2, 4, 0, -4, 8])];
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.waitForTimeout(120);
    hiddenLastColumnDrags.push(await traceNameDrag(page, [-1, -2, -4, 0, 4, -8]));
    const hiddenLastColumnTracks = hiddenLastColumnDrags.every((drag) => drag.tracksEveryMove && drag.guideVisibleOnPress && drag.pressAndReleaseStable);
    const guideAlignedWithHandle = [...preciseDrags, ...savedWidthDrags, ...hiddenLastColumnDrags].every((drag) => drag.guideAlignedWithHandle);
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.getByRole("checkbox", { name: "Age", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1600, height: 900 });

    await page.evaluate((key) => localStorage.removeItem(key), WIDTHS_KEY);
    await page.reload({ waitUntil: "networkidle" });
    await openPods(page);
    await dragNameHandle(page, 180);
    await dragNameHandle(page, 700);

    // 5. A saved width survives a reload; the header menu puts the column back.
    await page.reload({ waitUntil: "networkidle" });
    await openPods(page);
    const restored = await page.evaluate(trackReport);
    const widthRestored = restored.name === afterLimit.name;
    await page.locator('th[data-column-id="name"]').click({ button: "right" });
    await page.locator(".context-menu-item, [role=menuitem]").filter({ hasText: /Auto width/i }).click();
    await page.waitForTimeout(120);
    const afterReset = await page.evaluate(trackReport);
    const resetToAuto = afterReset.name === before.name && afterReset.overflow === 0;

    // 5b. Pressing and double-clicking a grip without moving must never resize
    //     or pin columns; even a one-pixel movement is covered as a drag above.
    const clicked = await page.locator('th[data-column-id="namespace"] .table-column-resize-handle').boundingBox();
    const gripX = clicked.x + clicked.width / 2;
    const gripY = clicked.y + clicked.height / 2;
    await page.mouse.move(gripX, gripY);
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.click(gripX, gripY, { clickCount: 2, delay: 40 });
    await page.waitForTimeout(150);
    const afterClicks = await page.evaluate(trackReport);
    const clickIsInert = JSON.stringify(afterClicks) === JSON.stringify(afterReset)
      && await page.evaluate((key) => localStorage.getItem(key) === null, WIDTHS_KEY);

    // 6. The header menu carries the same escape hatch for every column.
    await page.locator('th[data-column-id="namespace"] .table-column-resize-handle').press("ArrowRight");
    await page.locator('th[data-column-id="age"]').click({ button: "right" });
    const menuItems = await page.locator(".context-menu-item, [role=menuitem]").allTextContents();
    const menuOffersReset = menuItems.some((label) => /Reset all column widths/i.test(label));
    await page.keyboard.press("Escape");
    const keyboardResized = await page.evaluate((key) => Boolean(JSON.parse(localStorage.getItem(key) ?? "null")?.namespace), WIDTHS_KEY);

    // 7. Pinning every adapting column narrow leaves room nothing claims. The
    //    action column keeps its own width and the table still spans the panel.
    await page.locator('th[data-column-id="age"]').click({ button: "right" });
    await page.locator(".context-menu-item, [role=menuitem]").filter({ hasText: /Reset all column widths/i }).click();
    await page.waitForTimeout(120);
    const handle = page.locator('th[data-column-id="controlledBy"] .table-column-resize-handle');
    const grip = await handle.boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - 500, grip.y + grip.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const narrowedTable = await page.evaluate(trackReport);
    // Whatever the user gives up goes to a data column: the action column keeps
    // its own width and the table still spans the panel.
    const actionStaysMinimal = narrowedTable.action === 44 && narrowedTable.table === narrowedTable.room && narrowedTable.overflow === 0;
    const lastColumnHasNoGrip = await page.evaluate(() => {
      const headers = [...document.querySelectorAll(".workspace-scroll thead th[data-column-id]")];
      const grips = headers.map((header) => header.querySelectorAll(".table-column-resize-handle").length);
      return grips.length > 2 && grips.at(-1) === 0 && grips.slice(0, -1).every((count) => count === 1);
    });

    const result = {
      measured, floors, before, afterGrow, afterLimit, lateBefore, lateAfter, narrowed, preciseDrags, savedWidthDrags, hiddenLastColumnDrags, afterReset, afterClicks, narrowedTable, tracking, lateDrag, persisted, menuItems,
      checks: {
        fillsPanel, identitiesAbsorb, steadyColumns, defaultColumnsFitLaptop, scrollsBelowFloor, stableFloor, floorReachesFullContent,
        dragFollowsPointer, guideOnEdge: tracking.guideOnEdge, guideFollowsCursor, rightSideAbsorbs, pinnedPersisted: persisted?.name === afterGrow.name,
        dragKeepsTracking, lateColumnTracksPointer, pinnedWidthHoldsFloor, longNamesEllipsize, everyMovementTracks, guideVisibleOnPress, guideAlignedWithHandle, pressAndReleaseStable, savedWidthsTrack, hiddenLastColumnTracks, widthRestored, resetToAuto, clickIsInert, menuOffersReset, keyboardResized, actionStaysMinimal, lastColumnHasNoGrip,
      },
      errors,
    };
    console.log(JSON.stringify(result, null, 2));
    if (Object.values(result.checks).some((passed) => !passed) || errors.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
