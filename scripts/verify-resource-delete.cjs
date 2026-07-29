const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));

  await page.goto("http://localhost:1420", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('[data-cluster-id="prod-eu"]').dblclick();
  await page.locator('.resource-nav nav button[aria-label="Pods"]').click();
  await page.locator(".resource-table tbody tr[data-index]").first().waitFor();

  const firstRow = page.locator(".resource-table tbody tr[data-index]").first();
  const podName = (await firstRow.locator(".resource-name strong").textContent()).trim();
  await firstRow.click({ button: "right" });
  await page.locator(".app-context-menu").getByRole("menuitem", { name: "Delete", exact: true }).click();

  const dialog = page.locator(".resource-delete-dialog");
  await dialog.waitFor();
  const contextMenuDialog = await dialog.evaluate((element, expectedName) => {
    const header = element.querySelector(":scope > header");
    const footer = element.querySelector(":scope > footer");
    return {
      title: header.querySelector("h2")?.textContent === "Delete resource",
      target: element.querySelector(".resource-delete-target strong")?.textContent === expectedName,
      warning: element.textContent.includes("cannot be undone") || element.textContent.includes("replacement Pod"),
      headerHeight: Math.round(header.getBoundingClientRect().height),
      footerHeight: Math.round(footer.getBoundingClientRect().height),
      modalSemantics: element.getAttribute("role") === "dialog" && element.getAttribute("aria-modal") === "true",
      cancelFocused: element.querySelector("footer button:focus")?.textContent.trim() === "Cancel",
    };
  }, podName);

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });

  await firstRow.locator("td:not(.selection-col)").first().click();
  const detail = page.locator(".sheet-right");
  await detail.waitFor();
  await detail.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.waitFor();
  const detailDeleteOpened = await dialog.getByText(podName, { exact: true }).isVisible();

  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  const browserFallbackVisible = await dialog.getByRole("alert").getByText("Resource deletion is available in the native KubeHive application.", { exact: true }).isVisible();
  const dialogStayedOpenOnError = await dialog.isVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  const results = {
    contextMenuDialog,
    detailDeleteOpened,
    browserFallbackVisible,
    dialogStayedOpenOnError,
    runtimeErrors,
  };
  console.log(JSON.stringify(results, null, 2));

  const passed = contextMenuDialog.title
    && contextMenuDialog.target
    && contextMenuDialog.warning
    && contextMenuDialog.headerHeight === 48
    && contextMenuDialog.footerHeight === 52
    && contextMenuDialog.modalSemantics
    && contextMenuDialog.cancelFocused
    && detailDeleteOpened
    && browserFallbackVisible
    && dialogStayedOpenOnError
    && runtimeErrors.length === 0;

  await browser.close();
  if (!passed) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
