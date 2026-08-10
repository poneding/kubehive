const { chromium } = require("playwright");

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";

function collectRuntimeErrors(page, errors) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
}

async function resetApp(page, viewportTheme = "dark") {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate((theme) => {
    localStorage.clear();
    localStorage.setItem("kubehive.preferences", JSON.stringify({ language: "en", theme }));
  }, viewportTheme);
  await page.reload({ waitUntil: "networkidle" });
}

async function unmountHarness(page) {
  await page.evaluate(() => {
    window.__kubehiveFoundationRoot?.unmount();
    window.__kubehiveFoundationRoot = undefined;
    document.getElementById("ui-foundation-harness")?.remove();
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  collectRuntimeErrors(page, errors);
  await resetApp(page);

  // The app-level provider and migrated settings switch work in the real shell.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const proxySwitch = page.getByRole("switch", { name: "Enable proxy", exact: true });
  const switchBefore = {
    state: await proxySwitch.getAttribute("data-state"),
    checked: await proxySwitch.getAttribute("aria-checked"),
    radixThumb: await proxySwitch.locator("i.ui-switch-thumb").count() === 1,
  };
  await proxySwitch.click();
  const switchAfter = {
    state: await proxySwitch.getAttribute("data-state"),
    checked: await proxySwitch.getAttribute("aria-checked"),
  };
  await page.getByRole("button", { name: "Close", exact: true }).click();

  // Add Cluster exercises the migrated Dialog and controlled Radix Tabs.
  const addClusterTrigger = page.getByRole("button", { name: "Add cluster", exact: true }).first();
  await addClusterTrigger.click();
  const addClusterDialog = page.getByRole("dialog", { name: "Add cluster", exact: true });
  await addClusterDialog.waitFor();
  const addClusterLayout = await addClusterDialog.evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect();
    const style = getComputedStyle(dialog);
    const overlay = document.querySelector(".modal-backdrop");
    const activeTab = dialog.querySelector('[role="tab"][data-state="active"]');
    const activePanel = dialog.querySelector('[role="tabpanel"]:not([hidden])');
    return {
      compactWidth: Math.abs(bounds.width - 570) <= 1,
      dialogContentSlot: dialog.getAttribute("data-slot") === "dialog-content",
      legacyTop: Math.round(bounds.top) === Math.round(innerHeight * .09),
      opaqueSurface: style.backgroundColor !== "rgba(0, 0, 0, 0)",
      bordered: parseFloat(style.borderWidth) === 1,
      shadowed: style.boxShadow !== "none",
      stackedAboveOverlay: Number(style.zIndex) > Number(overlay && getComputedStyle(overlay).zIndex),
      semanticTabs: dialog.querySelectorAll('[role="tab"]').length === 3,
      linkedPanel: Boolean(activeTab?.id && activePanel?.id)
        && activeTab?.getAttribute("aria-controls") === activePanel?.id
        && activePanel?.getAttribute("aria-labelledby") === activeTab?.id,
    };
  });
  const addTabs = addClusterDialog.getByRole("tab");
  await addTabs.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((label) => [...document.querySelectorAll('[role="tab"][data-state="active"]')].some((tab) => tab.textContent?.trim() === label), "Paste config");
  const arrowSelected = (await addClusterDialog.locator('[role="tab"][data-state="active"]').textContent())?.trim() === "Paste config";
  await page.keyboard.press("End");
  await page.waitForFunction((label) => [...document.querySelectorAll('[role="tab"][data-state="active"]')].some((tab) => tab.textContent?.trim() === label), "Manual");
  const endSelected = (await addClusterDialog.locator('[role="tab"][data-state="active"]').textContent())?.trim() === "Manual";
  await page.keyboard.press("Home");
  await page.waitForFunction((label) => [...document.querySelectorAll('[role="tab"][data-state="active"]')].some((tab) => tab.textContent?.trim() === label), "Kubeconfig file");
  const homeSelected = (await addClusterDialog.locator('[role="tab"][data-state="active"]').textContent())?.trim() === "Kubeconfig file";
  await page.screenshot({ path: "artifacts/shadcn-radix-foundation-desktop.png", fullPage: true });
  await page.keyboard.press("Escape");
  await addClusterDialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Add cluster");
  const dialogRestoresFocus = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Add cluster");

  // Column Picker exercises composed Tooltip + Popover triggers and Radix checkboxes.
  await page.evaluate(async () => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { ColumnPicker } = await import("/src/column-picker.tsx");
    const { Button } = await import("/src/components/ui/button.tsx");
    const { TooltipProvider } = await import("/src/components/ui/tooltip.tsx");
    const host = document.createElement("div");
    host.id = "ui-foundation-harness";
    host.style.cssText = "position:fixed;right:30px;top:30px;z-index:500;padding:20px;background:#111";
    document.body.append(host);
    function Harness() {
      const [visible, setVisible] = React.useState(["name", "status"]);
      const defs = [
        { id: "name", label: "Name", required: true, defaultVisible: true },
        { id: "status", label: "Status", required: false, defaultVisible: true },
        { id: "age", label: "Age", required: false, defaultVisible: false },
      ];
      return React.createElement(React.Fragment, null,
        React.createElement(Button, { id: "foundation-secondary-button", variant: "secondary" }, "Secondary"),
        React.createElement(ColumnPicker, {
          resource: "FoundationHarness",
          language: "en",
          defs,
          isVisible: (id) => visible.includes(id),
          onToggle: (id, next) => setVisible((current) => next
            ? [...new Set([...current, id])]
            : current.filter((item) => item !== id)),
          onReset: () => setVisible(["name", "status"]),
        }),
      );
    }
    window.__kubehiveFoundationRoot = ReactDOM.createRoot(host);
    window.__kubehiveFoundationRoot.render(
      React.createElement(TooltipProvider, { delayDuration: 0 }, React.createElement(Harness)),
    );
  });
  const columnTrigger = page.getByRole("button", { name: "Columns", exact: true });
  await columnTrigger.waitFor();
  const secondaryButtonHook = await page.locator("#foundation-secondary-button").evaluate((button) => button.classList.contains("ui-button-secondary"));
  await columnTrigger.hover();
  const tooltipVisible = await page.getByRole("tooltip").getByText("Columns", { exact: true }).isVisible();
  await columnTrigger.click();
  const columnMenu = page.getByRole("menu", { name: "Columns", exact: true });
  await columnMenu.waitFor();
  const popoverContentSlot = await columnMenu.getAttribute("data-slot") === "popover-content";
  const columnMenuBounds = await columnMenu.boundingBox();
  const columnInitial = {
    requiredDisabled: await columnMenu.getByRole("checkbox", { name: "Name", exact: true }).isDisabled(),
    status: await columnMenu.getByRole("checkbox", { name: "Status", exact: true }).getAttribute("data-state"),
    age: await columnMenu.getByRole("checkbox", { name: "Age", exact: true }).getAttribute("data-state"),
  };
  await columnMenu.getByText("Status", { exact: true }).click();
  await columnMenu.getByText("Age", { exact: true }).click();
  const columnToggled = {
    status: await columnMenu.getByRole("checkbox", { name: "Status", exact: true }).getAttribute("data-state"),
    age: await columnMenu.getByRole("checkbox", { name: "Age", exact: true }).getAttribute("data-state"),
  };
  await columnMenu.locator(".column-picker-reset").click();
  const columnReset = {
    status: await columnMenu.getByRole("checkbox", { name: "Status", exact: true }).getAttribute("data-state"),
    age: await columnMenu.getByRole("checkbox", { name: "Age", exact: true }).getAttribute("data-state"),
  };
  await page.keyboard.press("Escape");
  await columnMenu.waitFor({ state: "detached" });
  const columnPicker = {
    popoverContentSlot,
    tooltipVisible,
    collisionBounded: Boolean(columnMenuBounds)
      && columnMenuBounds.x >= 8
      && columnMenuBounds.y >= 8
      && columnMenuBounds.x + columnMenuBounds.width <= 1432
      && columnMenuBounds.y + columnMenuBounds.height <= 892,
    initial: columnInitial,
    toggled: columnToggled,
    reset: columnReset,
  };
  await unmountHarness(page);

  // The virtual table proves the migrated bulk-selection path and indeterminate icon.
  await page.evaluate(async () => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { VirtualResourceTable } = await import("/src/table-extras.tsx");
    const host = document.createElement("div");
    host.id = "ui-foundation-harness";
    host.className = "resource-table-panel";
    host.style.cssText = "position:fixed;left:100px;top:100px;width:700px;z-index:500;background:#111";
    document.body.append(host);
    const rows = [1, 2, 3].map((index) => ({
      key: `pod-${index}`,
      name: `pod-${index}`,
      namespace: "default",
      kind: "Pod",
      status: "Running",
      data: {},
    }));
    const columns = [{ id: "name", label: "Name", render: (row) => row.name }];
    function Harness() {
      const [selected, setSelected] = React.useState(new Set());
      return React.createElement(
        "div",
        null,
        React.createElement("output", { id: "foundation-selected-count" }, String(selected.size)),
        React.createElement(VirtualResourceTable, {
          rows,
          columns,
          tableKey: "foundation-harness",
          selectedKeys: selected,
          onSelectionChange: setSelected,
        }),
      );
    }
    window.__kubehiveFoundationRoot = ReactDOM.createRoot(host);
    window.__kubehiveFoundationRoot.render(React.createElement(Harness));
  });
  const selectAll = page.getByRole("checkbox", { name: "Select all visible resources", exact: true });
  await selectAll.waitFor();
  await page.getByRole("checkbox", { name: "Select Pod pod-1", exact: true }).click();
  const tablePartial = {
    count: await page.locator("#foundation-selected-count").textContent(),
    state: await selectAll.getAttribute("data-state"),
    minusVisible: await selectAll.locator(".ui-checkbox-minus").isVisible(),
    checkHidden: !await selectAll.locator(".ui-checkbox-check").isVisible(),
  };
  await selectAll.click();
  const tableAll = {
    count: await page.locator("#foundation-selected-count").textContent(),
    state: await selectAll.getAttribute("data-state"),
    checkedControls: await page.locator(".resource-selection-checkbox[data-state=checked]").count(),
  };
  await selectAll.click();
  const tableCleared = {
    count: await page.locator("#foundation-selected-count").textContent(),
    state: await selectAll.getAttribute("data-state"),
  };
  await unmountHarness(page);

  // Cluster Settings proves the migrated Dialog/Input path and busy-dismiss guard.
  await page.evaluate(async () => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { ClusterSettingsDialog } = await import("/src/context-menu.tsx");
    const host = document.createElement("div");
    host.id = "ui-foundation-harness";
    document.body.append(host);
    window.__kubehiveClusterSettings = {};
    function Harness() {
      const [open, setOpen] = React.useState(true);
      if (!open) return null;
      return React.createElement(ClusterSettingsDialog, {
        clusterName: "demo",
        color: "#55d49a",
        language: "en",
        onSave: async (name, color) => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          window.__kubehiveClusterSettings.saved = { name, color };
        },
        onClose: () => {
          window.__kubehiveClusterSettings.closed = true;
          setOpen(false);
        },
      });
    }
    window.__kubehiveFoundationRoot = ReactDOM.createRoot(host);
    window.__kubehiveFoundationRoot.render(React.createElement(Harness));
  });
  const clusterDialog = page.getByRole("dialog", { name: "Cluster settings", exact: true });
  await clusterDialog.waitFor();
  const clusterDialogLayout = await clusterDialog.evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect();
    const style = getComputedStyle(dialog);
    const overlay = document.querySelector(".modal-backdrop");
    return {
      compactWidth: Math.abs(bounds.width - 420) <= 1,
      opaqueSurface: style.backgroundColor !== "rgba(0, 0, 0, 0)",
      bordered: parseFloat(style.borderWidth) === 1,
      shadowed: style.boxShadow !== "none",
      stackedAboveOverlay: Number(style.zIndex) > Number(overlay && getComputedStyle(overlay).zIndex),
      nameAutofocused: document.activeElement?.classList.contains("cluster-name-input") === true,
    };
  });
  await clusterDialog.getByRole("textbox", { name: "Cluster name", exact: true }).fill("renamed");
  await clusterDialog.getByRole("button", { name: "Select #3b82f6", exact: true }).click();
  await clusterDialog.getByRole("button", { name: "Save", exact: true }).click();
  const clusterDialogHandle = await clusterDialog.elementHandle();
  if (!clusterDialogHandle) throw new Error("Cluster settings dialog is not attached");
  await page.waitForFunction((dialog) => ["Cancel", "Save"].every((label) => [...dialog.querySelectorAll("button")].some((button) => button.textContent?.trim() === label && button.disabled)), clusterDialogHandle);
  await page.keyboard.press("Escape");
  const busyDismissGuard = await clusterDialog.isVisible();
  await clusterDialog.waitFor({ state: "detached" });
  const clusterSettingsResult = await page.evaluate(() => window.__kubehiveClusterSettings);
  await unmountHarness(page);

  // A narrow viewport checks that the compact legacy geometry still fits.
  const mobileErrors = [];
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  collectRuntimeErrors(mobile, mobileErrors);
  await resetApp(mobile);
  await mobile.getByRole("button", { name: "Add cluster", exact: true }).first().click();
  const mobileDialog = mobile.getByRole("dialog", { name: "Add cluster", exact: true });
  await mobileDialog.getByRole("tab", { name: "Manual", exact: true }).click();
  const mobileLayout = await mobileDialog.evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect();
    const tabs = dialog.querySelector('[role="tablist"]');
    const footer = dialog.querySelector(":scope > footer");
    return {
      withinViewport: bounds.left >= 8 && bounds.right <= innerWidth - 8 && bounds.top >= 8 && bounds.bottom <= innerHeight - 8,
      tabsFit: Boolean(tabs) && tabs.scrollWidth <= tabs.clientWidth,
      footerFits: Boolean(footer) && footer.scrollWidth <= footer.clientWidth,
      noPageOverflow: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
    };
  });
  await mobile.screenshot({ path: "artifacts/shadcn-radix-foundation-mobile.png", fullPage: true });

  const result = {
    switchBefore,
    switchAfter,
    addClusterLayout,
    tabsKeyboard: { arrowSelected, endSelected, homeSelected },
    dialogRestoresFocus,
    secondaryButtonHook,
    columnPicker,
    tablePartial,
    tableAll,
    tableCleared,
    clusterDialogLayout,
    busyDismissGuard,
    clusterSettingsResult,
    mobileLayout,
    errors: [...errors, ...mobileErrors],
  };
  console.log(JSON.stringify(result, null, 2));

  const passed = switchBefore.state === "unchecked"
    && switchBefore.checked === "false"
    && switchBefore.radixThumb
    && switchAfter.state === "checked"
    && switchAfter.checked === "true"
    && Object.values(addClusterLayout).every(Boolean)
    && arrowSelected
    && endSelected
    && homeSelected
    && dialogRestoresFocus
    && secondaryButtonHook
    && columnPicker.popoverContentSlot
    && columnPicker.tooltipVisible
    && columnPicker.collisionBounded
    && columnPicker.initial.requiredDisabled
    && columnPicker.initial.status === "checked"
    && columnPicker.initial.age === "unchecked"
    && columnPicker.toggled.status === "unchecked"
    && columnPicker.toggled.age === "checked"
    && columnPicker.reset.status === "checked"
    && columnPicker.reset.age === "unchecked"
    && tablePartial.count === "1"
    && tablePartial.state === "indeterminate"
    && tablePartial.minusVisible
    && tablePartial.checkHidden
    && tableAll.count === "3"
    && tableAll.state === "checked"
    && tableAll.checkedControls === 4
    && tableCleared.count === "0"
    && tableCleared.state === "unchecked"
    && Object.values(clusterDialogLayout).every(Boolean)
    && busyDismissGuard
    && clusterSettingsResult.closed === true
    && clusterSettingsResult.saved?.name === "renamed"
    && clusterSettingsResult.saved?.color === "#3b82f6"
    && Object.values(mobileLayout).every(Boolean)
    && result.errors.length === 0;

  await browser.close();
  if (!passed) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
