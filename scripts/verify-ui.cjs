const { chromium } = require("playwright");
const rgb = (value) => (value.match(/\d+/g) || []).slice(0, 3).map(Number);
const isLight = (value) => { if (value === "rgba(0, 0, 0, 0)") return true; const channels = rgb(value); return channels.length === 3 && Math.min(...channels) >= 215; };

(async () => {
  const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://localhost:1420";
  const manifestOnly = process.env.KUBEHIVE_MANIFEST_ONLY === "1";
  const selectAllShortcut = process.platform === "darwin" ? "Meta+a" : "Control+a";
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  // The application opens on a disconnected cluster-list home page.
  const clusterHome = await page.evaluate(() => {
    const row = document.querySelector(".cluster-home-row");
    const header = document.querySelector(".cluster-home-list-head");
    const action = document.querySelector(".cluster-actions > button");
    const version = document.querySelector(".cluster-home-version");
    const actionStyle = getComputedStyle(action);
    const versionStyle = getComputedStyle(version);
    return {
      visible: Boolean(document.querySelector(".cluster-home")),
      fourClusters: document.querySelectorAll(".cluster-home-row").length === 4,
      allDisconnected: document.querySelectorAll(".cluster-icon.disconnected").length === 4,
      noActiveCluster: document.querySelectorAll(".cluster-icon.active").length === 0,
      noResourceWorkspace: !document.querySelector(".resource-nav") && !document.querySelector(".workspace-tabs"),
      singleColumn: getComputedStyle(document.querySelector(".workspace-pane")).gridTemplateColumns.split(" ").length === 1,
      homeTitlebarDragRegion: Boolean(document.querySelector(".home-titlebar .home-titlebar-drag[data-tauri-drag-region], .home-titlebar[data-tauri-drag-region]")) && document.querySelector(".home-titlebar").getBoundingClientRect().height > 0,
      homeWindowControls: !/Mac|iPhone|iPad/.test(navigator.userAgent) ? Boolean(document.querySelector(".home-titlebar .window-controls")) : true,
      searchAboveTable: Boolean(document.querySelector(".cluster-home-toolbar .table-search")) && document.querySelector(".cluster-home-toolbar").nextElementSibling === document.querySelector(".cluster-home-list"),
      compactHeader: header.getBoundingClientRect().height === 34,
      compactRows: row.getBoundingClientRect().height === 53,
      iconOnlyGhostActions: action.textContent.trim() === "" && action.querySelectorAll("svg").length === 1 && actionStyle.borderWidth === "0px" && actionStyle.backgroundColor === "rgba(0, 0, 0, 0)",
      monoUnframedVersion: versionStyle.borderWidth === "0px" && versionStyle.backgroundColor === "rgba(0, 0, 0, 0)" && versionStyle.fontFamily.includes("monospace") && version.getBoundingClientRect().width < 70,
    };
  });

  const clusterSearchInput = page.getByRole("textbox", { name: "Search clusters" });
  // The toolbar search starts collapsed to an icon; activate it before typing.
  await page.locator(".cluster-home-toolbar .table-search-toggle").click();
  await clusterSearchInput.fill("Azure");
  const clusterSearchWorks = await page.locator(".cluster-home-row").count() === 1 && await page.locator('[data-cluster-id="edge-ap"]').isVisible() && (await page.locator(".cluster-home-toolbar").textContent()).includes("4 configured");
  await clusterSearchInput.fill("no-such-cluster");
  const clusterSearchEmpty = await page.locator(".cluster-home-filter-empty").isVisible();
  await clusterSearchInput.fill("");

  // Cluster settings use a compact one-line title, square color input, and editable persisted display name.
  await page.getByRole("button", { name: "Actions production-eu" }).click();
  const removeClusterAction = page.locator(".cluster-actions-menu").getByRole("button", { name: "Remove" });
  const sensitiveActionAtRest = await removeClusterAction.evaluate((remove) => {
    const settings = [...remove.parentElement.querySelectorAll("button")].find((button) => button.textContent.trim() === "Settings");
    const removeStyle = getComputedStyle(remove);
    const settingsStyle = getComputedStyle(settings);
    return { color: removeStyle.color, background: removeStyle.backgroundColor, settingsColor: settingsStyle.color, settingsBackground: settingsStyle.backgroundColor };
  });
  await removeClusterAction.hover();
  const sensitiveActionOnHover = await removeClusterAction.evaluate((remove) => { const style = getComputedStyle(remove); return { color: style.color, background: style.backgroundColor }; });
  const sensitiveActionHover = sensitiveActionAtRest.color === sensitiveActionAtRest.settingsColor && sensitiveActionAtRest.background === sensitiveActionAtRest.settingsBackground && (sensitiveActionOnHover.color !== sensitiveActionAtRest.color || sensitiveActionOnHover.background !== sensitiveActionAtRest.background);
  await page.locator(".cluster-actions-menu").getByRole("button", { name: "Settings" }).click();
  const clusterSettingsDialog = page.locator(".cluster-color-dialog");
  const clusterSettings = await clusterSettingsDialog.evaluate((dialog) => {
    const header = dialog.querySelector(":scope > header");
    const color = dialog.querySelector('input[type="color"]');
    const colorBox = color.getBoundingClientRect();
    return {
      oneLineTitle: header.querySelectorAll("h2").length === 1 && !header.querySelector("p") && header.textContent.trim() === "Cluster settings",
      headerHeight: header.getBoundingClientRect().height,
      squareColor: colorBox.width === colorBox.height && colorBox.width === 32,
    };
  });
  await clusterSettingsDialog.getByRole("textbox", { name: "Cluster name" }).fill("production-eu-renamed");
  await clusterSettingsDialog.getByRole("button", { name: "Save" }).click();
  await clusterSettingsDialog.waitFor({ state: "hidden" });
  const clusterRenameWorks = await page.locator('[data-cluster-id="prod-eu"] .cluster-home-identity strong').getByText("production-eu-renamed", { exact: true }).isVisible();
  await page.getByRole("button", { name: "Actions production-eu-renamed" }).click();
  await page.locator(".cluster-actions-menu").getByRole("button", { name: "Settings" }).click();
  await page.locator(".cluster-color-dialog").getByRole("textbox", { name: "Cluster name" }).fill("production-eu");
  await page.locator(".cluster-color-dialog").getByRole("button", { name: "Save" }).click();
  await page.locator(".cluster-color-dialog").waitFor({ state: "hidden" });
  const clusterRenameRestored = await page.locator('[data-cluster-id="prod-eu"] .cluster-home-identity strong').getByText("production-eu", { exact: true }).isVisible();

  // Every documented connection entry reaches the selected cluster Overview; both close entries return home.
  await page.getByRole("button", { name: "Actions production-eu" }).click();
  const actionsConnectVisible = await page.getByRole("button", { name: "Connect", exact: true }).isVisible();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator(".resource-nav").waitFor();
  const actionsConnectOpenedOverview = (await page.locator(".page-head h1").textContent()).trim() === "production-eu";
  await page.getByRole("button", { name: "Clusters" }).click();
  const brandReturnsHome = await page.locator(".cluster-home").isVisible();

  await page.locator('[data-cluster-id="staging"]').dblclick();
  await page.locator(".resource-nav").waitFor();
  const doubleClickOpenedOverview = (await page.locator(".page-head h1").textContent()).trim() === "staging";
  const summaryCloseVisible = await page.locator(".cluster-summary-actions").getByRole("button", { name: "Close connection" }).isVisible();
  await page.locator(".cluster-summary-actions").getByRole("button", { name: "Close connection" }).click();
  const summaryCloseReturnsHome = await page.locator(".cluster-home").isVisible();

  await page.getByRole("button", { name: "Connect edge-ap-south" }).click();
  await page.locator(".resource-nav").waitFor();
  const railOpenedOverview = (await page.locator(".page-head h1").textContent()).trim() === "edge-ap-south";
  const edgeRailButton = page.getByRole("button", { name: "Open overview edge-ap-south" });
  const contextCloseButton = page.locator(".app-context-menu").getByRole("menuitem", { name: "Close connection" });
  for (let attempt = 0; attempt < 3 && !await contextCloseButton.isVisible(); attempt += 1) {
    await edgeRailButton.click({ button: "right" });
    await page.waitForTimeout(100);
  }
  const contextCloseVisible = await contextCloseButton.isVisible();
  if (contextCloseVisible) await contextCloseButton.click();
  const contextCloseReturnsHome = contextCloseVisible ? await page.locator(".cluster-home").isVisible() : false;
  if (!contextCloseVisible) await page.getByRole("button", { name: "Clusters" }).click();

  await page.locator('[data-cluster-id="prod-eu"]').dblclick();
  await page.locator(".workspace-tabs").waitFor();
  const connectionFlows = { actionsConnectVisible, actionsConnectOpenedOverview, brandReturnsHome, doubleClickOpenedOverview, summaryCloseVisible, summaryCloseReturnsHome, railOpenedOverview, contextCloseVisible, contextCloseReturnsHome };

  const initial = await page.evaluate(() => {
    const tabs = document.querySelector(".workspace-tabs").getBoundingClientRect();
    const overview = document.querySelector(".workspace-tab-list > button");
    const navSearch = document.querySelector(".resource-nav .nav-search");
    const navStyle = getComputedStyle(navSearch);
    const navCommand = navSearch?.querySelector(".nav-search-command");
    const shortcut = navCommand?.querySelector(".command-shortcut");
    return {
      tabsAtTop: tabs.top === 0,
      overviewPermanent: !overview.querySelector("i"),
      overviewCompact: overview.offsetHeight === 30 && overview.offsetWidth < 130,
      tabIconVisible: Boolean(overview.querySelector(".tab-icon")),
      tabsCommandRemoved: !document.querySelector(".tabs-command"),
      navSearchHasCommandShortcut: Boolean(shortcut) && shortcut.querySelectorAll("kbd").length >= 2,
      navSearchRestored: navStyle.marginLeft === "0px" && navStyle.boxShadow === "none" && navStyle.borderRightWidth === "1px" && navStyle.borderBottomWidth === "1px",
      noOverviewGroupHeading: ![...document.querySelectorAll(".resource-nav nav section > p")].some((node) => node.textContent.trim() === "Overview"),
    };
  });

  // Resource navigation visibility supports whole groups, individual resources, persistence, and reset.
  const resourceFilterTrigger = page.getByRole("button", { name: "Configure resource list" });
  await resourceFilterTrigger.click();
  await page.getByRole("checkbox", { name: "Show group Workloads" }).uncheck();
  const groupFilterWorks = await page.locator('.resource-nav nav button[aria-label="Pods"]').count() === 0 && await page.locator('.resource-nav nav button[aria-label="Deployments"]').count() === 0;
  await page.getByRole("checkbox", { name: "Show resource Pods" }).check();
  const specificResourceFilterWorks = await page.locator('.resource-nav nav button[aria-label="Pods"]').count() === 1 && await page.locator('.resource-nav nav button[aria-label="Deployments"]').count() === 0;
  const resourceFilterPersisted = await page.evaluate(() => { const hidden = JSON.parse(localStorage.getItem("kubehive.resourceTreeHidden") ?? "[]"); return hidden.includes("Deployments") && !hidden.includes("Pods"); });
  await page.getByRole("button", { name: "Show all" }).click();
  const resourceFilterReset = await page.locator('.resource-nav nav button[aria-label="Pods"]').count() === 1 && await page.locator('.resource-nav nav button[aria-label="Deployments"]').count() === 1 && await page.evaluate(() => localStorage.getItem("kubehive.resourceTreeHidden") === "[]");
  await resourceFilterTrigger.click();

  const referenceResources = ["Nodes", "Namespaces", "Events", "ReplicaSets", "Replication Controllers", "Jobs", "CronJobs", "Limit Ranges", "Horizontal Pod Autoscalers", "Vertical Pod Autoscalers", "Pod Disruption Budgets", "Priority Classes", "Runtime Classes", "Leases", "Mutating Webhook Configs", "Validating Webhook Configs", "Endpoints", "Ingress Classes", "Port Forwarding", "Persistent Volume Claims", "Helm Charts", "Cluster Roles", "Cluster Role Bindings", "Pod Security Policies"];
  const referenceResourceMenu = await page.locator(".resource-nav nav button").evaluateAll((buttons, expected) => {
    const labels = new Set(buttons.map((button) => button.getAttribute("aria-label")));
    return expected.every((item) => labels.has(item)) && !labels.has("Jobs & CronJobs");
  }, referenceResources);

  // Persistent thin scrollbar chrome when content can overflow.
  const scrollTarget = page.locator(".resource-nav > nav");
  const scrollbarChrome = await scrollTarget.evaluate((element) => ({
    width: getComputedStyle(element, "::-webkit-scrollbar").width,
    track: getComputedStyle(element, "::-webkit-scrollbar-track").backgroundColor,
    border: getComputedStyle(element, "::-webkit-scrollbar-track").borderLeftWidth,
    button: getComputedStyle(element, "::-webkit-scrollbar-button").width,
    thin: getComputedStyle(element).scrollbarWidth === "thin",
  }));

  // Settings dialog only reacts to precise controls and does not scroll when content fits.
  await page.getByTitle("Settings").click();
  const settings = page.locator(".settings-modal");
  const settingsTitleHeight = await settings.locator(".settings-header").evaluate((header) => header.getBoundingClientRect().height);
  const settingsLayout = await settings.evaluate((element) => { const scroll = element.querySelector(".settings-scroll"); return { centered: Math.abs(element.getBoundingClientRect().left + element.getBoundingClientRect().width / 2 - innerWidth / 2) < 2, contentFits: scroll.scrollHeight <= scroll.clientHeight, scrollbarThin: getComputedStyle(scroll).scrollbarWidth === "thin" && getComputedStyle(scroll, "::-webkit-scrollbar").width === "5px", updateButtonInTitle: Boolean(element.querySelector(".settings-section:last-child .settings-section-title > button")), noUpdateRow: !element.querySelector(".update-row") }; });
  const firstRow = settings.locator(".settings-row").first();
  await firstRow.locator("span").click();
  const rowClickDidNotEdit = await settings.locator(".combobox-popover:visible").count() === 0;
  const proxyRow = settings.locator(".settings-section").nth(2).locator(".settings-row");
  const proxyToggle = proxyRow.locator(".settings-toggle");
  const proxyBefore = await proxyToggle.getAttribute("aria-pressed");
  await proxyRow.locator("span").click();
  const switchRowClickDidNotEdit = await proxyToggle.getAttribute("aria-pressed") === proxyBefore;

  const settingCombos = settings.locator(".combobox-trigger");
  await settingCombos.nth(0).click();
  const settingComboWidthsMatch = await settingCombos.nth(0).evaluate((trigger) => Math.abs(trigger.getBoundingClientRect().width - document.querySelector(".settings-modal .combobox-popover").getBoundingClientRect().width) < 1);
  const settingComboOptionHeightsMatch = await settingCombos.nth(0).evaluate((trigger) => trigger.getBoundingClientRect().height === 29 && document.querySelector(".settings-modal .combobox-options button").getBoundingClientRect().height === trigger.getBoundingClientRect().height);
  await settings.locator(".settings-row").nth(1).locator(":scope > span").click();
  const otherSettingClosesCombobox = await settings.locator(".combobox-popover:visible").count() === 0 && await settingCombos.nth(0).getAttribute("aria-expanded") === "false";
  const terminalEditorsSection = settings.locator(".settings-section").filter({ hasText: "Terminal & logs & editors" });
  const terminalEditorsSetting = await terminalEditorsSection.count() === 1 && await terminalEditorsSection.locator(".settings-row").count() === 3;
  const terminalSettingRows = terminalEditorsSection.locator(".settings-row");
  const terminalThemeTrigger = terminalSettingRows.nth(0).locator(".combobox-trigger");
  await terminalThemeTrigger.click();
  await page.locator(".combobox-popover:visible").getByRole("button", { name: "Light", exact: true }).click();
  const terminalThemeSettingWorks = (await terminalThemeTrigger.textContent()).includes("Light");
  const terminalFontTrigger = terminalSettingRows.nth(1).locator(".combobox-trigger");
  await terminalFontTrigger.click();
  await page.locator(".combobox-popover:visible").getByRole("button", { name: "Fira Code", exact: true }).click();
  const terminalFontSettingWorks = (await terminalFontTrigger.textContent()).includes("Fira Code");
  const terminalFontSizeRow = terminalEditorsSection.locator(".settings-row").nth(2);
  const terminalFontSizeTrigger = terminalFontSizeRow.locator(".combobox-trigger");
  await terminalFontSizeTrigger.click();
  await page.locator(".combobox-popover:visible").getByRole("button", { name: "16 px", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("kubehive.preferences") ?? "{}").contentFontSize === 16);
  const terminalFontSizeSettingWorks = (await terminalFontSizeTrigger.textContent()).includes("16 px");
  await settingCombos.nth(0).click();
  await page.locator(".combobox-popover:visible").getByRole("button", { name: "繁體中文", exact: true }).click();
  const canonicalResources = await page.locator(".resource-nav").getByText("Pods", { exact: true }).isVisible() && await page.locator(".resource-nav").getByText("Deployments", { exact: true }).isVisible();
  await settingCombos.nth(1).click();
  await page.locator(".combobox-popover:visible").getByRole("button", { name: "淺色", exact: true }).click();
  const lightSurfaces = await page.evaluate(() => Object.fromEntries(["body", ".cluster-rail", ".resource-nav", ".main-area", ".panel", ".settings-modal", ".settings-card"].map((selector) => [selector, getComputedStyle(document.querySelector(selector)).backgroundColor])));
  const lightApplied = Object.values(lightSurfaces).every(isLight);
  const lightLiveIndicator = await page.locator(".live-label i").first().evaluate((element) => getComputedStyle(element).backgroundColor === "rgb(32, 165, 111)" && getComputedStyle(element).boxShadow.includes("rgba(32, 165, 111, 0.16)"));
  const lightSettingsToggle = await proxyToggle.evaluate((element) => {
    const knob = element.querySelector("i");
    return getComputedStyle(element).backgroundColor === "rgb(203, 212, 218)" && knob && getComputedStyle(knob).backgroundColor === "rgb(255, 255, 255)";
  });
  await proxyToggle.click();
  const preciseSwitchWorks = await proxyToggle.getAttribute("aria-pressed") === "true";
  await page.waitForTimeout(200);
  const activeLightSettingsToggle = await proxyToggle.evaluate((element) => {
    const knob = element.querySelector("i");
    return getComputedStyle(element).backgroundColor === "rgb(33, 141, 96)" && knob && getComputedStyle(knob).backgroundColor === "rgb(245, 255, 250)";
  });
  await settings.getByRole("button", { name: /檢查更新/ }).click();
  const about = page.locator(".about-modal");
  await about.waitFor();
  const updateStatusInTitle = await about.getByText("Updates require the desktop app", { exact: true }).isVisible()
    && await settings.count() === 0;
  const aboutRailButtonOrder = await page.locator(".rail-footer > .rail-button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")).join("|") === "警示|關於 KubeHive|設定");
  await page.screenshot({ path: "artifacts/kubehive-about-panel.png", fullPage: true });
  await about.getByRole("button", { name: "關閉" }).click();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.locator(".settings-modal .combobox-trigger").first().click();
  await page.locator(".combobox-popover:visible").getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  // Add Cluster uses the same compact title height as Settings, semantic tabs, and full-height fields.
  await page.getByTitle("Add cluster").click();
  const addClusterDialog = page.locator(".add-cluster-dialog");
  const addClusterHeader = await addClusterDialog.evaluate((dialog, expectedHeights) => {
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
      matchesSettings: header.getBoundingClientRect().height === expectedHeights.settings,
      matchesClusterSettings: header.getBoundingClientRect().height === expectedHeights.clusterSettings,
      oneTitle: header.querySelectorAll("h2").length === 1 && !header.querySelector("small") && !header.querySelector("span"),
      noIcon: !header.querySelector(".add-cluster-icon"),
      semanticTabs: tabList?.getAttribute("aria-label") === "Cluster connection method" && tabList?.getAttribute("aria-orientation") === "horizontal" && tabs.length === 3 && tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").length === 1,
      centeredTabs: Math.abs(tabListBox.left + tabListBox.width / 2 - (tabRowBox.left + tabRowBox.width / 2)) < 1,
      adaptiveWidthTabs: tabListBox.width < tabRowBox.width - 20 && Math.max(...widths) - Math.min(...widths) > 8,
      shadcnTabStyle: activeTab?.getAttribute("data-state") === "active" && parseFloat(tabListStyle.borderRadius) >= 6 && activeStyle.backgroundColor !== tabListStyle.backgroundColor && activeStyle.boxShadow !== "none",
      displayNameHeight: Math.round(displayNameInput.getBoundingClientRect().height) === 33,
    };
  }, { settings: settingsTitleHeight, clusterSettings: clusterSettings.headerHeight });
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
  const resourceTableBehavior = await page.locator(".resource-table-wrap.virtualized").evaluate((table) => {
    const total = Number(table.getAttribute("data-row-count"));
    const mounted = table.querySelectorAll("tbody tr[data-index]").length;
    const headerHeight = table.querySelector("thead").getBoundingClientRect().height;
    const expectedHeight = headerHeight + mounted * 53;
    const toolbar = document.querySelector(".table-toolbar");
    return {
      noPagination: !document.querySelector(".table-pagination"),
      reportsAllRows: total > 10,
      rendersAllRows: mounted === total,
      heightFitsResources: Math.abs(table.getBoundingClientRect().height - expectedHeight) <= 1,
      stickyHeader: getComputedStyle(table.querySelector("thead")).position === "sticky",
      stickyToolbar: getComputedStyle(toolbar).position === "sticky",
      pinnedHeaderBelowToolbar: getComputedStyle(table.querySelector("thead")).top === "47px",
      allColumnsSortable: [...table.querySelectorAll("thead th:not(.actions-col):not(.selection-col)")].every((header) => Boolean(header.querySelector(".table-sort-button"))),
    };
  });
  const resourceSearch = page.locator(".table-toolbar .table-search input").first();
  // The toolbar search starts collapsed to an icon; activate it before typing.
  await page.locator(".table-toolbar .table-search-toggle").click();
  await resourceSearch.fill("no-matching-resources");
  await page.locator(".resource-table tr.empty-row").waitFor();
  const emptyResourceRowBehavior = await page.locator(".resource-table-wrap.virtualized").evaluate((table) => {
    const header = table.querySelector("thead");
    const emptyRow = table.querySelector("tr.empty-row");
    const expectedHeight = Math.min(360, Math.max(250, innerHeight - 500));
    return {
      onlyEmptyRow: table.querySelectorAll("tbody tr").length === 1,
      fillsEmptyState: Math.abs(emptyRow.getBoundingClientRect().height - expectedHeight) <= 1,
      wrapperFitsEmptyRow: Math.abs(table.getBoundingClientRect().height - header.getBoundingClientRect().height - emptyRow.getBoundingClientRect().height) <= 1,
    };
  });
  await page.locator(".resource-table tr.empty-row").hover();
  emptyResourceRowBehavior.noHoverFill = await page.locator(".resource-table tr.empty-row").evaluate((row) => getComputedStyle(row).backgroundColor === "rgba(0, 0, 0, 0)");
  await resourceSearch.fill("");
  await page.locator(".resource-table tbody tr[data-index]").first().waitFor();
  const nameSort = page.getByRole("button", { name: "Name", exact: true }).first();
  const firstVisibleResource = () => page.locator(".resource-table tbody tr[data-index]").first().locator(".resource-name strong").textContent();
  await nameSort.click();
  const ascendingName = await firstVisibleResource();
  const ascendingState = await nameSort.locator("xpath=..").getAttribute("aria-sort") === "ascending";
  await nameSort.click();
  const descendingName = await firstVisibleResource();
  const descendingState = await nameSort.locator("xpath=..").getAttribute("aria-sort") === "descending";
  await nameSort.click();
  const defaultName = await firstVisibleResource();
  const defaultSortState = await nameSort.locator("xpath=..").getAttribute("aria-sort") === "none";
  const restartSort = page.getByRole("button", { name: "Restarts", exact: true });
  const restartColumnIndex = await restartSort.locator("xpath=..").evaluate((header) => header.cellIndex);
  const firstRestartValue = async () => Number((await page.locator(".resource-table tbody tr[data-index]").first().locator("td").nth(restartColumnIndex).textContent())?.trim() ?? 0);
  await restartSort.click();
  const ascendingRestarts = await firstRestartValue();
  await restartSort.click();
  const descendingRestarts = await firstRestartValue();
  await restartSort.click();
  const columnSortingWorks = ascendingState && descendingState && defaultSortState && ascendingName !== descendingName && defaultName !== "" && ascendingRestarts <= descendingRestarts;
  await nameSort.click();
  const persistedFirstName = await firstVisibleResource();
  await page.locator('.resource-nav nav button[aria-label="Deployments"]').click();
  await page.locator('.page-head h1').getByText("Deployments", { exact: true }).waitFor();
  await page.locator('.resource-nav nav button[aria-label="Pods"]').click();
  await page.locator('.page-head h1').getByText("Pods", { exact: true }).waitFor();
  const restoredNameSort = page.getByRole("button", { name: "Name", exact: true }).first();
  await page.waitForFunction(() => document.querySelector('.resource-table th[aria-sort="ascending"] .table-sort-button')?.textContent?.includes("Name"));
  const restoredFirstName = await firstVisibleResource();
  const savedSort = await page.evaluate(() => localStorage.getItem("kubehive.tableSort.resource:Pods"));
  const sortPersistenceWorks = await restoredNameSort.locator("xpath=..").getAttribute("aria-sort") === "ascending" && restoredFirstName === persistedFirstName && savedSort?.includes('"columnId":"name"') && savedSort?.includes('"direction":"asc"');

  // Square, tab-attached, resizable right Sheet with a compact two-line title.
  const paymentResource = page.getByText(/^payment-worker-/).first();
  const paymentResourceName = await paymentResource.textContent();
  await paymentResource.click();
  const detailSheet = page.locator(".sheet-right");
  await page.waitForTimeout(250);
  const sheetBefore = await detailSheet.boundingBox();
  const sheetChrome = await detailSheet.evaluate((element) => { const box = element.getBoundingClientRect(); const tabs = document.querySelector(".workspace-tabs").getBoundingClientRect(); const title = element.querySelector(".sheet-title-stack"); return { attachedBelowTabs: Math.abs(box.top - tabs.bottom) < 1 && box.right === innerWidth && box.bottom === innerHeight, square: parseFloat(getComputedStyle(element).borderRadius) === 0, noResizeHandle: !element.querySelector(".sheet-resize-handle"), borderCursor: getComputedStyle(element.querySelector(".sheet-resize-edge.vertical")).cursor === "ew-resize", attachedBordersRemoved: getComputedStyle(element).borderTopWidth === "0px" && getComputedStyle(element).borderRightWidth === "0px" && getComputedStyle(element).borderBottomWidth === "0px", actionsInHeader: !element.querySelector(".drawer-actions") && !element.querySelector(".drawer-footer") && element.querySelectorAll(".detail-header-actions button").length === 6 && [...element.querySelectorAll(".detail-header-actions button")].every((button) => button.textContent.trim() === "") && Boolean(element.querySelector('.detail-header-actions button[aria-label="Files"]')) && Boolean(element.querySelector('.detail-header-actions button[aria-label="Evict"]')) && !element.querySelector('.detail-header-actions button[aria-label="Scale"]') && !element.querySelector('.detail-header-actions button[aria-label="Restart"]'), twoLineTitle: getComputedStyle(title).flexDirection === "column" && Boolean(title.querySelector("small")) && Boolean(title.querySelector("h2")), namespaceMovedToDetails: !element.querySelector(".detail-sheet-header").textContent.includes("commerce") && [...element.querySelectorAll("dt")].some((node) => node.textContent === "Namespace") }; });
  await page.mouse.move(sheetBefore.x + 1, sheetBefore.y + sheetBefore.height / 2); await page.mouse.down(); await page.mouse.move(sheetBefore.x - 90, sheetBefore.y + sheetBefore.height / 2, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(120);
  const sheetAfter = await detailSheet.boundingBox();
  const sheetResizable = sheetAfter.width >= sheetBefore.width + 75;

  // Open multiple persistent bottom sessions and switch/collapse them.
  await detailSheet.getByRole("button", { name: "Logs", exact: true }).click();
  const firstSession = await page.locator(".bottom-session-tabs > button").count() === 1;
  const permanentAddButton = await page.getByRole("button", { name: "Add session" }).isVisible();
  const plusFollowsTabs = await page.evaluate(() => { const tabs = document.querySelector(".bottom-session-tabs").getBoundingClientRect(); const plus = document.querySelector(".session-add").getBoundingClientRect(); return plus.left >= tabs.right && plus.left - tabs.right <= 8; });
  await page.getByRole("button", { name: "Add session" }).click();
  const addSessionMenu = await page.locator(".session-add-menu").evaluate((menu) => ({ visible: menu.getBoundingClientRect().width > 0, terminalOption: menu.textContent.includes("New local terminal"), resourceOption: menu.textContent.includes("Create resource") }));
  await page.getByRole("button", { name: "New local terminal", exact: true }).click();
  const plusCreatedSession = await page.locator(".bottom-session-tabs > button").count() === 2 && await page.getByText("Local terminal · New local terminal", { exact: true }).isVisible();
  await page.getByRole("button", { name: "Close Local terminal · New local terminal", exact: true }).click();
  const plusSessionClosable = await page.locator(".bottom-session-tabs > button").count() === 1;
  const tabRailInteractions = await page.evaluate(() => {
    const verifyRail = (selector, minWidth) => {
      const rail = document.querySelector(selector);
      const injectedTabs = Array.from({ length: 14 }, (_, index) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.textContent = `Overflow test tab ${index} with a deliberately long title`;
        rail.append(tab);
        return tab;
      });
      rail.scrollLeft = 0;
      const tabStyle = getComputedStyle(injectedTabs[0]);
      const railStyle = getComputedStyle(rail);
      const directWheel = new WheelEvent("wheel", { deltaY: 90, bubbles: true, cancelable: true });
      rail.dispatchEvent(directWheel);
      const directWheelWorks = rail.scrollLeft > 0;
      rail.scrollLeft = 0;
      const shiftWheel = new WheelEvent("wheel", { deltaY: 90, shiftKey: true, bubbles: true, cancelable: true });
      rail.dispatchEvent(shiftWheel);
      const shiftWheelWorks = rail.scrollLeft > 0;
      const result = {
        overflowsAtMinimumWidth: rail.scrollWidth > rail.clientWidth,
        hiddenScrollbar: railStyle.scrollbarWidth === "none" && getComputedStyle(rail, "::-webkit-scrollbar").display === "none",
        minimumWidth: parseFloat(tabStyle.minWidth) >= minWidth,
        shrinksBeforeOverflowing: tabStyle.flexShrink === "1",
        directWheelWorks,
        shiftWheelWorks,
      };
      injectedTabs.forEach((tab) => tab.remove());
      return result;
    };
    return {
      workspace: verifyRail(".workspace-tab-list", 112),
      sessions: verifyRail(".bottom-session-tabs", 150),
    };
  });
  await page.waitForTimeout(250);
  const bottomDock = page.locator(".session-dock");
  const bottomBefore = await bottomDock.boundingBox();
  const workspaceBeforeBottomResize = await page.locator(".workspace-scroll").boundingBox();
  const bottomAlignment = await bottomDock.evaluate((element) => { const box = element.getBoundingClientRect(); const nav = document.querySelector(".resource-nav").getBoundingClientRect(); const tabbar = element.querySelector(".session-tabbar"); const actionBar = element.querySelector(".session-action-bar"); const labels = [...actionBar.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") || button.textContent.trim()); return { startsAfterResourceMenu: Math.abs(box.left - nav.right) < 1, participatesInLayout: getComputedStyle(element).position === "relative", noLegacyHeader: !element.querySelector(":scope > header"), noResizeHandle: !element.querySelector(":scope > .sheet-handle"), borderCursor: getComputedStyle(element.querySelector(".sheet-resize-edge.horizontal")).cursor === "ns-resize", attachedBordersRemoved: getComputedStyle(element).borderRightWidth === "0px" && getComputedStyle(element).borderBottomWidth === "0px" && getComputedStyle(element).borderLeftWidth === "0px", compactTabbar: tabbar.getBoundingClientRect().height === 38, hasOuterShadow: getComputedStyle(element).boxShadow !== "none", mainFrameAboveSheet: Number(getComputedStyle(document.querySelector(".main-area"), "::after").zIndex) > Number(getComputedStyle(element).zIndex), modeActionBar: actionBar.getBoundingClientRect().height <= 40 && !actionBar.querySelector(".session-action-context") && Boolean(actionBar.querySelector(".session-primary-actions")) && Boolean(actionBar.querySelector(".session-secondary-actions")) && labels.includes("Tail lines") && labels.includes("Download logs") && labels.includes("Find text") && actionBar.querySelectorAll('input[type="checkbox"]').length === 4, lightBorder: getComputedStyle(actionBar).borderBottomColor === "rgb(215, 221, 226)" }; });
  await page.mouse.move(bottomBefore.x + 300, bottomBefore.y + 1); await page.mouse.down(); await page.mouse.move(bottomBefore.x + 300, bottomBefore.y - 80, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(120);
  const bottomAfter = await bottomDock.boundingBox();
  const workspaceAfterBottomResize = await page.locator(".workspace-scroll").boundingBox();
  const bottomResizable = bottomAfter.height >= bottomBefore.height + 65;
  const bottomPushesWorkspace = workspaceBeforeBottomResize.height - workspaceAfterBottomResize.height >= 65 && Math.abs(workspaceAfterBottomResize.y + workspaceAfterBottomResize.height - bottomAfter.y) < 1;
  const resourceViewport = page.locator(".resource-table-wrap.virtualized");
  const resourceTotal = Number(await resourceViewport.getAttribute("data-row-count"));
  await resourceViewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction((lastIndex) => Boolean(document.querySelector(`.resource-table tbody tr[data-index="${lastIndex}"]`)), resourceTotal - 1);
  const lastResourceRow = page.locator(`.resource-table tbody tr[data-index="${resourceTotal - 1}"]`);
  const bottomListEndReachable = await lastResourceRow.evaluate((element) => {
    const row = element.getBoundingClientRect();
    const table = element.closest(".resource-table-wrap").getBoundingClientRect();
    const workspace = document.querySelector(".workspace-scroll").getBoundingClientRect();
    return row.top >= table.top - 1 && row.bottom <= table.bottom + 1 && table.top < workspace.bottom && table.bottom > workspace.top;
  });
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
  const statefulSetActions = await page.locator(".sheet-right").evaluate((element) => { const labels = [...element.querySelectorAll(".detail-header-actions button")].map((button) => button.getAttribute("aria-label")); return labels.length === 6 && labels.includes("Terminal") && labels.includes("Logs") && labels.includes("Files") && labels.includes("Edit") && labels.includes("Scale") && labels.includes("Delete") && !labels.includes("Restart"); });
  const sheetPriority = await page.evaluate(() => Number(getComputedStyle(document.querySelector(".sheet-right")).zIndex) > Number(getComputedStyle(document.querySelector(".session-dock")).zIndex));
  await page.locator(".sheet-right").getByRole("button", { name: "Terminal", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".session-action-bar .session-runtime-status")?.getAttribute("data-status") === "connected");
  const sessionTabs = page.locator(".bottom-session-tabs > button");
  const twoSessions = await sessionTabs.count() === 2 && await page.getByText(`Logs · ${paymentResourceName}`, { exact: true }).isVisible() && await page.getByText("Container terminal · catalog-indexer", { exact: true }).isVisible();
  await page.waitForFunction(() => document.querySelector(".container-terminal .xterm"));
  const terminalFontSizeApplied = await page.locator(".container-terminal").evaluate((terminal) => [...terminal.querySelectorAll(".xterm, .xterm-screen, .xterm-rows")].some((element) => getComputedStyle(element).fontSize === "16px"));
  const terminalModeControls = await page.locator(".session-action-bar").evaluate((bar) => {
    const pod = bar.querySelector('[aria-label="Pod"]');
    const container = bar.querySelector('[aria-label="Container"]');
    const tail = bar.querySelector('[aria-label="Tail lines"]');
    return {
      compact: bar.getBoundingClientRect().height <= 40,
      statusInBar: bar.querySelector(".session-runtime-status")?.getAttribute("data-status") === "connected" && bar.querySelector(".session-runtime-status")?.textContent.trim() === "",
      contextRemoved: !bar.querySelector(".session-runtime-context"),
      containerTerminalHasPodSelector: Boolean(pod),
      containerTerminalHasContainerSelector: Boolean(container),
      containerTerminalUsesCombobox: container?.matches("button") && Boolean(container.closest(".combobox.without-search")),
      containerTerminalHasNoLogControls: !tail && !bar.querySelector(".session-checkbox"),
      noComboSearch: !bar.querySelector(".session-target-combobox .combobox-search"),
      noContext: !bar.querySelector(".session-action-context"),
      reconnectHiddenWhileConnected: ![...bar.querySelectorAll("button")].some((button) => button.textContent.trim() === "Reconnect"),
    };
  });
  const terminalThemeScrollbar = await page.locator(".container-terminal .xterm-viewport").evaluate((viewport) => { const terminal = viewport.closest(".container-terminal"); const thumb = getComputedStyle(terminal).getPropertyValue("--terminal-scrollbar-thumb").trim(); const track = getComputedStyle(terminal).getPropertyValue("--terminal-scrollbar-track").trim(); const color = getComputedStyle(viewport).scrollbarColor; return Boolean(thumb && track && color !== "auto" && color !== ""); });
  const terminalViewport = page.locator(".container-terminal");
  await terminalViewport.click();
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(160);
  const terminalCharacterInputWorks = await page.locator(".terminal-output").evaluate((output) => Boolean(output.querySelector(".xterm")) && !output.querySelector(".terminal-command-row") && output.querySelector(".container-terminal").getBoundingClientRect().height >= output.getBoundingClientRect().height - 1);
  await terminalViewport.press("Control+f");
  await page.getByRole("textbox", { name: "Find text" }).fill("browser demo");
  const terminalSearchWorks = !["0/0", ""].includes((await page.locator(".text-search-count").textContent()) ?? "") && await page.locator(".text-search-popover").isVisible();
  await page.getByRole("button", { name: "Close search" }).click();
  const terminalSessionBeforeSwitch = await terminalViewport.getAttribute("data-session-id");
  await page.getByText(`Logs · ${paymentResourceName}`, { exact: true }).click();
  const switchedSessions = await page.locator('.session-action-bar .session-runtime-status[data-status="live"]').isVisible();
  await page.getByText("Container terminal · catalog-indexer", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".session-action-bar .session-runtime-status")?.getAttribute("data-status") === "connected" && document.querySelector(".container-terminal .xterm"));
  const terminalSessionPersisted = await page.locator(".container-terminal").evaluate((terminal, previousSessionId) => Boolean(previousSessionId && terminal.getAttribute("data-session-id") === previousSessionId && document.querySelector(".session-action-bar .session-runtime-status")?.getAttribute("data-status") === "connected"), terminalSessionBeforeSwitch);
  await page.getByText(`Logs · ${paymentResourceName}`, { exact: true }).click();
  const logModeControls = await page.locator(".session-action-bar").evaluate((bar) => {
    const pod = bar.querySelector('[aria-label="Pod"]');
    const container = bar.querySelector('[aria-label="Container"]');
    return {
      compact: bar.getBoundingClientRect().height <= 40,
      statusInBar: bar.querySelector(".session-runtime-status")?.getAttribute("data-status") === "live" && bar.querySelector(".session-runtime-status")?.textContent.trim() === "",
      contextRemoved: !bar.querySelector(".session-runtime-context"),
      directPodHasContainerOnly: !pod && Boolean(container),
      containerUsesCombobox: container?.matches("button")
        && Boolean(container.closest(".combobox.without-search"))
        && Boolean(container.querySelector(".combobox-leading-icon"))
        && !container.textContent.includes("Container:"),
      noContainerSearch: !bar.querySelector(".container-target-combobox .combobox-search"),
      tailLines: Boolean(bar.querySelector('[aria-label="Tail lines"]')),
      tailHasNoSearch: Boolean(bar.querySelector(".session-tail-combobox.without-search")),
      tailShowsNumberOnly: bar.querySelector('[aria-label="Tail lines"] strong')?.textContent.trim() === "1000",
      tailTriggerPrefix: bar.querySelector('[aria-label="Tail lines"]')?.textContent.trim() === "Tail1000",
      timestamps: Boolean(bar.querySelector('input[type="checkbox"]:checked')),
      previousTerminated: Boolean(bar.querySelector('input[aria-label="Previous terminated container logs"]:not(:checked)')),
      checkboxOrder: [...bar.querySelectorAll(".session-checkbox")].map((label) => label.textContent.trim()).join("|") === "Timestamps|Follow|Previous|Wrap",
      followLogs: bar.querySelectorAll('input[type="checkbox"]').length === 4,
      wrapLines: [...bar.querySelectorAll(".session-checkbox")].some((label) => label.textContent.trim() === "Wrap" && label.querySelector("input:checked")),
      download: Boolean(bar.querySelector('[aria-label="Download logs"]')),
    };
  });
  const tailSelector = page.locator('.session-action-bar [aria-label="Tail lines"]');
  await tailSelector.click();
  const tailOptionsHaveNoPrefix = await page.locator(".session-tail-combobox .combobox-options strong").allTextContents().then((labels) => labels.length === 5 && labels.every((label) => /^\d+$/.test(label.trim())));
  await tailSelector.click();
  const previousTerminatedLogs = page.locator('.session-action-bar input[aria-label="Previous terminated container logs"]');
  await previousTerminatedLogs.check();
  const previousTerminatedLogsWorks = await previousTerminatedLogs.isChecked();
  const directPodContainerButton = page.locator('.session-action-bar [aria-label="Container"]');
  const logContainerMenu = await directPodContainerButton.evaluate((container) => container.matches("button"))
    ? await (async () => {
        await directPodContainerButton.click();
        const result = await page.locator(".container-target-combobox .combobox-popover").evaluate((popover) => ({
          noSearch: !popover.querySelector(".combobox-search"),
          grouped: [...popover.querySelectorAll(".combobox-group-label")].some((label) => label.textContent === "Containers"),
          optionIcons: [...popover.querySelectorAll(".combobox-options button")].every((option) => Boolean(option.querySelector(".combobox-option-icon"))),
        }));
        await directPodContainerButton.click();
        return result;
      })()
    : { noSearch: true, grouped: true, optionIcons: true };
  const ansiLogColors = await page.locator(".logs-output pre").evaluate((pre) => [...pre.querySelectorAll(":scope span span")].some((span) => span.getAttribute("style")?.includes("color")));
  const logViewportUsesFullBody = await page.locator(".logs-output").evaluate((output) => !output.querySelector(":scope > div") && output.querySelector("pre").getBoundingClientRect().top - output.getBoundingClientRect().top <= 8);
  const logThemeScrollbar = await page.locator(".logs-output").evaluate((output) => { const thumb = getComputedStyle(output).getPropertyValue("--terminal-scrollbar-thumb").trim(); const track = getComputedStyle(output).getPropertyValue("--terminal-scrollbar-track").trim(); const color = getComputedStyle(output).scrollbarColor; return Boolean(thumb && track && color !== "auto" && color !== ""); });
  const defaultLogWrapping = await page.locator(".logs-output pre").evaluate((pre) => getComputedStyle(pre).whiteSpace === "pre-wrap" && getComputedStyle(pre).overflowWrap === "anywhere");
  const logFontSizeApplied = await page.locator(".logs-output pre").evaluate((pre) => getComputedStyle(pre).fontSize === "16px");
  await page.locator(".session-checkbox").filter({ hasText: "Wrap" }).click();
  const logWrappingToggle = await page.locator(".logs-output pre").evaluate((pre) => getComputedStyle(pre).whiteSpace === "pre");
  await page.locator(".terminal-output").press("Control+f");
  await page.getByRole("textbox", { name: "Find text" }).fill("INFO");
  const logSearchWorks = (await page.locator(".text-search-count").textContent()) === "1/2" && await page.locator(".terminal-output mark.current").isVisible();
  await page.getByRole("button", { name: "Close search" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download logs" }).click();
  const downloadedLog = await downloadPromise;
  const logDownloadToast = await page.locator(".app-toast").evaluate((toast) => toast.textContent.includes("Logs downloaded as") && toast.getAttribute("role") === "status");
  const logDownloadWorks = downloadedLog.suggestedFilename().endsWith(".log");
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  const restoredTargetHeight = (await bottomDock.boundingBox()).height;
  await page.getByRole("button", { name: "Maximize sessions" }).click();
  await page.waitForTimeout(220);
  const maximizedSessions = await bottomDock.evaluate((element) => { const dock = element.getBoundingClientRect(); const workspace = document.querySelector(".workspace-scroll").getBoundingClientRect(); return element.classList.contains("maximized") && dock.bottom === innerHeight && workspace.height >= 150 && Math.abs(workspace.bottom - dock.top) < 1; });
  await page.getByRole("button", { name: "Restore sessions" }).click();
  await page.waitForTimeout(220);
  const restoredSessions = Math.abs((await bottomDock.boundingBox()).height - restoredTargetHeight) < 2;
  await page.getByRole("button", { name: "Collapse sessions" }).click();
  await page.waitForTimeout(220);
  const collapsedPersists = await page.locator(".session-dock").evaluate((element) => element.classList.contains("collapsed") && element.getBoundingClientRect().height === 38) && await sessionTabs.count() === 2;
  await page.getByText(`Logs · ${paymentResourceName}`, { exact: true }).click();
  await page.waitForTimeout(220);
  const reexpanded = await page.locator(".session-dock").evaluate((element) => !element.classList.contains("collapsed") && element.getBoundingClientRect().height > 100);
  await page.getByRole("button", { name: "Close Container terminal · catalog-indexer", exact: true }).click();
  const individualClose = await sessionTabs.count() === 1;
  await page.getByRole("button", { name: "Deployments", exact: true }).click();
  const survivesResourceNavigation = await sessionTabs.count() === 1;
  await page.getByRole("button", { name: "Add session" }).click();
  await page.getByRole("button", { name: /^(Create resource|建立資源|创建资源)$/ }).click();
  await page.locator('.manifest-editor[data-format="yaml"] .cm-editor').waitFor();
  const yamlModeControls = await page.locator(".session-action-bar").evaluate((bar) => ({ compact: bar.getBoundingClientRect().height <= 40, apply: [...bar.querySelectorAll("button")].some((button) => button.textContent.trim() === "Apply"), applyAndClose: [...bar.querySelectorAll("button")].some((button) => button.textContent.trim() === "Apply and close"), validate: [...bar.querySelectorAll("button")].some((button) => button.textContent.trim() === "Validate YAML"), defaultYaml: bar.querySelector('[aria-label="Manifest format"] button[aria-pressed="true"]')?.textContent.trim() === "YAML", formatOptions: bar.querySelectorAll('[aria-label="Manifest format"] button').length === 2, formatOnRight: Boolean(bar.querySelector('.session-secondary-actions > [aria-label="Manifest format"]')), formatBeforeValidate: bar.querySelector('[aria-label="Manifest format"]')?.nextElementSibling?.textContent.trim() === "Validate YAML", noContext: !bar.querySelector(".session-action-context") }));
  const manifestAppearanceApplied = await page.locator(".manifest-editor").evaluate((editor) => {
    const code = editor.querySelector(".cm-editor");
    return editor.classList.contains("manifest-theme-light")
      && getComputedStyle(editor).backgroundColor === "rgb(251, 252, 253)"
      && getComputedStyle(code).fontFamily.includes("Fira Code")
      && getComputedStyle(code).fontSize === "16px";
  });
  const manifestSyntaxTheme = await page.locator(".manifest-editor").evaluate((editor) => {
    const root = document.documentElement;
    const wasLight = root.classList.contains("theme-light");
    const wasDark = root.classList.contains("theme-dark");
    root.classList.remove("theme-light");
    root.classList.add("theme-dark");
    const syntax = getComputedStyle(editor);
    const keyColor = syntax.getPropertyValue("--manifest-syntax-key").trim();
    const stringColor = syntax.getPropertyValue("--manifest-syntax-string").trim();
    const literalColor = syntax.getPropertyValue("--manifest-syntax-literal").trim();
    const tokens = [...editor.querySelectorAll(".cm-line span")];
    const keyToken = tokens.find((token) => token.textContent.includes("apiVersion"));
    const valueToken = tokens.find((token) => token.textContent.includes("apps/v1"));
    const literalToken = editor.querySelector(".cm-yaml-scalar-literal");
    const renderedKeyColor = keyToken ? getComputedStyle(keyToken).color : "";
    const renderedValueColor = valueToken ? getComputedStyle(valueToken).color : "";
    const renderedLiteralColor = literalToken ? getComputedStyle(literalToken).color : "";
    root.classList.toggle("theme-light", wasLight);
    root.classList.toggle("theme-dark", wasDark);
    const keyChannels = (renderedKeyColor.match(/\d+/g) || []).slice(0, 3).map(Number);
    const valueChannels = (renderedValueColor.match(/\d+/g) || []).slice(0, 3).map(Number);
    const literalChannels = (renderedLiteralColor.match(/\d+/g) || []).slice(0, 3).map(Number);
    return keyColor === "#176b4a" && stringColor === "#8a5d00" && literalColor === "#7a4594" && keyChannels.length === 3 && valueChannels.length === 3 && literalChannels.length === 3 && renderedKeyColor !== renderedValueColor && renderedValueColor !== renderedLiteralColor && valueChannels[0] > valueChannels[2] && valueChannels[1] > valueChannels[2] && literalChannels[2] > literalChannels[0];
  });
  const manifestEditor = page.locator(".manifest-editor .cm-content");
  await manifestEditor.press("Control+f");
  const yamlSearchInput = page.getByRole("textbox", { name: "Find text" });
  // Type real keystrokes: the first character must not yank focus back into
  // the editor, or the rest of the query lands in the document.
  await yamlSearchInput.pressSequentially("apiVersion");
  const yamlSearchKeepsFocus = await page.evaluate(() => document.activeElement?.closest(".text-search-popover") === document.querySelector(".text-search-popover"));
  const yamlSearchCount = await page.locator(".text-search-count").textContent();
  await yamlSearchInput.press("Escape");
  const yamlSearchRestoresFocus = await page.evaluate(() => document.activeElement?.closest(".cm-content") === document.querySelector(".manifest-editor .cm-content"));
  const yamlSearchWorks = yamlSearchCount === "1/1" && (await page.locator(".manifest-editor .cm-selectionBackground").count()) > 0 && yamlSearchKeepsFocus && yamlSearchRestoresFocus;
  const yamlFoldMarker = page.locator('.manifest-editor .cm-foldGutter span[title="Fold line"]').first();
  const yamlFoldAvailable = await yamlFoldMarker.isVisible();
  if (yamlFoldAvailable) await yamlFoldMarker.click();
  const yamlFoldingWorks = yamlFoldAvailable && await page.locator(".manifest-editor .cm-foldPlaceholder").isVisible();
  await page.getByRole("button", { name: "Validate YAML" }).click();
  const yamlValidationWorks = await page.getByText("YAML is valid in browser demo mode", { exact: true }).isVisible();
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await page.locator('.manifest-editor[data-format="json"] .cm-editor').waitFor();
  const jsonText = await page.locator(".manifest-editor .cm-content").textContent();
  let convertedJsonValid = false;
  try { const parsed = JSON.parse(jsonText); convertedJsonValid = parsed.apiVersion === "apps/v1" && parsed.metadata?.name === "new-resource"; } catch {}
  const jsonModeWorks = convertedJsonValid && await page.getByRole("button", { name: "Validate JSON" }).isVisible() && await page.getByRole("button", { name: "JSON", exact: true }).getAttribute("aria-pressed") === "true";
  const jsonFoldMarker = page.locator('.manifest-editor .cm-foldGutter span[title="Fold line"]').first();
  const jsonFoldAvailable = await jsonFoldMarker.isVisible();
  if (jsonFoldAvailable) await jsonFoldMarker.click();
  const jsonFoldingWorks = jsonFoldAvailable && await page.locator(".manifest-editor .cm-foldPlaceholder").isVisible();
  await page.getByRole("button", { name: "Validate JSON" }).click();
  const jsonValidationWorks = await page.getByText("JSON is valid in browser demo mode", { exact: true }).isVisible();
  const jsonEditor = page.locator(".manifest-editor .cm-content");
  await jsonEditor.click();
  await jsonEditor.press(selectAllShortcut);
  await page.keyboard.insertText("apiVersion: v1");
  await page.getByRole("button", { name: "Validate JSON" }).click();
  const invalidJsonRejected = await page.locator(".editor-feedback").evaluate((badge) => badge.textContent.includes("Invalid JSON:")) && await page.getByRole("button", { name: "Apply", exact: true }).isDisabled();
  await page.getByRole("button", { name: "YAML", exact: true }).click();
  const invalidSwitchPreserved = await page.locator('.manifest-editor[data-format="json"]').isVisible();
  await jsonEditor.click();
  await jsonEditor.press(selectAllShortcut);
  await page.keyboard.insertText('{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"new-resource"}}');
  await page.waitForFunction(() => [...document.querySelectorAll(".session-primary-actions button")].some((button) => button.textContent.trim() === "Apply" && !button.disabled));
  await page.getByRole("button", { name: "YAML", exact: true }).click();
  await page.locator('.manifest-editor[data-format="yaml"]').waitFor();
  const roundTripYaml = await page.locator(".manifest-editor .cm-content").textContent();
  const formatRoundTripWorks = invalidSwitchPreserved && roundTripYaml.includes("apiVersion: v1") && roundTripYaml.includes("kind: ConfigMap");
  await page.locator('.bottom-session-tabs [aria-label^="Close Create ·"]').click();
  const bottomSheetChrome = await page.locator(".session-dock").evaluate((element) => ({ flush: Math.abs(element.getBoundingClientRect().left - document.querySelector(".resource-nav").getBoundingClientRect().right) < 1 && element.getBoundingClientRect().right === innerWidth && element.getBoundingClientRect().bottom === innerHeight, square: parseFloat(getComputedStyle(element).borderRadius) === 0 }));
  await page.screenshot({ path: "artifacts/kubehive-persistent-session-dock.png", fullPage: true });

  // Alerts remain a compact dialog.
  await page.getByTitle("Alerts").click();
  const alertsDialog = await page.locator(".alerts-modal").evaluate((element) => ({ compact: element.querySelector(".dialog-header").getBoundingClientRect().height === 48, notSheet: !element.classList.contains("sheet") }));
  await page.locator(".alerts-modal").getByRole("button", { name: "Close", exact: true }).last().click();

  // Footer remains visible in short windows.
  const shortPage = await browser.newPage({ viewport: { width: 1000, height: 420 } });
  await shortPage.goto(baseUrl, { waitUntil: "networkidle" });
  const shortRail = await shortPage.evaluate(() => [document.querySelector('[aria-label="Alerts"]'), document.querySelector('[aria-label="Settings"]')].every((element) => { const box = element.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }));
  await shortPage.close();

  const readOnlyPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await readOnlyPage.goto(baseUrl, { waitUntil: "networkidle" });
  await readOnlyPage.evaluate(() => localStorage.clear());
  await readOnlyPage.reload({ waitUntil: "networkidle" });
  await readOnlyPage.getByRole("button", { name: "Actions production-eu" }).click();
  await readOnlyPage.locator(".cluster-actions-menu").getByRole("button", { name: "Connect" }).click();
  await readOnlyPage.getByRole("button", { name: "Secrets", exact: true }).click();
  await readOnlyPage.locator('[aria-label="Row actions"]').first().click();
  const editSecretManifest = readOnlyPage.getByRole("menuitem", { name: "Edit manifest" });
  const secretEditEnabled = await editSecretManifest.isEnabled();
  await editSecretManifest.click();
  await readOnlyPage.locator('.manifest-editor[data-format="yaml"] .cm-editor').waitFor();
  const readOnlyManifest = await readOnlyPage.locator(".session-action-bar").evaluate((bar, editEnabled) => {
    const editor = document.querySelector(".manifest-editor .cm-content");
    const notice = bar.querySelector(".manifest-read-only-notice");
    return Boolean(editEnabled)
      && Boolean(notice?.textContent?.includes("Secret manifests"))
      && ![...bar.querySelectorAll("button")].some((button) => ["Apply", "Apply and close", "Validate YAML"].includes(button.textContent.trim()))
      && !bar.querySelector('[aria-label="Manifest format"]')
      && editor?.getAttribute("contenteditable") === "false";
  }, secretEditEnabled);
  await readOnlyPage.close();

  const result = { clusterHome, clusterSearchWorks, clusterSearchEmpty, sensitiveActionHover, clusterSettings, clusterRenameWorks, clusterRenameRestored, connectionFlows, groupFilterWorks, specificResourceFilterWorks, resourceFilterPersisted, resourceFilterReset, initial, referenceResourceMenu, scrollbarChrome, settingsLayout, rowClickDidNotEdit, switchRowClickDidNotEdit, settingComboWidthsMatch, settingComboOptionHeightsMatch, otherSettingClosesCombobox, terminalEditorsSetting, terminalThemeSettingWorks, terminalFontSettingWorks, terminalFontSizeSettingWorks, canonicalResources, lightSurfaces, lightApplied, lightLiveIndicator, lightSettingsToggle, preciseSwitchWorks, activeLightSettingsToggle, updateStatusInTitle, aboutRailButtonOrder, addClusterHeader, manualTabState, lightResourceKind, resourceToolbar, resourceTableBehavior, emptyResourceRowBehavior, columnSortingWorks, sortPersistenceWorks, sheetChrome, sheetWidths: { before: sheetBefore.width, after: sheetAfter.width }, sheetResizable, firstSession, permanentAddButton, plusFollowsTabs, addSessionMenu, plusCreatedSession, plusSessionClosable, tabRailInteractions, bottomAlignment, bottomHeights: { before: bottomBefore.height, after: bottomAfter.height }, bottomResizable, bottomPushesWorkspace, bottomListEndReachable, bottomHeightPersisted, collapsedAddButtonVisible, collapsedHeights: { before: collapsedBeforeResize.height, after: collapsedAfterResize.height }, collapsedBorderResize, statefulSetActions, sheetPriority, twoSessions, terminalModeControls, terminalThemeScrollbar, terminalFontSizeApplied, terminalCharacterInputWorks, terminalSearchWorks, switchedSessions, terminalSessionPersisted, logModeControls, tailOptionsHaveNoPrefix, previousTerminatedLogsWorks, logContainerMenu, ansiLogColors, logViewportUsesFullBody, logThemeScrollbar, defaultLogWrapping, logFontSizeApplied, logWrappingToggle, logSearchWorks, logDownloadWorks, logDownloadToast, maximizedSessions, restoredSessions, collapsedPersists, reexpanded, individualClose, survivesResourceNavigation, manifestAppearanceApplied, manifestSyntaxTheme, yamlModeControls, yamlSearchWorks, yamlFoldingWorks, yamlValidationWorks, jsonModeWorks, jsonFoldingWorks, jsonValidationWorks, invalidJsonRejected, formatRoundTripWorks, bottomSheetChrome, alertsDialog, shortRail, readOnlyManifest, errors };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  const manifestEditorChecks = manifestAppearanceApplied && manifestSyntaxTheme && Object.values(yamlModeControls).every(Boolean) && yamlSearchWorks && yamlFoldingWorks && yamlValidationWorks && jsonModeWorks && jsonFoldingWorks && jsonValidationWorks && invalidJsonRejected && formatRoundTripWorks && readOnlyManifest;
  if (manifestOnly) {
    if (errors.length || !manifestEditorChecks) process.exit(1);
    return;
  }
  if (errors.length || !Object.values(clusterHome).every(Boolean) || !clusterSearchWorks || !clusterSearchEmpty || !sensitiveActionHover || !clusterSettings.oneLineTitle || clusterSettings.headerHeight !== 48 || !clusterSettings.squareColor || !clusterRenameWorks || !clusterRenameRestored || !Object.values(connectionFlows).every(Boolean) || !groupFilterWorks || !specificResourceFilterWorks || !resourceFilterPersisted || !resourceFilterReset || !Object.values(initial).every(Boolean) || !referenceResourceMenu || scrollbarChrome.width !== "5px" || scrollbarChrome.track !== "rgba(0, 0, 0, 0)" || scrollbarChrome.border !== "0px" || scrollbarChrome.button !== "0px" || !scrollbarChrome.thin || !Object.values(settingsLayout).every(Boolean) || !rowClickDidNotEdit || !switchRowClickDidNotEdit || !settingComboWidthsMatch || !settingComboOptionHeightsMatch || !otherSettingClosesCombobox || !terminalEditorsSetting || !terminalThemeSettingWorks || !terminalFontSettingWorks || !terminalFontSizeSettingWorks || !canonicalResources || !lightApplied || !lightLiveIndicator || !lightSettingsToggle || !preciseSwitchWorks || !activeLightSettingsToggle || !updateStatusInTitle || !aboutRailButtonOrder || !Object.values(addClusterHeader).every(Boolean) || !Object.values(manualTabState).every(Boolean) || !lightResourceKind || !Object.values(resourceToolbar).every(Boolean) || !Object.values(resourceTableBehavior).every(Boolean) || !Object.values(emptyResourceRowBehavior).every(Boolean) || !columnSortingWorks || !sortPersistenceWorks || !Object.values(sheetChrome).every(Boolean) || !sheetResizable || !firstSession || !permanentAddButton || !plusFollowsTabs || !Object.values(addSessionMenu).every(Boolean) || !plusCreatedSession || !plusSessionClosable || !Object.values(tabRailInteractions.workspace).every(Boolean) || !Object.values(tabRailInteractions.sessions).every(Boolean) || !Object.values(bottomAlignment).every(Boolean) || !bottomResizable || !bottomPushesWorkspace || !bottomListEndReachable || !bottomHeightPersisted || !collapsedAddButtonVisible || !collapsedBorderResize || !statefulSetActions || !sheetPriority || !twoSessions || !Object.values(terminalModeControls).every(Boolean) || !terminalThemeScrollbar || !terminalFontSizeApplied || !terminalCharacterInputWorks || !terminalSearchWorks || !switchedSessions || !terminalSessionPersisted || !Object.values(logModeControls).every(Boolean) || !tailOptionsHaveNoPrefix || !previousTerminatedLogsWorks || !Object.values(logContainerMenu).every(Boolean) || !ansiLogColors || !logViewportUsesFullBody || !logThemeScrollbar || !defaultLogWrapping || !logFontSizeApplied || !logWrappingToggle || !logSearchWorks || !logDownloadWorks || !logDownloadToast || !maximizedSessions || !restoredSessions || !collapsedPersists || !reexpanded || !individualClose || !survivesResourceNavigation || !manifestAppearanceApplied || !manifestSyntaxTheme || !Object.values(yamlModeControls).every(Boolean) || !yamlSearchWorks || !yamlFoldingWorks || !yamlValidationWorks || !jsonModeWorks || !jsonFoldingWorks || !jsonValidationWorks || !invalidJsonRejected || !formatRoundTripWorks || !Object.values(bottomSheetChrome).every(Boolean) || !Object.values(alertsDialog).every(Boolean) || !shortRail || !readOnlyManifest) process.exit(1);
})();
