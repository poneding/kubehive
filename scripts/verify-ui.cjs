const { chromium } = require("playwright");
const rgb = (value) => (value.match(/\d+/g) || []).slice(0, 3).map(Number);
const isLight = (value) => { const channels = rgb(value); return channels.length === 3 && Math.min(...channels) >= 215; };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.goto("http://localhost:1420", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  const initial = await page.evaluate(() => {
    const tabs = document.querySelector(".workspace-tabs").getBoundingClientRect();
    const overview = document.querySelector(".workspace-tab-list > button");
    const command = document.querySelector(".tabs-command");
    const commandBox = command.getBoundingClientRect();
    const navSearch = document.querySelector(".resource-nav .nav-search");
    const navStyle = getComputedStyle(navSearch);
    return {
      tabsAtTop: tabs.top === 0,
      overviewPermanent: !overview.querySelector("i"),
      overviewCompact: overview.offsetHeight === 30 && overview.offsetWidth < 130,
      tabIconVisible: Boolean(overview.querySelector(".tab-icon")),
      commandSameRow: commandBox.top >= tabs.top && commandBox.bottom <= tabs.bottom,
      commandInsetBorder: getComputedStyle(command).boxShadow.includes("inset") && commandBox.right < innerWidth,
      commandRadiusConsistent: getComputedStyle(command).borderRadius === getComputedStyle(navSearch).borderRadius,
      navSearchRestored: navStyle.marginLeft === "0px" && navStyle.boxShadow === "none" && navStyle.borderRightWidth === "1px" && navStyle.borderBottomWidth === "1px",
      noOverviewGroupHeading: ![...document.querySelectorAll(".resource-nav section > p")].some((node) => node.textContent.trim() === "Overview"),
    };
  });

  const referenceResources = ["Nodes", "Namespaces", "Events", "ReplicaSets", "Replication Controllers", "Jobs", "CronJobs", "Limit Ranges", "Horizontal Pod Autoscalers", "Vertical Pod Autoscalers", "Pod Disruption Budgets", "Priority Classes", "Runtime Classes", "Leases", "Mutating Webhook Configs", "Validating Webhook Configs", "Endpoints", "Ingress Classes", "Port Forwarding", "Persistent Volume Claims", "Helm Charts", "Cluster Roles", "Cluster Role Bindings", "Pod Security Policies"];
  const referenceResourceMenu = await page.locator(".resource-nav nav button").evaluateAll((buttons, expected) => {
    const labels = new Set(buttons.map((button) => button.getAttribute("aria-label")));
    return expected.every((item) => labels.has(item)) && !labels.has("Jobs & CronJobs");
  }, referenceResources);

  // Global auto-hiding scrollbar chrome.
  const scrollTarget = page.locator(".resource-nav > nav");
  const scrollbarAtRest = await scrollTarget.evaluate((element) => getComputedStyle(element, "::-webkit-scrollbar").width);
  await scrollTarget.dispatchEvent("wheel", { deltaY: 60 });
  const scrollbarVisible = await scrollTarget.evaluate((element) => ({ active: element.classList.contains("is-scrolling"), width: getComputedStyle(element, "::-webkit-scrollbar").width, track: getComputedStyle(element, "::-webkit-scrollbar-track").backgroundColor, border: getComputedStyle(element, "::-webkit-scrollbar-track").borderLeftWidth, button: getComputedStyle(element, "::-webkit-scrollbar-button").width }));
  await page.waitForTimeout(1050);
  const scrollbarHiddenAgain = await scrollTarget.evaluate((element) => !element.classList.contains("is-scrolling"));

  // Settings dialog only reacts to precise controls and does not scroll when content fits.
  await page.getByTitle("Settings").click();
  const settings = page.locator(".settings-modal");
  const settingsTitleHeight = await settings.locator(".settings-header").evaluate((header) => header.getBoundingClientRect().height);
  const settingsLayout = await settings.evaluate((element) => { const scroll = element.querySelector(".settings-scroll"); return { centered: Math.abs(element.getBoundingClientRect().left + element.getBoundingClientRect().width / 2 - innerWidth / 2) < 2, contentFits: scroll.scrollHeight <= scroll.clientHeight, scrollbarHidden: getComputedStyle(scroll, "::-webkit-scrollbar").width === "0px", updateButtonInTitle: Boolean(element.querySelector(".settings-section:last-child .settings-section-title > button")), noUpdateRow: !element.querySelector(".update-row") }; });
  const firstRow = settings.locator(".settings-row").first();
  await firstRow.locator("span").click();
  const rowClickDidNotEdit = await settings.locator(".combobox-popover:visible").count() === 0;
  const proxyRow = settings.locator(".settings-section").nth(2).locator(".settings-row");
  const proxyToggle = proxyRow.getByRole("button", { name: "Enable proxy" });
  const proxyBefore = await proxyToggle.getAttribute("aria-pressed");
  await proxyRow.locator("span").click();
  const switchRowClickDidNotEdit = await proxyToggle.getAttribute("aria-pressed") === proxyBefore;

  const settingCombos = settings.locator(".combobox-trigger");
  await settingCombos.nth(0).click();
  const settingComboWidthsMatch = await settingCombos.nth(0).evaluate((trigger) => Math.abs(trigger.getBoundingClientRect().width - document.querySelector(".settings-modal .combobox-popover").getBoundingClientRect().width) < 1);
  const settingComboOptionHeightsMatch = await settingCombos.nth(0).evaluate((trigger) => trigger.getBoundingClientRect().height === 29 && document.querySelector(".settings-modal .combobox-options button").getBoundingClientRect().height === trigger.getBoundingClientRect().height);
  await settings.locator(".settings-row").nth(1).locator(":scope > span").click();
  const otherSettingClosesCombobox = await settings.locator(".combobox-popover:visible").count() === 0 && await settingCombos.nth(0).getAttribute("aria-expanded") === "false";
  await settingCombos.nth(0).click();
  await page.locator(".combobox-popover:visible").getByRole("button", { name: "繁體中文", exact: true }).click();
  const canonicalResources = await page.locator(".resource-nav").getByText("Pods", { exact: true }).isVisible() && await page.locator(".resource-nav").getByText("Deployments", { exact: true }).isVisible();
  await settingCombos.nth(1).click();
  await page.locator(".combobox-popover:visible").getByRole("button", { name: "淺色", exact: true }).click();
  const lightSurfaces = await page.evaluate(() => Object.fromEntries(["body", ".cluster-rail", ".resource-nav", ".main-area", ".panel", ".settings-modal", ".settings-card"].map((selector) => [selector, getComputedStyle(document.querySelector(selector)).backgroundColor])));
  const lightApplied = Object.values(lightSurfaces).every(isLight);
  const lightLiveIndicator = await page.locator(".live-label i").first().evaluate((element) => getComputedStyle(element).backgroundColor === "rgb(32, 165, 111)" && getComputedStyle(element).boxShadow.includes("rgba(32, 165, 111, 0.16)"));
  await proxyToggle.click();
  const preciseSwitchWorks = await proxyToggle.getAttribute("aria-pressed") === "true";
  await settings.getByRole("button", { name: /檢查更新/ }).click();
  await page.waitForTimeout(900);
  const updateStatusInTitle = await settings.locator(".settings-section:last-child .settings-section-title").getByText("KubeHive 已是最新版本", { exact: true }).isVisible();
  await page.screenshot({ path: "artifacts/kubehive-precise-settings.png", fullPage: true });
  await settings.getByRole("button", { name: "Close settings" }).click();

  // Add Cluster uses the same compact title height as Settings, semantic tabs, and full-height fields.
  await page.getByTitle("Add cluster").click();
  const addClusterDialog = page.locator(".add-cluster-dialog");
  const addClusterHeader = await addClusterDialog.evaluate((dialog, settingsTitleHeight) => {
    const header = dialog.querySelector(":scope > header");
    const tabRow = dialog.querySelector('.add-cluster-tabs-row');
    const tabList = dialog.querySelector('[role="tablist"]');
    const tabs = [...dialog.querySelectorAll('[role="tab"]')];
    const activeTab = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    const widths = tabs.map((tab) => tab.getBoundingClientRect().width);
    const tabRowBox = tabRow.getBoundingClientRect();
    const tabListBox = tabList.getBoundingClientRect();
    const activeStyle = getComputedStyle(activeTab);
    const tabListStyle = getComputedStyle(tabList);
    const displayNameInput = dialog.querySelector('.field-label input:not([type="file"])');
    return {
      matchesSettings: header.getBoundingClientRect().height === settingsTitleHeight,
      oneTitle: header.querySelectorAll("h2").length === 1 && !header.querySelector("small") && !header.querySelector("span"),
      noIcon: !header.querySelector(".add-cluster-icon"),
      semanticTabs: tabList?.getAttribute("aria-label") === "Cluster connection method" && tabList?.getAttribute("aria-orientation") === "horizontal" && tabs.length === 3 && tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").length === 1,
      centeredTabs: Math.abs(tabListBox.left + tabListBox.width / 2 - (tabRowBox.left + tabRowBox.width / 2)) < 1,
      adaptiveWidthTabs: tabListBox.width < tabRowBox.width - 20 && Math.max(...widths) - Math.min(...widths) > 8,
      shadcnTabStyle: activeTab?.getAttribute("data-state") === "active" && parseFloat(tabListStyle.borderRadius) >= 6 && activeStyle.backgroundColor !== tabListStyle.backgroundColor && activeStyle.boxShadow !== "none",
      displayNameHeight: Math.round(displayNameInput.getBoundingClientRect().height) === 33,
    };
  }, settingsTitleHeight);
  await addClusterDialog.getByRole("tab", { name: "Manual", exact: true }).click();
  await page.waitForTimeout(200);
  const manualTabState = await addClusterDialog.evaluate((dialog) => {
    const manualTab = dialog.querySelector('#add-cluster-tab-manual');
    const panel = dialog.querySelector('#add-cluster-mode-panel');
    const apiField = [...dialog.querySelectorAll('.field-label')].find((label) => label.textContent.includes("API server URL"));
    const apiInput = apiField?.querySelector("input");
    return {
      selected: manualTab?.getAttribute("aria-selected") === "true" && manualTab?.getAttribute("tabindex") === "0",
      labelledPanel: panel?.getAttribute("role") === "tabpanel" && panel?.getAttribute("aria-labelledby") === "add-cluster-tab-manual",
      apiInputHeight: Math.round(apiInput?.getBoundingClientRect().height ?? 0) === 33,
    };
  });
  await page.screenshot({ path: "artifacts/kubehive-add-cluster-dialog.png", fullPage: true });
  await page.getByRole("button", { name: "Close add cluster" }).click();

  // Resource toolbar controls align and omit non-functional actions.
  await page.getByRole("button", { name: "Pods", exact: true }).click();
  const lightResourceKind = await page.locator(".resource-kind").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return style.backgroundColor === "rgb(232, 243, 247)" && style.borderColor === "rgb(172, 208, 223)" && style.color === "rgb(23, 111, 153)";
  });
  const resourceToolbar = await page.locator(".table-toolbar").evaluate((toolbar) => {
    const namespace = toolbar.querySelector(".table-namespace-combobox .combobox-trigger");
    const search = toolbar.querySelector(".table-search");
    return {
      matchingControlHeights: namespace.getBoundingClientRect().height === search.getBoundingClientRect().height,
      namespaceHeight: namespace.getBoundingClientRect().height === 29,
      noUnusedFilters: ![...toolbar.querySelectorAll("button")].some((button) => button.textContent.trim() === "Filters"),
    };
  });
  const pageSizeControl = page.locator(".table-pagination-size");
  const pageSizeTrigger = pageSizeControl.locator(".table-page-size-combobox .combobox-trigger");
  const noNativePageSizeSelect = await pageSizeControl.locator("select").count() === 0;
  await pageSizeTrigger.click();
  const pageSizePopover = pageSizeControl.locator(".combobox-popover");
  const pageSizeComboboxPlacement = await pageSizePopover.evaluate((popover) => {
    const popoverBox = popover.getBoundingClientRect();
    const triggerBox = document.querySelector(".table-page-size-combobox .combobox-trigger").getBoundingClientRect();
    const optionBox = popover.querySelector(".combobox-options button").getBoundingClientRect();
    return { visible: popoverBox.width > 0 && popoverBox.height > 0, opensUpward: popoverBox.bottom <= triggerBox.top, noSearch: !popover.querySelector(".combobox-search"), sameWidth: Math.abs(popoverBox.width - triggerBox.width) < 1, compactOptions: optionBox.height === triggerBox.height && optionBox.height === 26 };
  });
  await pageSizePopover.getByRole("button", { name: "15", exact: true }).click();
  const pageSizeComboboxWorks = (await pageSizeTrigger.textContent()).trim() === "15" && await page.locator(".resource-table tbody tr").count() === 15 && await page.evaluate(() => localStorage.getItem("kubehive.pageSize.Pods")) === "15";

  // Square, flush, resizable right Sheet with a compact two-line title.
  const paymentResource = page.getByText(/^payment-worker-/).first();
  const paymentResourceName = await paymentResource.textContent();
  await paymentResource.click();
  const detailSheet = page.locator(".sheet-right");
  await page.waitForTimeout(250);
  const sheetBefore = await detailSheet.boundingBox();
  const sheetChrome = await detailSheet.evaluate((element) => { const box = element.getBoundingClientRect(); const title = element.querySelector(".sheet-title-stack"); return { flush: box.top === 0 && box.right === innerWidth && box.bottom === innerHeight, square: parseFloat(getComputedStyle(element).borderRadius) === 0, noResizeHandle: !element.querySelector(".sheet-resize-handle"), borderCursor: getComputedStyle(element.querySelector(".sheet-resize-edge.vertical")).cursor === "ew-resize", attachedBordersRemoved: getComputedStyle(element).borderTopWidth === "0px" && getComputedStyle(element).borderRightWidth === "0px" && getComputedStyle(element).borderBottomWidth === "0px", actionsInHeader: !element.querySelector(".drawer-actions") && !element.querySelector(".drawer-footer") && element.querySelectorAll(".detail-header-actions button").length === 6 && [...element.querySelectorAll(".detail-header-actions button")].every((button) => button.textContent.trim() === ""), twoLineTitle: getComputedStyle(title).flexDirection === "column" && Boolean(title.querySelector("small")) && Boolean(title.querySelector("h2")), namespaceMovedToDetails: !element.querySelector(".detail-sheet-header").textContent.includes("commerce") && [...element.querySelectorAll("dt")].some((node) => node.textContent === "Namespace") }; });
  await page.mouse.move(sheetBefore.x + 1, sheetBefore.y + sheetBefore.height / 2); await page.mouse.down(); await page.mouse.move(sheetBefore.x - 90, sheetBefore.y + sheetBefore.height / 2, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(120);
  const sheetAfter = await detailSheet.boundingBox();
  const sheetResizable = sheetAfter.width >= sheetBefore.width + 75;

  // Open multiple persistent bottom sessions and switch/collapse them.
  await detailSheet.getByRole("button", { name: "Logs", exact: true }).click();
  const firstSession = await page.locator(".bottom-session-tabs > button").count() === 1;
  const permanentAddButton = await page.getByRole("button", { name: "Add session" }).isVisible();
  const plusFollowsTabs = await page.evaluate(() => { const tabs = document.querySelector(".bottom-session-tabs").getBoundingClientRect(); const plus = document.querySelector(".session-add").getBoundingClientRect(); return plus.left >= tabs.right && plus.left - tabs.right <= 8; });
  await page.getByRole("button", { name: "Add session" }).click();
  const addSessionMenu = await page.locator(".session-add-menu").evaluate((menu) => ({ visible: menu.getBoundingClientRect().width > 0, terminalOption: menu.textContent.includes("新增終端工作階段"), resourceOption: menu.textContent.includes("建立資源") }));
  await page.getByRole("button", { name: "新增終端工作階段", exact: true }).click();
  const plusCreatedSession = await page.locator(".bottom-session-tabs > button").count() === 2 && await page.getByText("Terminal · 新工作階段", { exact: true }).isVisible();
  await page.getByRole("button", { name: "Close Terminal · 新工作階段", exact: true }).click();
  const plusSessionClosable = await page.locator(".bottom-session-tabs > button").count() === 1;
  await page.waitForTimeout(250);
  const bottomDock = page.locator(".session-dock");
  const bottomBefore = await bottomDock.boundingBox();
  const bottomAlignment = await bottomDock.evaluate((element) => { const box = element.getBoundingClientRect(); const nav = document.querySelector(".resource-nav").getBoundingClientRect(); return { startsAfterResourceMenu: Math.abs(box.left - nav.right) < 1, noResizeHandle: !element.querySelector(":scope > .sheet-handle"), borderCursor: getComputedStyle(element.querySelector(".sheet-resize-edge.horizontal")).cursor === "ns-resize", attachedBordersRemoved: getComputedStyle(element).borderRightWidth === "0px" && getComputedStyle(element).borderBottomWidth === "0px" && getComputedStyle(element).borderLeftWidth === "0px", compactHeader: element.querySelector("header").getBoundingClientRect().height === 38 }; });
  await page.mouse.move(bottomBefore.x + 300, bottomBefore.y + 1); await page.mouse.down(); await page.mouse.move(bottomBefore.x + 300, bottomBefore.y - 80, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(120);
  const bottomAfter = await bottomDock.boundingBox();
  const bottomResizable = bottomAfter.height >= bottomBefore.height + 65;
  const bottomHeightPersisted = Number(await page.evaluate(() => localStorage.getItem("kubehive.sessionHeight"))) >= bottomAfter.height - 1;
  await page.getByRole("button", { name: "Collapse sessions" }).click();
  await page.waitForTimeout(180);
  const collapsedAddButtonVisible = await page.getByRole("button", { name: "Add session" }).isVisible();
  const collapsedBeforeResize = await bottomDock.boundingBox();
  await page.mouse.move(collapsedBeforeResize.x + 300, collapsedBeforeResize.y + 1); await page.mouse.down(); await page.mouse.move(collapsedBeforeResize.x + 300, collapsedBeforeResize.y - 90, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(150);
  const collapsedAfterResize = await bottomDock.boundingBox();
  const collapsedBorderResize = !await bottomDock.evaluate((element) => element.classList.contains("collapsed")) && collapsedAfterResize.height >= collapsedBeforeResize.height + 75;
  await page.getByRole("button", { name: "StatefulSets", exact: true }).click();
  await page.getByText("catalog-indexer", { exact: true }).first().click();
  const statefulSetActions = await page.locator(".sheet-right").evaluate((element) => { const labels = [...element.querySelectorAll(".detail-header-actions button")].map((button) => button.getAttribute("aria-label")); return labels.length === 5 && labels.includes("Terminal") && labels.includes("Logs") && labels.includes("Edit") && labels.includes("Scale") && labels.includes("Delete") && !labels.includes("Restart"); });
  const sheetPriority = await page.evaluate(() => Number(getComputedStyle(document.querySelector(".sheet-right")).zIndex) > Number(getComputedStyle(document.querySelector(".session-dock")).zIndex));
  await page.locator(".sheet-right").getByRole("button", { name: "Terminal", exact: true }).click();
  const sessionTabs = page.locator(".bottom-session-tabs > button");
  const twoSessions = await sessionTabs.count() === 2 && await page.getByText(`Logs · ${paymentResourceName}`, { exact: true }).isVisible() && await page.getByText("Terminal · catalog-indexer", { exact: true }).isVisible();
  await page.getByText(`Logs · ${paymentResourceName}`, { exact: true }).click();
  const switchedSessions = await page.locator(".terminal-output").getByText("LIVE", { exact: true }).isVisible();
  const restoredTargetHeight = (await bottomDock.boundingBox()).height;
  await page.getByRole("button", { name: "Maximize sessions" }).click();
  await page.waitForTimeout(220);
  const maximizedSessions = await bottomDock.evaluate((element) => element.classList.contains("maximized") && element.getBoundingClientRect().top === 42 && element.getBoundingClientRect().bottom === innerHeight);
  await page.getByRole("button", { name: "Restore sessions" }).click();
  await page.waitForTimeout(220);
  const restoredSessions = Math.abs((await bottomDock.boundingBox()).height - restoredTargetHeight) < 2;
  await page.getByRole("button", { name: "Collapse sessions" }).click();
  await page.waitForTimeout(220);
  const collapsedPersists = await page.locator(".session-dock").evaluate((element) => element.classList.contains("collapsed") && element.getBoundingClientRect().height === 38) && await sessionTabs.count() === 2;
  await page.getByText(`Logs · ${paymentResourceName}`, { exact: true }).click();
  await page.waitForTimeout(220);
  const reexpanded = await page.locator(".session-dock").evaluate((element) => !element.classList.contains("collapsed") && element.getBoundingClientRect().height > 100);
  await page.getByRole("button", { name: "Close Terminal · catalog-indexer", exact: true }).click();
  const individualClose = await sessionTabs.count() === 1;
  await page.getByRole("button", { name: "Deployments", exact: true }).click();
  const survivesResourceNavigation = await sessionTabs.count() === 1;
  const bottomSheetChrome = await page.locator(".session-dock").evaluate((element) => ({ flush: Math.abs(element.getBoundingClientRect().left - document.querySelector(".resource-nav").getBoundingClientRect().right) < 1 && element.getBoundingClientRect().right === innerWidth && element.getBoundingClientRect().bottom === innerHeight, square: parseFloat(getComputedStyle(element).borderRadius) === 0 }));
  await page.screenshot({ path: "artifacts/kubehive-persistent-session-dock.png", fullPage: true });

  // Alerts remain a compact dialog.
  await page.getByTitle("Alerts").click();
  const alertsDialog = await page.locator(".alerts-modal").evaluate((element) => ({ compact: element.querySelector(".dialog-header").getBoundingClientRect().height === 48, notSheet: !element.classList.contains("sheet") }));
  await page.getByRole("button", { name: "Close alerts" }).click();

  // Footer remains visible in short windows.
  const shortPage = await browser.newPage({ viewport: { width: 1000, height: 420 } });
  await shortPage.goto("http://localhost:1420", { waitUntil: "networkidle" });
  const shortRail = await shortPage.evaluate(() => [document.querySelector('[title="Alerts"]'), document.querySelector('[title="Settings"]')].every((element) => { const box = element.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }));
  await shortPage.close();

  const result = { initial, referenceResourceMenu, scrollbarAtRest, scrollbarVisible, scrollbarHiddenAgain, settingsLayout, rowClickDidNotEdit, switchRowClickDidNotEdit, settingComboWidthsMatch, settingComboOptionHeightsMatch, otherSettingClosesCombobox, canonicalResources, lightSurfaces, lightApplied, lightLiveIndicator, preciseSwitchWorks, updateStatusInTitle, addClusterHeader, manualTabState, lightResourceKind, resourceToolbar, noNativePageSizeSelect, pageSizeComboboxPlacement, pageSizeComboboxWorks, sheetChrome, sheetWidths: { before: sheetBefore.width, after: sheetAfter.width }, sheetResizable, firstSession, permanentAddButton, plusFollowsTabs, addSessionMenu, plusCreatedSession, plusSessionClosable, bottomAlignment, bottomHeights: { before: bottomBefore.height, after: bottomAfter.height }, bottomResizable, bottomHeightPersisted, collapsedAddButtonVisible, collapsedHeights: { before: collapsedBeforeResize.height, after: collapsedAfterResize.height }, collapsedBorderResize, statefulSetActions, sheetPriority, twoSessions, switchedSessions, maximizedSessions, restoredSessions, collapsedPersists, reexpanded, individualClose, survivesResourceNavigation, bottomSheetChrome, alertsDialog, shortRail, errors };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (errors.length || !Object.values(initial).every(Boolean) || !referenceResourceMenu || scrollbarAtRest !== "0px" || !scrollbarVisible.active || scrollbarVisible.width !== "5px" || scrollbarVisible.track !== "rgba(0, 0, 0, 0)" || scrollbarVisible.border !== "0px" || scrollbarVisible.button !== "0px" || !scrollbarHiddenAgain || !Object.values(settingsLayout).every(Boolean) || !rowClickDidNotEdit || !switchRowClickDidNotEdit || !settingComboWidthsMatch || !settingComboOptionHeightsMatch || !otherSettingClosesCombobox || !canonicalResources || !lightApplied || !lightLiveIndicator || !preciseSwitchWorks || !updateStatusInTitle || !Object.values(addClusterHeader).every(Boolean) || !Object.values(manualTabState).every(Boolean) || !lightResourceKind || !Object.values(resourceToolbar).every(Boolean) || !noNativePageSizeSelect || !Object.values(pageSizeComboboxPlacement).every(Boolean) || !pageSizeComboboxWorks || !Object.values(sheetChrome).every(Boolean) || !sheetResizable || !firstSession || !permanentAddButton || !plusFollowsTabs || !Object.values(addSessionMenu).every(Boolean) || !plusCreatedSession || !plusSessionClosable || !Object.values(bottomAlignment).every(Boolean) || !bottomResizable || !bottomHeightPersisted || !collapsedAddButtonVisible || !collapsedBorderResize || !statefulSetActions || !sheetPriority || !twoSessions || !switchedSessions || !maximizedSessions || !restoredSessions || !collapsedPersists || !reexpanded || !individualClose || !survivesResourceNavigation || !Object.values(bottomSheetChrome).every(Boolean) || !Object.values(alertsDialog).every(Boolean) || !shortRail) process.exit(1);
})();
