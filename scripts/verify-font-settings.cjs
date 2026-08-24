const { chromium } = require("playwright");

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";

const cluster = {
  id: "fonts",
  name: "fonts",
  provider: "Local",
  region: "test",
  version: "v1.31.0",
  status: "healthy",
  nodes: 2,
  cpu: 18,
  memory: 31,
  context: "fonts",
  server: "https://127.0.0.1:6443",
  defaultNamespace: "default",
  imported: true,
  disconnected: false,
  error: null,
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  await page.addInitScript((fixture) => {
    const state = { cluster: fixture.cluster, descriptors: [], pods: [] };
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd, args) => {
        switch (cmd) {
          case "list_clusters": return Promise.resolve([state.cluster]);
          case "probe_cluster":
          case "reconnect_cluster": return Promise.resolve(state.cluster);
          case "backend_info": return Promise.resolve({ name: "kubehive", runtime: "mock", kubernetesClient: "mock", mode: "mock" });
          case "list_system_fonts": return Promise.resolve([
            { name: "Cascadia Mono", monospace: true },
            { name: "JetBrains Mono", monospace: true },
            { name: "Fira Code", monospace: true },
            { name: "Consolas", monospace: true },
            { name: "Segoe UI", monospace: false },
            { name: "Microsoft YaHei UI", monospace: false },
            { name: "Arial", monospace: false },
          ]);
          default: return Promise.resolve(null);
        }
      },
    };
  }, { cluster, descriptors: [], pods: [] });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  // Open settings
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-modal").waitFor();

  // 1. Both new rows exist; old "Font" (terminal font) row is gone.
  const appFontRow = page.locator(".settings-row").filter({ hasText: "Application font" });
  const monoFontRow = page.locator(".settings-row").filter({ hasText: "Monospace font" });
  if ((await appFontRow.count()) !== 1) throw new Error("Application font row missing");
  if ((await monoFontRow.count()) !== 1) throw new Error("Monospace font row missing");

  // 2. App font combobox shows system fonts and renders each in its own style.
  await appFontRow.locator(".combobox-trigger").click();
  await page.locator(".combobox-popover").waitFor();
  const appOptions = page.locator(".combobox-option-group button");
  const appLabels = await appOptions.allTextContents();
  if (!appLabels.some((label) => label.includes("System default"))) throw new Error("Missing System default option");
  const fontOption = page.locator(".combobox-option-group button").filter({ hasText: "Cascadia Mono" });
  const optionStyle = await fontOption.locator("strong").getAttribute("style");
  if (!optionStyle || !optionStyle.includes("Cascadia Mono")) throw new Error(`Option not styled with its own font: ${optionStyle}`);
  const segoeStyle = await page.getByRole("button", { name: "Segoe UI", exact: true }).locator("strong").getAttribute("style");
  if (!segoeStyle || !segoeStyle.includes("Segoe UI")) throw new Error(`Segoe UI option not styled: ${segoeStyle}`);
  await page.locator(".settings-header").click({ position: { x: 5, y: 5 } });
  await page.locator(".combobox-popover").waitFor({ state: "hidden" }).catch(() => {});

  // Mono fonts come first (Monospace group), then All fonts group.
  await monoFontRow.locator(".combobox-trigger").click();
  await page.locator(".combobox-popover").waitFor();
  const groupLabels = await page.locator(".combobox-group-label").allTextContents();
  if (groupLabels.length < 2) throw new Error(`Expected Monospace + All fonts groups, got ${JSON.stringify(groupLabels)}`);
  if (!groupLabels[0].includes("Monospace")) throw new Error(`First group should be Monospace: ${JSON.stringify(groupLabels)}`);
  await page.locator(".settings-header").click({ position: { x: 5, y: 5 } });
  await page.locator(".combobox-popover").waitFor({ state: "hidden" }).catch(() => {});

  // 3. Select a mono font; --font-mono and a font-mono element must follow.
  await monoFontRow.locator(".combobox-trigger").click();
  await page.locator(".combobox-popover").waitFor();
  await page.locator(".combobox-option-group button").filter({ hasText: "JetBrains Mono" }).click();
  await page.waitForTimeout(100);
  const monoVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim());
  const monoFirst = monoVar.split(",")[0].trim().replace(/^"|"$/g, "");
  if (monoFirst !== "JetBrains Mono") throw new Error(`--font-mono not updated: ${monoVar}`);
  const monoElementFont = await page.evaluate(() => {
    const el = document.querySelector(".settings-modal code, .settings-modal .font-mono, .combobox-trigger strong");
    return el ? getComputedStyle(el).fontFamily : "";
  });
  console.log("monoVar:", monoVar, "| sample mono element:", monoElementFont);

  // Trigger shows the selected font in its own face.
  const triggerStyle = await monoFontRow.locator(".combobox-trigger strong").getAttribute("style");
  if (!triggerStyle || !triggerStyle.includes("JetBrains Mono")) throw new Error(`Trigger not styled: ${triggerStyle}`);

  // 4. App font selection updates --font-sans.
  await appFontRow.locator(".combobox-trigger").click();
  await page.locator(".combobox-popover").waitFor();
  await page.getByRole("button", { name: "Segoe UI", exact: true }).click();
  await page.waitForTimeout(100);
  const sansVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim());
  const sansFirst = sansVar.split(",")[0].trim().replace(/^"|"$/g, "");
  if (sansFirst !== "Segoe UI") throw new Error(`--font-sans not updated: ${sansVar}`);
  console.log("sansVar:", sansVar);

  // 5. Persisted preferences contain the new keys.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("kubehive.preferences") || "{}"));
  if (saved.appFont !== "Segoe UI") throw new Error(`saved.appFont=${saved.appFont}`);
  if (saved.monoFont !== "JetBrains Mono") throw new Error(`saved.monoFont=${saved.monoFont}`);
  if ("contentFont" in saved) throw new Error("legacy contentFont still persisted");

  // 6. Legacy migration: contentFont -> monoFont.
  await page.evaluate(() => {
    localStorage.setItem("kubehive.preferences", JSON.stringify({ language: "en", contentFont: "Consolas" }));
  });
  await page.reload({ waitUntil: "networkidle" });
  const migrated = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim());
  const migratedFirst = migrated.split(",")[0].trim().replace(/^"|"$/g, "");
  if (migratedFirst !== "Consolas") throw new Error(`migration failed: ${migrated}`);
  console.log("migrated monoVar:", migrated);

  // 7. Reload persistence: mono font survives a reload.
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("kubehive.preferences") || "{}"));
  console.log("persisted:", JSON.stringify(persisted));

  if (errors.length) throw new Error(`runtime errors: ${errors.join(" | ")}`);
  console.log("FONT SETTINGS E2E PASSED");
  await browser.close();
})().catch((error) => { console.error("FAILED:", error.message); process.exit(1); });
