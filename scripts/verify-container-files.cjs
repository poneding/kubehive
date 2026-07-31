const { chromium } = require("playwright");

(async () => {
  const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://localhost:1420";
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('[data-cluster-id="prod-eu"]').dblclick();
  await page.locator('.resource-nav nav button[aria-label="Pods"]').click();

  const podRow = page.locator(".resource-table tbody tr").first();
  await podRow.waitFor();
  await podRow.click({ button: "right" });
  const fileMenuItem = page.getByText("Container files", { exact: true });
  const contextEntry = await fileMenuItem.isVisible();
  await fileMenuItem.click();
  await page.locator(".file-list tbody tr").first().waitFor();

  const sheetBottom = await page.locator(".sheet-bottom .container-file-explorer").isVisible();
  const tabTitle = (await page.locator(".bottom-session-tabs > button.active").textContent()).trim();
  const listCount = await page.locator(".file-list tbody tr").count();
  const targetVisible = await page.locator(".file-target-summary").isVisible();

  await page.getByRole("button", { name: "Grid view" }).click();
  const gridCount = await page.locator(".file-grid-item").count();
  await page.getByRole("button", { name: "List view" }).click();
  await page.locator(".file-list tbody tr").filter({ hasText: "app" }).dblclick();

  await page.getByRole("button", { name: "New folder" }).click();
  const dialog = page.locator(".file-operation-dialog");
  await dialog.locator("input").fill("uploads");
  await dialog.getByRole("button", { name: "Create folder" }).click();
  const uploadsFolder = page.locator(".file-list tbody tr").filter({ hasText: "uploads" });
  await uploadsFolder.waitFor();
  await uploadsFolder.click();
  const archiveDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download selected" }).click();
  const archiveName = (await archiveDownload).suggestedFilename();

  await page.getByRole("button", { name: "New file" }).click();
  await dialog.locator("input").fill("notes.txt");
  await dialog.getByRole("button", { name: "Create file" }).click();
  const editor = page.locator(".file-text-editor textarea");
  await editor.fill("hello from explorer\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Back to file list" }).click();
  await page.locator(".file-list tbody tr").filter({ hasText: "notes.txt" }).dblclick();
  const savedText = await editor.inputValue();
  await page.getByRole("button", { name: "Back to file list" }).click();

  const note = page.locator(".file-list tbody tr").filter({ hasText: "notes.txt" });
  await note.click();
  await page.getByRole("button", { name: "Rename selected" }).click();
  await dialog.locator("input").fill("readme.txt");
  await dialog.getByRole("button", { name: "Rename" }).click();
  const readme = page.locator(".file-list tbody tr").filter({ hasText: "readme.txt" });
  await readme.waitFor();

  await readme.click();
  await page.getByRole("button", { name: "Copy selected" }).click();
  await dialog.locator("input").fill("/tmp/copied.txt");
  await dialog.getByRole("button", { name: "Copy to path" }).click();
  const pathInput = page.locator(".file-path-input input");
  await pathInput.fill("/tmp");
  await page.locator(".file-path-input").getByRole("button", { name: "Go" }).click();
  const copied = page.locator(".file-list tbody tr").filter({ hasText: "copied.txt" });
  await copied.waitFor();

  await copied.click();
  await page.getByRole("button", { name: "Move selected" }).click();
  await dialog.locator("input").fill("/app/moved.txt");
  await dialog.getByRole("button", { name: "Move to path" }).click();
  await pathInput.fill("/app");
  await page.locator(".file-path-input").getByRole("button", { name: "Go" }).click();
  const moved = page.locator(".file-list tbody tr").filter({ hasText: "moved.txt" });
  await moved.waitFor();
  page.once("dialog", (prompt) => prompt.accept());
  await moved.click();
  await page.getByRole("button", { name: "Delete selected" }).click();
  await moved.waitFor({ state: "detached" });

  await page.locator('.container-file-explorer input[type="file"]').setInputFiles({
    name: "upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded through Explorer\n"),
  });
  await page.locator(".file-list tbody tr").filter({ hasText: "upload.txt" }).waitFor();
  const uploadVisible = true;

  await page.screenshot({ path: "artifacts/container-file-explorer.png", fullPage: true });
  const result = {
    contextEntry,
    sheetBottom,
    tabTitle,
    targetVisible,
    listCount,
    gridCount,
    archiveName,
    savedText,
    createdFolder: true,
    createdFile: true,
    renamed: true,
    copied: true,
    moved: true,
    deleted: true,
    uploadVisible,
    runtimeErrors,
  };
  console.log(JSON.stringify(result, null, 2));

  const valid = contextEntry && sheetBottom && tabTitle.includes("Files ·") && targetVisible
    && listCount === 3 && gridCount === 3 && archiveName === "uploads.tar.gz"
    && savedText === "hello from explorer\n" && uploadVisible && runtimeErrors.length === 0;
  await browser.close();
  if (!valid) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
