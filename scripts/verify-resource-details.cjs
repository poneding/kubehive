const { chromium } = require("playwright");
const { readFileSync } = require("node:fs");

(async () => {
  const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));

  const navigate = async (resource) => {
    await page.locator(`.resource-nav nav button[aria-label="${resource}"]`).click();
    await page.locator(".page-head h1").getByText(resource, { exact: true }).waitFor();
  };
  const openRow = async (name) => {
    const row = page.locator(".resource-table tbody tr").filter({ hasText: name }).first();
    await row.waitFor();
    await row.locator("td:not(.selection-col)").first().click();
    await page.locator(".sheet-right").waitFor();
    await page.waitForTimeout(80);
  };
  const sections = () => page.locator("[data-detail-section]").evaluateAll((items) => items.map((item) => item.getAttribute("data-detail-section")));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('[aria-label="Connect production-eu"]').first().click();
  await page.locator(".resource-nav").waitFor();

  await navigate("Pods");
  await openRow("checkout-api");
  const podSections = await sections();
  const podText = await page.locator(".drawer-body").innerText();
  const rawIdentityVisible = await page.locator(".drawer-body").evaluate((drawer) => ["API version", "Kind", "UID", "Resource version"].some((label) => [...drawer.querySelectorAll("*")].some((element) => element.childElementCount === 0 && element.textContent.trim() === label)));
  const propertyCardsFramed = await page.locator(".detail-property").evaluateAll((properties) => properties.length > 0 && properties.every((property) => {
    const style = getComputedStyle(property);
    return style.borderStyle === "solid" && style.borderWidth === "1px" && style.backgroundColor !== "rgba(0, 0, 0, 0)";
  }));
  const metadataCountsUnified = await page.locator(".detail-property-meta").evaluateAll((groups) => groups.length === 2 && groups.every((group) => {
    const header = group.querySelector("header").getBoundingClientRect();
    const actions = group.querySelector(".detail-property-meta-actions");
    const badge = actions.querySelector(".ui-badge.tone-blue");
    const badgeBounds = badge?.getBoundingClientRect();
    const showAll = actions.querySelector(".detail-show-all")?.getBoundingClientRect();
    return badgeBounds && Math.abs(header.right - badgeBounds.right) < 1 && (!showAll || showAll.right <= badgeBounds.left);
  }));
  const conditionCountBlue = await page.locator('[data-detail-section="status"] [data-status-subsection="conditions"] > header .ui-badge.tone-blue').count() === 1;
  const countBadgesBlue = await page.evaluate(() => {
    const countBadges = [
      ...document.querySelectorAll(".detail-property-meta-actions .ui-badge"),
      ...document.querySelectorAll(".detail-section-heading .ui-badge"),
      ...document.querySelectorAll(".detail-container-subsection > header .ui-badge"),
      ...document.querySelectorAll(".detail-property-relation-group > div:first-child .ui-badge"),
    ];
    return countBadges.length > 0 && countBadges.every((badge) => badge.classList.contains("tone-blue"));
  });
  const labelsCopy = await page.locator('[data-property-metadata="labels"] button[title^="Copy"]').count();
  const annotations = await page.locator('[data-property-metadata="annotations"]').count();
  const metadataCopyIconsHidden = await page.locator('[data-property-metadata="labels"] button svg, [data-property-metadata="annotations"] button svg').count() === 0;
  await page.locator('[data-property-metadata="labels"] button[title^="Copy"]').first().click();
  await page.locator(".app-toast").waitFor();
  const metadataCopyToast = (await page.locator(".app-toast").innerText()).includes("Label copied to clipboard") && (await page.evaluate(() => navigator.clipboard.readText())).includes("=");
  const portTableRestored = await page.locator(".detail-port-table").count() > 0 && await page.locator(".detail-container-port-list").count() === 0;
  const environmentToggleInline = await page.locator(".detail-container-subsection > header .detail-show-more").count() > 0 && await page.locator(".detail-env-wrap > .detail-show-more").count() === 0;
  const environmentControlsCollapsed = await page.locator(".detail-container-card").first().locator(".detail-subsection-actions").evaluate((actions) => [...actions.children].map((element) => ({ tag: element.tagName, text: element.textContent?.trim() })));
  const environmentLimitedCollapsed = await page.locator(".detail-container-card").first().locator(".detail-env-row").count() === 3 && environmentControlsCollapsed[0]?.text === "Show all" && environmentControlsCollapsed[1]?.text === "4";
  await page.locator(".detail-container-card").first().locator(".detail-show-more").filter({ hasText: "Show all" }).click();
  const environmentRows = page.locator(".detail-container-card").first().locator(".detail-env-row");
  const environmentEqualHeight = await environmentRows.evaluateAll((rows) => {
    if (rows.length < 2) return false;
    const heights = rows.map((row) => Math.round(row.getBoundingClientRect().height * 10) / 10);
    return heights.every((height) => height === 30);
  });
  const sensitiveRow = environmentRows.filter({ hasText: "API_TOKEN" });
  const environmentMasked = (await sensitiveRow.locator(":scope > span").innerText()).includes("••••");
  await sensitiveRow.getByRole("button", { name: /Reveal environment variable/ }).click();
  const environmentReveal = (await sensitiveRow.locator(":scope > span").innerText()).includes("Secret/") && await sensitiveRow.getByRole("button", { name: /Copy environment variable/ }).count() === 1;
  const containerHeaderLayout = await page.locator(".detail-container-card").first().locator("summary").evaluate((summary) => {
    const bounds = summary.getBoundingClientRect();
    const elements = [summary.querySelector(".detail-container-state"), summary.querySelector("strong"), summary.querySelector(".detail-inline-copy"), summary.querySelector(".ui-badge"), summary.querySelector(":scope > svg")];
    const centers = elements.map((element) => { const rect = element.getBoundingClientRect(); return rect.top + rect.height / 2; });
    const name = summary.querySelector(".detail-container-title strong").getBoundingClientRect();
    const copy = summary.querySelector(".detail-container-title .detail-inline-copy").getBoundingClientRect();
    const factLabels = [...summary.closest(".detail-container-card").querySelectorAll(".detail-container-fact > span")].map((element) => element.textContent?.trim());
    return {
      simplified: summary.querySelector("small") === null && summary.querySelector("strong")?.textContent === "checkout",
      compact: bounds.height === 36,
      centered: centers.every((center) => Math.abs(center - (bounds.top + bounds.height / 2)) < 1),
      copyFollowsName: copy.left - name.right >= 1 && copy.left - name.right <= 3,
      stateInTitle: Boolean(summary.querySelector(".ui-badge")?.textContent?.trim()) && !factLabels.includes("State"),
      readyAndRestartsRemoved: !factLabels.includes("Ready") && !factLabels.includes("Restarts"),
    };
  });
  const resourceLayout = await page.locator(".detail-container-card").first().evaluate((card) => ({
    rows: [...card.querySelectorAll(".detail-resource-row")].map((row) => [...row.children].map((cell) => cell.textContent?.trim())),
    columns: getComputedStyle(card.querySelector(".detail-resource-row")).gridTemplateColumns.split(" ").length,
  }));
  const digest = page.locator(".detail-image-id").first();
  const digestHidden = await digest.evaluate((element) => getComputedStyle(element).visibility === "hidden" && getComputedStyle(element).position === "absolute");
  await page.locator(".detail-image-address").first().hover();
  await page.waitForTimeout(150);
  const digestVisibleOnHover = await digest.evaluate((element) => getComputedStyle(element).visibility === "visible" && getComputedStyle(element).opacity === "1");
  const imageCopyAligned = await page.locator(".detail-image-address").first().evaluate((element) => {
    const image = element.querySelector("code").getBoundingClientRect();
    const button = element.querySelector(".detail-inline-copy").getBoundingClientRect();
    return {
      aligned: Math.abs(image.top + image.height / 2 - button.top - button.height / 2) < 1,
      followsImage: button.left - image.right >= 4 && button.left - image.right <= 6,
    };
  });
  const imagePullPolicy = await page.locator(".detail-image-heading").first().evaluate((heading) => {
    const label = heading.querySelector(":scope > span");
    const badge = heading.querySelector(".detail-pull-policy-badge");
    const labelBounds = label.getBoundingClientRect();
    const badgeBounds = badge.getBoundingClientRect();
    const style = getComputedStyle(badge);
    const headingBounds = heading.getBoundingClientRect();
    return {
      value: badge.textContent.trim() === "IfNotPresent",
      sameRow: Math.abs(labelBounds.top + labelBounds.height / 2 - badgeBounds.top - badgeBounds.height / 2) < 1,
      rightAligned: Math.abs(headingBounds.right - badgeBounds.right) < 1,
      borderless: style.borderTopWidth === "0px" && style.borderRightWidth === "0px" && style.borderBottomWidth === "0px" && style.borderLeftWidth === "0px",
    };
  });
  await page.getByRole("button", { name: "Copy image", exact: true }).first().click();
  await page.locator(".app-toast").filter({ hasText: "Image copied to clipboard" }).waitFor();
  const imageCopyToast = true;
  const conditionDotAligned = await page.locator(".condition-row").first().evaluate((row) => {
    const dot = row.querySelector(".detail-condition-dot").getBoundingClientRect();
    const title = row.querySelector("strong").getBoundingClientRect();
    return Math.abs(dot.top + dot.height / 2 - title.top - title.height / 2) < 1;
  });
  const groupedListStyle = await page.evaluate(() => {
    const isGrouped = (listSelector, rowSelector) => {
      const list = document.querySelector(listSelector);
      if (!list) return false;
      const listStyle = getComputedStyle(list);
      const rows = [...list.querySelectorAll(rowSelector)];
      if (!rows.length) return false;
      const outerBox = listStyle.borderStyle === "solid" && listStyle.borderWidth === "1px" && listStyle.borderRadius === "6px";
      const rowsBare = rows.every((row, index) => {
        const style = getComputedStyle(row);
        const noOwnBox = style.borderTopWidth === "0px" && style.borderLeftWidth === "0px" && style.borderRightWidth === "0px" && style.borderRadius === "0px";
        const divider = index === rows.length - 1 ? style.borderBottomWidth === "0px" : style.borderBottomWidth === "1px";
        return noOwnBox && divider;
      });
      return outerBox && rowsBare;
    };
    return isGrouped(".detail-env-list", ".detail-env-row") && isGrouped(".detail-condition-list", ".condition-row");
  });
  const detailPanelsSource = readFileSync("src/detail-panels.tsx", "utf8");
  const appSource = readFileSync("src/App.tsx", "utf8");
  const resourceDetailsStyle = readFileSync("src/resource-details.css", "utf8");
  const metricsUsesCombobox = detailPanelsSource.includes('<Combobox className="detail-metrics-range"') && !detailPanelsSource.includes('<select aria-label="Metrics time range"');
  const metricsUsesIconTabs = ["Cpu", "MemoryStick", "Network", "HardDrive"].every((icon) => detailPanelsSource.includes(`icon: ${icon}`)) && detailPanelsSource.includes('data-tooltip={tab.label}');
  const metricsReservesSpace = resourceDetailsStyle.includes("height: 196px;") && detailPanelsSource.includes('className="detail-chart-placeholder"');
  const containerDefaultExpansion = detailPanelsSource.includes('open={container.kind === "container"}') && !detailPanelsSource.includes("open={index === 0}");
  const regularContainersExpanded = await page.locator(".detail-container-card").evaluateAll((cards) => cards.length > 0 && cards.every((card) => card.open));
  const allCopiesUseToast = !detailPanelsSource.includes("navigator.clipboard") && appSource.includes("const copyDetailValue: DetailCopyHandler") && appSource.includes('showToast("success", `${label} copied to clipboard`)');
  const statusSectionRender = await page.evaluate(async () => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { StatusSection } = await import("/src/detail-panels.tsx");
    const host = document.createElement("div");
    host.className = "sheet-right";
    host.style.cssText = "position:absolute;left:-10000px;top:0;width:410px";
    const runningHost = document.createElement("div");
    const failedHost = document.createElement("div");
    const missingPhaseHost = document.createElement("div");
    host.append(runningHost, failedHost, missingPhaseHost);
    document.body.append(host);
    const row = (phase, status = {}) => ({ kind: "Pod", status: phase, data: {}, backend: { object: { status: { phase, ...status } } } });
    const missingPhase = { kind: "Pod", status: "Failed", data: {}, backend: { object: { status: { reason: "Should not render", message: "Should not render" } } } };
    const noop = () => {};
    const roots = [
      [runningHost, row("Running")],
      [failedHost, row("Failed", { reason: "Evicted", message: "The node was low on memory." })],
      [missingPhaseHost, missingPhase],
    ].map(([target, item]) => {
      const root = ReactDOM.createRoot(target);
      root.render(React.createElement(StatusSection, { row: item, conditions: [], fallbackStatus: item.status, onOpenResource: noop, onCopy: noop }));
      return root;
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const fields = (target) => [...target.querySelectorAll(".detail-property")].map((field) => field.textContent.trim());
    const details = (target) => {
      const conditions = target.querySelector('[data-status-subsection="conditions"]');
      return {
        fields: fields(target),
        phase: target.querySelector(".detail-section-heading .detail-header-status")?.textContent.trim(),
        conditionsDivider: getComputedStyle(conditions).borderTopWidth,
      };
    };
    const result = { running: details(runningHost), failed: details(failedHost), missingPhase: details(missingPhaseHost) };
    roots.forEach((root) => root.unmount());
    host.remove();
    return result;
  });

  const pod = {
    exactOrder: podSections.join(",") === "properties,containers,status",
    metricsHiddenWithoutService: !podSections.includes("metrics"),
    properties: podSections.includes("properties"),
    status: podSections.includes("status"),
    phaseInStatusHeading: await page.locator('[data-detail-section="status"] > .detail-section-heading .detail-header-status').count() === 1 && (await page.locator('[data-detail-section="status"] > .detail-section-heading .detail-header-status').innerText()) === "Running",
    statusHasNoPhaseField: await page.locator('[data-detail-section="status"] .detail-property').count() === 0,
    statusSubsections: await page.locator('[data-detail-section="status"] [data-status-subsection]').evaluateAll((sections) => sections.map((section) => section.getAttribute("data-status-subsection")).join(",") === "conditions,events"),
    statusNoDetailsDivider: await page.locator('[data-detail-section="status"] [data-status-subsection="conditions"]').evaluate((section) => getComputedStyle(section).borderTopWidth === "0px"),
    statusFieldsConditional: statusSectionRender.running.fields.length === 0 && statusSectionRender.running.phase === "Running" && statusSectionRender.running.conditionsDivider === "0px" && statusSectionRender.failed.fields.join(",") === "MessageThe node was low on memory." && statusSectionRender.failed.phase === "Failed · Evicted" && statusSectionRender.failed.conditionsDivider === "1px" && statusSectionRender.missingPhase.fields.length === 0 && statusSectionRender.missingPhase.phase === "Failed" && statusSectionRender.missingPhase.conditionsDivider === "0px",
    propertyCardsFramed,
    metadataCountsUnified,
    conditionCountBlue,
    countBadgesBlue,
    containers: podSections.includes("containers"),
    conditions: await page.locator('[data-detail-section="status"] [data-status-subsection="conditions"]').count() === 1,
    events: await page.locator('[data-detail-section="status"] [data-status-subsection="events"]').count() === 1,
    noOtherPodSections: podSections.every((id) => ["metrics", "properties", "containers", "status"].includes(id)),
    copyableLabels: labelsCopy > 0,
    metadataCopyIconsHidden,
    metadataCopyToast,
    allCopiesUseToast,
    annotations: annotations === 1,
    links: ["Namespace", "Controlled by", "Node", "Service account"].every((label) => podText.includes(label)),
    imageDigest: digestHidden && digestVisibleOnHover,
    imageCopyAligned: imageCopyAligned.aligned,
    imageCopyFollowsAddress: imageCopyAligned.followsImage,
    imageCopyToast,
    pullPolicy: Object.values(imagePullPolicy).every(Boolean) && !podText.includes("Pull policy"),
    containerTitleSimplified: containerHeaderLayout.simplified,
    containerHeaderCompact: containerHeaderLayout.compact,
    containerHeaderCentered: containerHeaderLayout.centered,
    containerNameCopyInline: containerHeaderLayout.copyFollowsName,
    containerStateInTitle: containerHeaderLayout.stateInTitle,
    containerReadyAndRestartsRemoved: containerHeaderLayout.readyAndRestartsRemoved,
    containerDefaultExpansion,
    regularContainersExpanded,
    resources: resourceLayout.rows.length === 2 && resourceLayout.columns === 2 && resourceLayout.rows.flat().every((cell) => ["CPU request100m", "CPU limit1", "Memory request128Mi", "Memory limit512Mi"].includes(cell)),
    integratedPorts: portTableRestored && !podSections.includes("port-forward-ports"),
    environmentLimited: environmentLimitedCollapsed,
    environmentToggleInline,
    environmentEqualHeight,
    environmentMasked,
    environmentReveal,
    metricsUsesCombobox,
    metricsUsesIconTabs,
    metricsReservesSpace,
    conditionDotAligned,
    groupedListStyle,
    typedMount: podText.includes("ConfigMap") && podText.includes("/etc/app") && podText.includes("RO"),
    noKeyRelationships: !podSections.includes("key-relations") && !podText.includes("Key relationships"),
    noRawIdentity: !rawIdentityVisible,
  };

  const statusData = await page.evaluate(async () => {
    const { getResourceStatusProperties, getResourceStatusValue } = await import("/src/resource-details.ts");
    const failed = { kind: "Pod", status: "Failed", data: {}, backend: { object: { status: { phase: "Failed", reason: "Evicted", message: "The node was low on memory." } } } };
    const succeeded = { kind: "Pod", status: "Succeeded", data: { reason: "Complete", message: "The Pod completed." }, backend: { object: { status: { phase: "Succeeded", reason: "Complete", message: "The Pod completed." } } } };
    const failedFields = getResourceStatusProperties(failed);
    const lowercasePhase = { kind: "Pod", status: "failed", data: { reason: "Should not render", message: "Should not render" }, backend: { object: { status: { phase: "failed", reason: "Should not render", message: "Should not render" } } } };
    const missingPhase = { kind: "Pod", status: "Failed", data: { reason: "Should not render", message: "Should not render" }, backend: { object: { status: { reason: "Should not render", message: "Should not render" } } } };
    return getResourceStatusValue(failed) === "Failed"
      && failedFields.map((field) => field.label).join(",") === "Message"
      && failedFields.map((field) => field.value).join(",") === "The node was low on memory."
      && getResourceStatusProperties(succeeded).length === 0
      && getResourceStatusProperties(lowercasePhase).length === 0
      && getResourceStatusProperties(missingPhase).length === 0;
  });

  const defaultSheetStyle = await page.evaluate(() => {
    const sheet = document.querySelector(".sheet-right");
    const body = document.querySelector(".drawer-body");
    const heading = document.querySelector(".detail-section-heading");
    const mountTable = document.querySelector(".detail-mount-table");
    const title = document.querySelector(".sheet-title-stack");
    return {
      noBodyOverflow: body.scrollWidth <= body.clientWidth,
      noMountOverflow: mountTable.scrollWidth <= mountTable.clientWidth,
      sectionOwnsSpacing: getComputedStyle(body).padding === "0px" && Math.round(heading.getBoundingClientRect().x - sheet.getBoundingClientRect().x - parseFloat(getComputedStyle(sheet).borderLeftWidth)) <= 16,
      titleReadable: title.getBoundingClientRect().width >= 110,
      expandedActions: [...document.querySelectorAll(".detail-header-actions button")].filter((button) => getComputedStyle(button).display !== "none").map((button) => button.getAttribute("aria-label")).join(",") === "Edit,Terminal,Logs,Files,Evict,Delete",
      noHeaderOverflow: document.querySelector(".detail-sheet-header").scrollWidth <= document.querySelector(".detail-sheet-header").clientWidth,
      metadataFocusSafe: document.querySelectorAll('.detail-property-meta button[tabindex="-1"][aria-hidden="true"]').length > 0,
    };
  });
  await page.evaluate(() => {
    document.documentElement.classList.add("theme-light");
    document.documentElement.classList.remove("theme-dark");
  });
  const lightThemeStyle = await page.evaluate(() => {
    const badge = getComputedStyle(document.querySelector(".ui-badge.tone-green"));
    const labelKey = getComputedStyle(document.querySelector(".detail-label-list code"));
    const annotationKey = getComputedStyle(document.querySelector(".detail-annotation-list > button strong"));
    const showAll = getComputedStyle(document.querySelector(".detail-show-all"));
    const sheet = getComputedStyle(document.querySelector(".sheet-right"));
    const property = getComputedStyle(document.querySelector(".detail-property"));
    return {
      badgeColor: badge.color === "rgb(15, 122, 77)",
      badgeBackground: badge.backgroundColor === "rgb(217, 247, 232)",
      readableMetadata: labelKey.color === "rgb(21, 95, 132)" && annotationKey.color === "rgb(21, 95, 132)" && showAll.color === "rgb(20, 121, 79)",
      readableChartPalette: sheet.getPropertyValue("--detail-chart-1").trim() === "#147a52" && sheet.getPropertyValue("--detail-chart-2").trim() === "#0879a8",
      propertyCardTheme: property.borderColor === "rgb(215, 224, 229)" && property.backgroundColor === "rgb(255, 255, 255)",
    };
  });
  const resizeEdge = page.locator(".sheet-resize-edge.vertical");
  await resizeEdge.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(180);
  const resizeFocusVisible = await resizeEdge.evaluate((edge) => edge.matches(":focus-visible") && getComputedStyle(edge, "::after").backgroundColor === "rgb(78, 211, 154)");
  await page.keyboard.press("Home");
  await page.waitForTimeout(100);
  const narrowSheetStyle = await page.evaluate(() => {
    const sheet = document.querySelector(".sheet-right");
    const body = document.querySelector(".drawer-body");
    const mountTable = document.querySelector(".detail-mount-table");
    const title = document.querySelector(".sheet-title-stack");
    const properties = document.querySelector(".detail-property-grid");
    const section = document.querySelector(".detail-section");
    const toolbar = document.createElement("div");
    toolbar.className = "detail-metrics-toolbar";
    toolbar.innerHTML = '<h3>Metrics</h3><div class="detail-metrics-controls"><div class="detail-metric-tabs"><button><svg></svg></button><button><svg></svg></button><button><svg></svg></button><button><svg></svg></button></div><div class="detail-metrics-range"></div></div>';
    section.prepend(toolbar);
    const controls = toolbar.querySelector(".detail-metrics-controls");
    const metricToolbarResponsive = toolbar.scrollWidth <= toolbar.clientWidth && getComputedStyle(toolbar).flexDirection === "column" && getComputedStyle(controls).flexDirection === "row";
    const compactActions = [...document.querySelectorAll(".detail-header-actions button")].filter((button) => getComputedStyle(button).display !== "none").map((button) => button.getAttribute("aria-label")).join(",") === "Edit,Terminal,Actions";
    toolbar.remove();
    return {
      width: Math.round(sheet.getBoundingClientRect().width) === 320,
      noBodyOverflow: body.scrollWidth <= body.clientWidth,
      noMountOverflow: mountTable.scrollWidth <= mountTable.clientWidth,
      singleColumnProperties: getComputedStyle(properties).gridTemplateColumns.split(" ").length === 1,
      titleReadable: title.getBoundingClientRect().width >= 120,
      compactActions,
      metricToolbarResponsive,
    };
  });
  const sheetStyle = { default: defaultSheetStyle, light: lightThemeStyle, narrow: narrowSheetStyle, resizeFocusVisible };

  const controlledBy = page.locator('[data-detail-section="properties"] .detail-property').filter({ hasText: "Controlled by" }).locator(".detail-resource-link");
  await controlledBy.click();
  await page.locator(".sheet-title-stack small").getByText("Deployment", { exact: true }).waitFor();
  const ownerNavigation = true;

  await navigate("Services");
  await openRow("checkout-api");
  const servicePortStyle = await page.locator('[data-detail-section="service-ports"]').evaluate((section) => {
    const heading = section.querySelector(".detail-section-heading");
    const badge = heading?.querySelector(".ui-badge.tone-blue");
    const table = section.querySelector(".detail-port-table");
    if (!heading || !badge || !table) return false;
    const headingStyle = getComputedStyle(heading);
    const badgeBounds = badge.getBoundingClientRect();
    const headingBounds = heading.getBoundingClientRect();
    const headers = [...table.querySelectorAll("thead th")].map((header) => header.textContent?.trim());
    return headingStyle.display.includes("flex")
      && Math.abs(headingBounds.right - badgeBounds.right) < 1
      && badgeBounds.width < headingBounds.width / 2
      && headers.join(",") === "Name,Port,Protocol,Address,Forward"
      && section.querySelectorAll(".detail-port-table tbody tr").length > 0;
  });

  await navigate("Config Maps");
  await openRow("checkout-api-config");
  const configSections = await sections();
  await page.locator(".detail-data-entry").first().locator("summary").click();
  const configMap = {
    properties: configSections[0] === "properties",
    preview: configSections.includes("data-preview") && (await page.locator(".detail-data-entry").first().locator("pre").innerText()).includes("server:"),
    noKeyRelationships: !configSections.includes("key-relations"),
  };

  await navigate("Secrets");
  await openRow("checkout-api-tls");
  const secretSections = await sections();
  await page.locator(".detail-data-entry").first().locator("summary").click();
  const rawByDefault = (await page.locator(".detail-data-entry").first().locator("pre").innerText()).startsWith("LS0t");
  await page.locator(".detail-data-entry").first().getByRole("button", { name: "Decode base64" }).click();
  const decoded = await page.locator(".detail-data-entry").first().locator("pre").innerText();
  await page.locator(".detail-data-entry").first().getByRole("button", { name: "Copy decoded" }).click();
  await page.locator(".app-toast").filter({ hasText: "Decoded value copied to clipboard" }).waitFor();
  const decodedCopyToast = true;
  const secret = {
    properties: secretSections[0] === "properties",
    decodedPreview: rawByDefault && decoded.includes("BEGIN CERTIFICATE"),
    decodedCopyToast,
    perKey: await page.locator(".detail-data-entry").count() >= 2,
    noKeyRelationships: !secretSections.includes("key-relations"),
  };

  const resources = await page.locator(".resource-nav nav button[aria-label]").evaluateAll((buttons) => [...new Set(buttons.filter((button) => !button.disabled).map((button) => button.getAttribute("aria-label")).filter((label) => label && label !== "Overview"))]);
  const sweepFailures = [];
  for (const resource of resources) {
    await navigate(resource);
    const row = page.locator(".resource-table tbody tr").first();
    if (!await row.count()) { sweepFailures.push(`${resource}: no demo row`); continue; }
    await row.locator("td:not(.selection-col)").first().click();
    await page.locator(".sheet-right").waitFor();
    const ids = await sections();
    if (!ids.includes("properties")) sweepFailures.push(`${resource}: no Properties section`);
    if (!ids.includes("status")) sweepFailures.push(`${resource}: no Status section`);
    if (ids.includes("key-relations")) sweepFailures.push(`${resource}: standalone key relationships remain`);
  }

  const metricsPage = await context.newPage();
  metricsPage.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`metrics console: ${message.text()}`); });
  metricsPage.on("pageerror", (error) => runtimeErrors.push(`metrics page: ${error.message}`));
  await metricsPage.goto(baseUrl, { waitUntil: "networkidle" });
  await metricsPage.evaluate(async () => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { PodMetricsSection } = await import("/src/detail-panels.tsx");
    const createHost = () => {
      const host = document.createElement("div");
      host.className = "sheet-right";
      host.style.cssText = "position:relative;width:410px;height:360px";
      document.body.append(host);
      return host;
    };
    document.body.innerHTML = "";
    const host = createHost();
    const loadingHost = createHost();
    const now = Date.now() / 1000;
    const points = [{ timestamp: now - 3600, value: .1 }, { timestamp: now, value: .2 }];
    const metrics = { source: "prometheus", provider: "demo", rangeHours: 1, stepSeconds: 60, series: { cpu: [{ id: "cpu", label: "checkout", unit: "cores", points }], memory: [], network: [], filesystem: [] } };
    function Harness() {
      const [active, setActive] = React.useState("cpu");
      const [range, setRange] = React.useState(1);
      return React.createElement(PodMetricsSection, { metrics, active, range, onMetric: setActive, onRange: setRange });
    }
    ReactDOM.createRoot(host).render(React.createElement(Harness));
    ReactDOM.createRoot(loadingHost).render(React.createElement(PodMetricsSection, { active: "cpu", range: 1, loading: true, onMetric: () => {}, onRange: () => {} }));
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  const metricsInitial = await metricsPage.evaluate(() => {
    const sections = document.querySelectorAll(".detail-metrics-section");
    const tabs = [...sections[0].querySelectorAll('.detail-metric-tabs [role="tab"]')];
    return {
      sectionHeight: sections[0].getBoundingClientRect().height,
      chartHeight: sections[0].querySelector(".detail-metrics-chart").getBoundingClientRect().height,
      loadingChartHeight: sections[1].querySelector(".detail-metrics-chart").getBoundingClientRect().height,
      loadingPlaceholder: Boolean(sections[1].querySelector(".detail-chart-placeholder")),
      iconsOnly: tabs.length === 4 && tabs.every((tab) => tab.textContent.trim() === "" && tab.querySelectorAll("svg").length === 1),
    };
  });
  await metricsPage.getByRole("tab", { name: "Network" }).first().click();
  const metricsEmpty = await metricsPage.evaluate(() => {
    const section = document.querySelector(".detail-metrics-section");
    return { sectionHeight: section.getBoundingClientRect().height, chartHeight: section.querySelector(".detail-metrics-chart").getBoundingClientRect().height };
  });
  const memoryTab = metricsPage.getByRole("tab", { name: "Memory" }).first();
  await memoryTab.hover();
  await metricsPage.waitForTimeout(150);
  const metricTooltip = await memoryTab.evaluate((tab) => {
    const style = getComputedStyle(tab, "::after");
    return style.content === '"Memory"' && style.opacity === "1" && style.visibility === "visible";
  });
  await metricsPage.getByRole("button", { name: "Metrics time range" }).first().click();
  const rangeCombobox = await metricsPage.locator(".detail-metrics-range").first().evaluate((root) => {
    const trigger = root.querySelector(".combobox-trigger").getBoundingClientRect();
    const popover = root.querySelector(".combobox-popover").getBoundingClientRect();
    return {
      equalWidth: Math.abs(trigger.width - popover.width) < 1,
      options: [...root.querySelectorAll(".combobox-options button")].map((button) => button.textContent.trim()),
      noOverflow: root.querySelector(".combobox-popover").scrollWidth <= root.querySelector(".combobox-popover").clientWidth,
    };
  });
  const metricsPanel = {
    iconTabs: metricsInitial.iconsOnly,
    tooltip: metricTooltip,
    fixedChartSpace: metricsInitial.chartHeight === 196 && metricsEmpty.chartHeight === metricsInitial.chartHeight && metricsEmpty.sectionHeight === metricsInitial.sectionHeight,
    loadingPlaceholder: metricsInitial.loadingPlaceholder && metricsInitial.loadingChartHeight === metricsInitial.chartHeight,
    rangeWidth: rangeCombobox.equalWidth && rangeCombobox.noOverflow,
    ranges: rangeCombobox.options.join(",") === "1h,2h,4h,8h,24h",
  };
  await metricsPage.close();

  const result = { pod, statusData, sheetStyle, metricsPanel, ownerNavigation, servicePortStyle, configMap, secret, kindSweep: { total: resources.length, failures: sweepFailures }, runtimeErrors };
  console.log(JSON.stringify(result, null, 2));
  const valid = Object.values(pod).every(Boolean)
    && statusData
    && Object.values(sheetStyle.default).every(Boolean)
    && Object.values(sheetStyle.light).every(Boolean)
    && Object.values(sheetStyle.narrow).every(Boolean)
    && Object.values(metricsPanel).every(Boolean)
    && sheetStyle.resizeFocusVisible
    && ownerNavigation
    && servicePortStyle
    && Object.values(configMap).every(Boolean)
    && Object.values(secret).every(Boolean)
    && result.kindSweep.total >= 40
    && result.kindSweep.failures.length === 0
    && runtimeErrors.length === 0;
  await browser.close();
  if (!valid) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
