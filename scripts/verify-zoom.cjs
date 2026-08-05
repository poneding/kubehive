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
      // Window zoom no longer surfaces a top indicator (the content zoom widget
      // owns the readout); assert the shortcut only changes the zoom level.
      results[`windowZoomSteps.${name}`] = before === "100%" && zoomedIn === "110%" && zoomedInTwice === "120%" && zoomedOut === "110%" && reset === "100%";
      await context.close();
    }

    // --- Content zoom wheel math (locked to 5% steps, clamps) ---
    const { context, page } = await openPage(safariUserAgent);
    const math = await page.evaluate(async () => {
      const m = await import("/src/zoom.ts");
      const isStep = (f) => Math.abs(f / 0.05 - Math.round(f / 0.05)) < 1e-9;
      // A long scroll of small trackpad deltas must only ever produce exact 5%
      // multiples, advancing monotonically without jumps or in-between ratios.
      let f = 1; let rem = 0; const series = [];
      for (let i = 0; i < 60; i += 1) { const r = m.nextContentZoomFactor(f, -8, rem); f = r.factor; rem = r.remainder; series.push(f); }
      const allSteps = series.every(isStep);
      const monotonic = series.every((value, index) => index === 0 || value >= series[index - 1]);
      const advanced = f > 1;
      // Zooming back out with the remainder carried returns exactly to 100%.
      let f2 = f; let rem2 = rem;
      for (let i = 0; i < 400 && Math.round(f2 * 100) !== 100; i += 1) { const r = m.nextContentZoomFactor(f2, 8, rem2); f2 = r.factor; rem2 = r.remainder; }
      // A single huge trackpad delta is capped to a single 5% step, not a jump.
      const capped = m.nextContentZoomFactor(1, -2000, 0).factor;
      const cappedAtHighZoom = m.nextContentZoomFactor(2, -2000, 0).factor;
      // WKWebView's small integer mouse deltas and DOM line-mode deltas are
      // normalized so one physical notch is visible immediately.
      const acceptsMacWheelModifier = m.contentZoomModifierActive("macos", true, false);
      // WKWebView may expose the wheel event as ctrlKey-only; the separately
      // tracked physical Meta key must take precedence without enabling Ctrl.
      const acceptsTrackedMacCommand = m.contentZoomModifierActive("macos", false, true, true, false);
      const acceptsArmedMacCommandStream = m.contentZoomModifierActive("macos", false, true, false, false, true);
      // Continuous macOS Command scroll: later notches may arrive with zero modifier
      // flags after the first Command-marked event armed the gesture.
      const acceptsFlaglessMacCommandStream = m.contentZoomModifierActive("macos", false, false, false, false, true);
      const rejectsTrackedMacControl = !m.contentZoomModifierActive("macos", false, true, false, true, true);
      const rejectsMacCtrlWheel = !m.contentZoomModifierActive("macos", false, true);
      const acceptsWindowsWheelModifier = m.contentZoomModifierActive("windows", false, true);
      const rejectsWindowsCmdWheel = !m.contentZoomModifierActive("windows", true, false);
      const acceptsLinuxWheelModifier = m.contentZoomModifierActive("linux", false, true);
      const rejectsPlainWheel = !m.contentZoomModifierActive("linux", false, false);
      const rejectsMixedModifiers = !m.contentZoomModifierActive("macos", true, true) && !m.contentZoomModifierActive("windows", true, true);
      const webkitMouseDelta = m.normalizeContentWheelDelta(-3, 0, 900, 120);
      const lineModeDelta = m.normalizeContentWheelDelta(-3, 1, 900);
      const webkitMouseStep = m.nextContentZoomFactor(1, webkitMouseDelta, 0).factor;
      const lineModeStep = m.nextContentZoomFactor(1, lineModeDelta, 0).factor;
      // The lower clamp must never become a one-way trap.
      const recoversFromMinimum = m.nextContentZoomFactor(0.5, -2000, 0).factor;
      // Sustained scrolls (carrying the remainder, like the real app) reach and
      // clamp at the 5%-aligned min/max.
      let out = 1; let outRem = 0;
      for (let i = 0; i < 60; i += 1) { const r = m.nextContentZoomFactor(out, 500, outRem); out = r.factor; outRem = r.remainder; }
      let inMax = 1; let inRem = 0;
      for (let i = 0; i < 60; i += 1) { const r = m.nextContentZoomFactor(inMax, -500, inRem); inMax = r.factor; inRem = r.remainder; }
      // Settling any value snaps to an exact, display-clean 5% step.
      const settled = m.settleContentZoomFactor(1.134);
      const settledPct = Math.round(settled * 100);
      // Window step helper snaps to whole 10% increments and clamps.
      let up = 1; for (let i = 0; i < 40; i += 1) up = m.stepWindowZoom(up, 1);
      let down = 1; for (let i = 0; i < 40; i += 1) down = m.stepWindowZoom(down, -1);
      return { allSteps, monotonic, advanced, backTo100: Math.round(f2 * 100) === 100, capped, cappedAtHighZoom, acceptsMacWheelModifier, acceptsTrackedMacCommand, acceptsArmedMacCommandStream, acceptsFlaglessMacCommandStream, rejectsTrackedMacControl, rejectsMacCtrlWheel, acceptsWindowsWheelModifier, rejectsWindowsCmdWheel, acceptsLinuxWheelModifier, rejectsPlainWheel, rejectsMixedModifiers, webkitMouseStep, lineModeStep, recoversFromMinimum, out, inMax, settled, settledPct, settledIsStep: isStep(settled), up, down };
    });
    results.contentZoomLockedTo5Percent = math.allSteps && math.settledIsStep && math.capped === 1.05 && math.cappedAtHighZoom === 2.05;
    results.contentZoomIsolatesPlatformModifiers = math.acceptsMacWheelModifier && math.acceptsTrackedMacCommand && math.acceptsArmedMacCommandStream && math.acceptsFlaglessMacCommandStream && math.rejectsTrackedMacControl && math.rejectsMacCtrlWheel && math.acceptsWindowsWheelModifier && math.rejectsWindowsCmdWheel && math.acceptsLinuxWheelModifier && math.rejectsPlainWheel && math.rejectsMixedModifiers;
    results.contentZoomNormalizesMouseNotches = math.webkitMouseStep === 1.05 && math.lineModeStep === 1.05;
    results.contentZoomRecoversFromMinimum = math.recoversFromMinimum === 0.55;
    results.contentZoomMonotonic = math.monotonic && math.advanced;
    results.contentZoomReturnsTo100 = math.backTo100;
    results.contentZoomClampsMin = math.out === 0.5;
    results.contentZoomClampsMax = math.inMax === 2.5;
    results.contentZoomSettleCleanPercent = math.settledPct === 115 && math.settledPct % 5 === 0;
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
