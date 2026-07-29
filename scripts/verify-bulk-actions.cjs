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

  const table = page.locator(".resource-table-wrap.virtualized");
  await table.locator("tbody tr[data-index]").first().waitFor();
  const rows = table.locator("tbody tr[data-index]");
  const firstTwo = rows.locator(".resource-selection-checkbox");
  await firstTwo.nth(0).check();
  await firstTwo.nth(1).check();

  const bulkBar = page.locator(".bulk-resource-actions");
  const twoSelected = await bulkBar.getByText("2 selected", { exact: true }).isVisible();
  const podActions = {
    evict: await bulkBar.getByRole("button", { name: "Evict", exact: true }).isVisible(),
    delete: await bulkBar.getByRole("button", { name: "Delete", exact: true }).isVisible(),
    checkboxDidNotOpenDetails: await page.locator(".sheet-right").count() === 0,
  };

  await bulkBar.getByRole("button", { name: "Evict", exact: true }).click();
  const dialog = page.locator(".bulk-resource-dialog");
  await dialog.waitFor();
  const evictionDialog = await dialog.evaluate((element) => ({
    title: element.querySelector("h2")?.textContent === "Evict selected Pods",
    count: element.textContent.includes("2 resources selected"),
    pdb: element.textContent.includes("PodDisruptionBudget"),
    policy: element.textContent.includes("policy/v1 Eviction"),
  }));
  await dialog.getByRole("button", { name: "Evict Pods", exact: true }).click();
  const browserFallback = await dialog.getByRole("alert").getByText("Bulk resource operations are available in the native KubeHive application.", { exact: true }).isVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await bulkBar.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.waitFor();
  const deleteDialog = await dialog.evaluate((element) => ({
    title: element.querySelector("h2")?.textContent === "Delete selected resources",
    count: element.textContent.includes("2 resources selected"),
    bounded: element.textContent.includes("bounded concurrency"),
  }));
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  const total = Number(await table.getAttribute("data-row-count"));
  await page.getByRole("checkbox", { name: "Select all visible resources", exact: true }).check();
  const selectAll = await bulkBar.getByText(`${total} selected`, { exact: true }).isVisible();
  await bulkBar.getByRole("button", { name: "Clear resource selection", exact: true }).click();
  const cleared = await page.locator(".bulk-resource-actions").count() === 0
    && !await page.getByRole("checkbox", { name: "Select all visible resources", exact: true }).isChecked();

  await page.locator('.resource-nav nav button[aria-label="Deployments"]').click();
  const deploymentTable = page.locator(".resource-table-wrap.virtualized");
  await deploymentTable.locator("tbody tr[data-index]").first().waitFor();
  await deploymentTable.locator("tbody tr[data-index] .resource-selection-checkbox").first().check();
  const deploymentBar = page.locator(".bulk-resource-actions");
  const deploymentActions = {
    delete: await deploymentBar.getByRole("button", { name: "Delete", exact: true }).isVisible(),
    noEvict: await deploymentBar.getByRole("button", { name: "Evict", exact: true }).count() === 0,
  };

  await page.locator('.resource-nav nav button[aria-label="Port Forwarding"]').click();
  await page.locator(".page-head h1").getByText("Port Forwarding", { exact: true }).waitFor();
  const pseudoResourceExcluded = await page.getByRole("checkbox", { name: "Select all visible resources", exact: true }).count() === 0;

  const results = {
    twoSelected,
    podActions,
    evictionDialog,
    browserFallback,
    deleteDialog,
    selectAll,
    cleared,
    deploymentActions,
    pseudoResourceExcluded,
    runtimeErrors,
  };
  console.log(JSON.stringify(results, null, 2));

  const passed = twoSelected
    && Object.values(podActions).every(Boolean)
    && Object.values(evictionDialog).every(Boolean)
    && browserFallback
    && Object.values(deleteDialog).every(Boolean)
    && selectAll
    && cleared
    && Object.values(deploymentActions).every(Boolean)
    && pseudoResourceExcluded
    && runtimeErrors.length === 0;

  await browser.close();
  if (!passed) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
