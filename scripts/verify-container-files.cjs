const { chromium } = require("playwright");

(async () => {
  const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://localhost:1420";
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("kubehive.preferences", JSON.stringify({ theme: "dark", contentTheme: "light" }));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('[data-cluster-id="prod-eu"]').dblclick();
  await page.locator('.resource-nav nav button[aria-label="Pods"]').click();

  const podRow = page.locator(".resource-table tbody tr").filter({ hasText: "payment-worker-779d6bfcd-a2rnl" });
  await podRow.waitFor();
  await podRow.click({ button: "right" });
  const fileMenuItem = page.getByText("Container files", { exact: true });
  const contextEntry = await fileMenuItem.isVisible();
  await fileMenuItem.click();
  await page.locator(".file-list tbody tr").first().waitFor();

  const sheetBottom = await page.locator(".sheet-bottom .container-file-explorer").isVisible();
  const tabTitle = (await page.locator(".bottom-session-tabs > button.active").textContent()).trim();
  const listCount = await page.locator(".file-list tbody tr").count();
  const targetRemoved = await page.locator(".file-target-summary").count() === 0;
  const toolbarMerged = await page.locator(".file-explorer-toolbar").count() === 1 && await page.locator(".session-action-bar").count() === 0 && await page.locator(".file-explorer-actions").count() === 0 && await page.locator(".file-path-input").count() === 0;
  const fileSessionControlsMerged = await page.locator(".file-explorer-toolbar .file-explorer-session-controls").count() === 1 && await page.locator(".file-explorer-toolbar .file-session-action-divider").count() === 1 && await page.locator(".file-explorer-session-targets-inline").evaluate((element) => getComputedStyle(element).display === "flex");
  const appThemeOwnsExplorer = await page.locator(".container-file-explorer").evaluate((element) => element.classList.contains("file-theme-dark"));
  const actionButtonsAreIconOnly = await page.locator('.file-explorer-toolbar .ui-button').evaluateAll((buttons) => buttons.length >= 7 && buttons.every((button) => !button.textContent.trim() && button.querySelector("svg")));
  const initialWorkDir = (await page.locator(".file-breadcrumbs").textContent()).includes("workspace");
  const rootShortcutRemoved = await page.getByRole("button", { name: "Container filesystem root" }).count() === 0;
  const breadcrumbFormat = await page.locator(".file-breadcrumbs").evaluate((element) => {
    const root = element.querySelector('button[aria-label="Filesystem root"]');
    const separators = [...element.querySelectorAll("span > i")];
    const style = getComputedStyle(element);
    return style.borderWidth === "1px" && root?.textContent?.trim() === "" && separators.length === 1 && separators.every((separator) => separator.textContent === "/");
  });
  const homeButton = page.getByRole("button", { name: "Home directory" });
  const homeUsesHouseIcon = await homeButton.locator("svg.lucide-house").count() === 1;
  const toolbarOrdering = await page.locator(".file-explorer-toolbar").evaluate((toolbar) => {
    const search = toolbar.querySelector(".file-search");
    const upload = toolbar.querySelector('button[aria-label="Upload files"]');
    const tabs = toolbar.querySelector(".file-view-switch");
    if (!search || !upload || !tabs) return false;
    const toolbarBounds = toolbar.getBoundingClientRect();
    return search.getBoundingClientRect().left < upload.getBoundingClientRect().left && tabs.getBoundingClientRect().right >= toolbarBounds.right - 10;
  });
  await homeButton.click();
  const homeRouteWorks = (await page.locator(".file-breadcrumbs").textContent()).includes("/home/app");
  await page.getByRole("button", { name: "Working directory" }).click();

  await page.getByRole("button", { name: "Grid view" }).click();
  const gridCount = await page.locator(".file-grid-item").count();
  await page.locator(".file-grid-item").nth(0).click();
  await page.locator(".file-grid-item").nth(1).click();
  const gridMultiSelect = await page.locator(".file-grid-item.selected").count() === 2;
  const bulkActionsInline = await page.locator(".file-explorer-toolbar .file-bulk-actions").count() === 1 && await page.locator(".container-file-explorer > .file-bulk-actions").count() === 0;
  const bulkActionsOnRight = await page.locator(".file-explorer-toolbar").evaluate((toolbar) => {
    const bulk = toolbar.querySelector(".file-bulk-actions");
    const tabs = toolbar.querySelector(".file-view-switch");
    if (!bulk || !tabs) return false;
    return bulk.getBoundingClientRect().left < tabs.getBoundingClientRect().left && tabs.getBoundingClientRect().right >= toolbar.getBoundingClientRect().right - 10;
  });
  await page.getByRole("button", { name: "Clear selection" }).click();
  await page.getByRole("button", { name: "List view" }).click();
  await page.locator(".file-list tbody tr").filter({ hasText: "static" }).dblclick();

  await page.getByRole("button", { name: "New folder" }).click();
  const dialog = page.locator(".file-operation-dialog");
  await dialog.locator("input").fill("uploads");
  await dialog.getByRole("button", { name: "Create folder" }).click();
  const uploadsFolder = page.locator(".file-list tbody tr").filter({ hasText: "uploads" });
  await uploadsFolder.waitFor();

  await uploadsFolder.click({ button: "right" });
  const folderMenuHasIcons = await page.locator(".app-context-menu [role=menuitem]").evaluateAll((items) => items.slice(0, 6).every((item) => item.querySelector("svg")));
  const archiveDownload = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download as .tar.gz", exact: true }).click();
  const archiveName = (await archiveDownload).suggestedFilename();

  await page.getByRole("button", { name: "New file" }).click();
  await dialog.locator("input").fill("notes.txt");
  await dialog.getByRole("button", { name: "Create file" }).click();
  const editor = page.locator(".file-text-editor textarea");
  await editor.fill("hello from explorer\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Back to files" }).click();
  await page.locator(".file-list tbody tr").filter({ hasText: "notes.txt" }).dblclick();
  const savedText = await editor.inputValue();
  const editorUsesPencil = await page.locator(".file-text-editor > header svg").count() > 0;
  await page.getByRole("button", { name: "Back to files" }).click();

  const note = page.locator(".file-list tbody tr").filter({ hasText: "notes.txt" });
  await note.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename...", exact: true }).click();
  await dialog.locator("input").fill("readme.txt");
  await dialog.getByRole("button", { name: "Rename" }).click();
  const readme = page.locator(".file-list tbody tr").filter({ hasText: "readme.txt" });
  await readme.waitFor();
  const renameMenuUsesPenLine = await (await readme.click({ button: "right" }), page.getByRole("menuitem", { name: "Rename...", exact: true }).locator("svg").count()) === 1;
  await page.mouse.click(10, 200);
  await readme.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const singleDeleteDialog = await page.locator(".file-delete-dialog").isVisible();
  await page.locator(".file-delete-dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await readme.waitFor({ state: "detached" });
  const deletedSingle = await readme.count() === 0;
  await page.getByRole("button", { name: "Back to parent folder" }).click();
  await page.getByRole("checkbox", { name: "Select all files" }).check();
  await page.getByRole("checkbox", { name: "Select all files" }).uncheck();

  const batchNames = ["config.json", "server.log"];
  for (const name of batchNames) {
    await page.locator(".file-list tbody tr").filter({ hasText: name }).locator(`input[aria-label="Select ${name}"]`).check();
  }
  const batchCount = await page.locator(".file-bulk-actions strong").textContent();
  const batchButtons = await page.locator(".file-bulk-actions button").count();
  const batchArchive = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download selected items" }).click();
  const batchArchiveName = (await batchArchive).suggestedFilename();

  await page.getByRole("button", { name: "Copy selected items" }).click();
  await dialog.locator("input").fill("/tmp");
  await dialog.getByRole("button", { name: "Copy to path" }).click();
  await page.locator(".file-breadcrumbs").getByRole("button", { name: "Filesystem root", exact: true }).click();
  await page.locator(".file-list tbody tr").filter({ hasText: "tmp" }).dblclick();
  for (const name of batchNames) await page.locator(".file-list tbody tr").filter({ hasText: name }).locator(`input[aria-label="Select ${name}"]`).check();
  await page.getByRole("button", { name: "Move selected items" }).click();
  await dialog.locator("input").fill("/workspace");
  await dialog.getByRole("button", { name: "Move to path" }).click();
  await page.getByRole("button", { name: "Working directory" }).click();
  const movedBatchVisible = await Promise.all(batchNames.map((name) => page.locator(`.file-list tbody tr`).filter({ hasText: name }).count())).then((counts) => counts.every((count) => count === 1));
  for (const name of batchNames) await page.locator(".file-list tbody tr").filter({ hasText: name }).locator(`input[aria-label="Select ${name}"]`).check();
  await page.getByRole("button", { name: "Delete selected items" }).click();
  const batchDeleteDialog = await page.locator(".file-delete-dialog").isVisible();
  await page.locator(".file-delete-dialog").getByRole("button", { name: "Delete", exact: true }).click();
  const deletedBatch = await Promise.all(batchNames.map((name) => page.locator(".file-list tbody tr").filter({ hasText: name }).count())).then((counts) => counts.every((count) => count === 0));

  await page.locator('.container-file-explorer input[type="file"]').setInputFiles({
    name: "upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded through Explorer\n"),
  });
  await page.locator(".file-list tbody tr").filter({ hasText: "upload.txt" }).waitFor();

  await page.evaluate(() => { Promise.resolve = () => Promise.reject(new Error("container test service unavailable")); });
  await page.locator(".file-explorer-session-targets-inline .container-target-combobox .combobox-trigger").click();
  await page.locator(".combobox-popover").getByText("sidecar", { exact: true }).click();
  await page.getByText("Container files are unavailable", { exact: true }).waitFor();
  const staleContainerFilesHidden = await page.locator(".file-list, .file-grid, .file-bulk-actions").count() === 0
    && await page.locator(".file-explorer-state").filter({ hasText: "container test service unavailable" }).count() === 1;

  const lightPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  lightPage.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`light console: ${message.text()}`); });
  lightPage.on("pageerror", (error) => runtimeErrors.push(`light page: ${error.message}`));
  await lightPage.goto(baseUrl, { waitUntil: "networkidle" });
  await lightPage.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("kubehive.preferences", JSON.stringify({ theme: "light", contentTheme: "dark" }));
  });
  await lightPage.reload({ waitUntil: "networkidle" });
  await lightPage.locator('[data-cluster-id="prod-eu"]').dblclick();
  await lightPage.locator('.resource-nav nav button[aria-label="Pods"]').click();
  await lightPage.locator(".resource-table tbody tr").filter({ hasText: "payment-worker-779d6bfcd-a2rnl" }).click({ button: "right" });
  await lightPage.getByText("Container files", { exact: true }).click();
  await lightPage.locator(".container-file-explorer").waitFor();
  const lightThemeWorks = await lightPage.locator(".container-file-explorer").evaluate((element) => {
    const background = getComputedStyle(element.querySelector(".file-explorer-content")).backgroundColor;
    return element.classList.contains("file-theme-light") && background === "rgb(255, 255, 255)";
  });
  await lightPage.setViewportSize({ width: 840, height: 900 });
  const targetOverflow = lightPage.getByRole("button", { name: "Show Pod and Container selectors", exact: true });
  await targetOverflow.hover();
  const targetPanel = lightPage.locator(".file-explorer-session-targets-panel");
  const compactTargetControls = await lightPage.locator(".file-explorer-session-targets-inline").evaluate((element) => getComputedStyle(element).display === "none")
    && await targetOverflow.isVisible()
    && await targetPanel.evaluate((element) => getComputedStyle(element).display === "flex")
    && await targetPanel.locator(".container-target-combobox").count() === 1;
  await targetPanel.getByRole("button", { name: "Container", exact: true }).click();
  await targetPanel.getByText("sidecar", { exact: true }).click();
  const compactContainerSelectorWorks = await targetPanel.locator(".container-target-combobox .combobox-trigger strong").textContent() === "sidecar";
  await lightPage.close();

  await page.screenshot({ path: "artifacts/container-file-explorer.png", fullPage: true });
  const result = {
    contextEntry,
    sheetBottom,
    tabTitle,
    targetRemoved,
    toolbarMerged,
    fileSessionControlsMerged,
    appThemeOwnsExplorer,
    lightThemeWorks,
    compactTargetControls,
    compactContainerSelectorWorks,
    actionButtonsAreIconOnly,
    initialWorkDir,
    rootShortcutRemoved,
    breadcrumbFormat,
    homeUsesHouseIcon,
    toolbarOrdering,
    homeRouteWorks,
    gridMultiSelect,
    bulkActionsInline,
    bulkActionsOnRight,
    folderMenuHasIcons,
    listCount,
    gridCount,
    archiveName,
    savedText,
    editorUsesPencil,
    renameMenuUsesPenLine,
    singleDeleteDialog,
    deletedSingle,
    batchDeleteDialog,
    batchCount,
    batchButtons,
    batchArchiveName,
    movedBatchVisible,
    deletedBatch,
    uploadVisible: true,
    staleContainerFilesHidden,
    runtimeErrors,
  };
  console.log(JSON.stringify(result, null, 2));

  const valid = contextEntry && sheetBottom && tabTitle.includes("Files ·") && targetRemoved && toolbarMerged && fileSessionControlsMerged
    && appThemeOwnsExplorer && lightThemeWorks && compactTargetControls && compactContainerSelectorWorks && actionButtonsAreIconOnly && initialWorkDir && rootShortcutRemoved
    && breadcrumbFormat && homeUsesHouseIcon && toolbarOrdering && homeRouteWorks && gridMultiSelect && bulkActionsInline && bulkActionsOnRight && folderMenuHasIcons && listCount === 3 && gridCount === 3
    && archiveName === "uploads.tar.gz" && savedText === "hello from explorer\n" && editorUsesPencil && renameMenuUsesPenLine
    && singleDeleteDialog && deletedSingle && batchDeleteDialog && batchCount === "2" && batchButtons === 5 && batchArchiveName === "container-files.tar.gz"
    && movedBatchVisible && deletedBatch && staleContainerFilesHidden && runtimeErrors.length === 0;
  await browser.close();
  if (!valid) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
