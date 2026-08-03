const { chromium } = require("playwright");

const safariUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const windowsUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Verifies the session-only zoom controls in the browser prototype, where the
// window zoom falls back to scaling the root font size (rem) instead of the
// native webview zoom used inside Tauri.
(async () => {
  const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://localhost:1420";
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const results = {};

  const openPage = async (userAgent) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent });
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    return { context, page };
  };

  try {
    // --- Window zoom keyboard shortcut (Cmd on macOS, Ctrl elsewhere) ---
    for (const [name, userAgent, modifier] of [["macos", safariUserAgent, "Meta"], ["windows", windowsUserAgent, "Control"]]) {
      const { context, page } = await openPage(userAgent);
      const rootFont = () => page.evaluate(() => document.documentElement.style.fontSize || "100%");
      const press = async (key) => { await page.keyboard.press(`${modifier}+${key}`); await page.waitForTimeout(140); };
      const before = await rootFont();
      await press("=");
      const zoomedIn = await rootFont();
      await press("=");
      const zoomedInTwice = await rootFont();
      await press("-");
      const zoomedOut = await rootFont();
      await press("0");
      const reset = await rootFont();
      const indicator = await page.locator(".window-zoom-indicator").innerText().catch(() => "");
      results[`windowZoomSteps.${name}`] = before === "100%" && zoomedIn === "110%" && zoomedInTwice === "120%" && zoomedOut === "110%" && reset === "100%";
      results[`windowZoomIndicator.${name}`] = indicator.includes("100%");
      await context.close();
    }

    // --- Content zoom wheel math (smooth glide, settle snapping, clamps) ---
    const { context, page } = await openPage(safariUserAgent);
    const math = await page.evaluate(async () => {
      const m = await import("/src/zoom.ts");
      // A stream of small trackpad deltas glides continuously (monotonic, no jumps).
      let glide = 1; const series = [];
      for (let i = 0; i < 20; i += 1) { glide = m.nextContentZoomFactor(glide, -8, 0).factor; series.push(glide); }
      const monotonic = series.every((value, index) => index === 0 || value > series[index - 1]);
      // A single huge trackpad delta is capped, not a jump to max.
      const capped = m.nextContentZoomFactor(1, -2000, 0).factor;
      // Repeated zoom-out clamps at the minimum.
      let out = 1;
      for (let i = 0; i < 60; i += 1) out = m.nextContentZoomFactor(out, 500, 0).factor;
      let inMax = 1;
      for (let i = 0; i < 60; i += 1) inMax = m.nextContentZoomFactor(inMax, -500, 0).factor;
      // Settling snaps a continuous factor to a stable whole-percentage step.
      const settled = m.settleContentZoomFactor(1.134);
      // Window step helper snaps to whole 10% increments and clamps.
      let up = 1; for (let i = 0; i < 40; i += 1) up = m.stepWindowZoom(up, 1);
      let down = 1; for (let i = 0; i < 40; i += 1) down = m.stepWindowZoom(down, -1);
      return { glide, series, monotonic, capped, out, inMax, settled, up, down };
    });
    results.contentZoomGlides = math.monotonic && math.glide > 1.2 && math.glide < 1.4;
    results.contentZoomTrackpadCapped = math.capped <= 1.1;
    results.contentZoomClampsMin = math.out === 0.5;
    results.contentZoomClampsMax = math.inMax === 2.5;
    results.contentZoomSettles = math.settled === 1.15;
    results.windowZoomClampsMax = math.up === 2.5;
    results.windowZoomClampsMin = math.down === 0.5;
    await context.close();

    results.noRuntimeErrors = errors.length === 0;
    console.log(JSON.stringify({ results, errors }, null, 2));
    if (!Object.values(results).every(Boolean)) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
