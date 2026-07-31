const { chromium } = require("playwright");

const safariUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

(async () => {
  const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://localhost:1420";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: safariUserAgent,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('[data-cluster-id="staging"]').dblclick();
    await page.getByRole("button", { name: "StatefulSets", exact: true }).click();
    await page.getByText("catalog-indexer", { exact: true }).first().click();
    await page.locator(".sheet-right").getByRole("button", { name: "Terminal", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".session-runtime-status")?.getAttribute("data-status") === "connected" && document.querySelector(".xterm-helper-textarea"));

    const terminal = page.locator(".container-terminal");
    const geometry = await terminal.evaluate((element) => ({
      columns: Number(element.getAttribute("data-columns")),
      rows: Number(element.getAttribute("data-rows")),
      hostWidth: element.getBoundingClientRect().width,
      parentWidth: element.parentElement.getBoundingClientRect().width,
    }));

    const textarea = page.locator(".xterm-helper-textarea");
    await textarea.focus();
    // Reproduce WKWebView's input-before-keyCode=229 IME commit ordering.
    await textarea.evaluate((element) => {
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true }));
      element.value = "？";
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: "？", inputType: "insertText" }));
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Process", code: "Unidentified", keyCode: 229 }));
      element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Process", code: "Unidentified", keyCode: 229 }));
    });
    await page.waitForTimeout(180);

    // Normal Chinese composition must continue through xterm's CompositionHelper.
    await textarea.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      element.value = "中文";
      element.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "中文" }));
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    });
    await page.waitForTimeout(180);

    const rows = await terminal.locator(".xterm-rows").innerText();
    const result = {
      fillsSheet: Math.abs(geometry.hostWidth - geometry.parentWidth) <= 1,
      fittedBeyondDefaultWidth: geometry.columns > 80,
      usableRows: geometry.rows >= 5,
      webKitImeCommitOnce: (rows.match(/？/g) || []).length === 1,
      chineseCompositionOnce: (rows.match(/中文/g) || []).length === 1,
      noRuntimeErrors: errors.length === 0,
    };
    console.log(JSON.stringify({ geometry, result, errors }, null, 2));
    if (!Object.values(result).every(Boolean)) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
