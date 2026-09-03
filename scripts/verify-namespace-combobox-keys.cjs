const { chromium } = require("playwright");

// Verifies the resource namespace filter combobox (NamespaceMultiCombobox):
// - ArrowDown/ArrowUp move a highlight through "All namespaces" + the filtered
//   namespace rows and keep it inside the option list;
// - Enter commits the highlighted row (adds the namespace / clears all);
// - with a search query typed, Enter defaults to the first matching namespace;
// - Enter with an unmatched query keeps the popover open;
// - Escape closes and hands focus back to the token caret.
//
// Runs against the dev server and mounts the real component in-page, so it
// exercises the actual keyboard handlers in a plain browser.

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";
const HOST = "#ns-combobox-harness";
const NAMESPACES = ["default", "kube-system", "monitoring", "team-a", "team-b"];

function collectRuntimeErrors(page, errors) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
}

async function mountHarness(page) {
  await page.evaluate(async (namespaces) => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { NamespaceMultiCombobox } = await import("/src/combobox.tsx");
    const host = document.createElement("div");
    host.id = "ns-combobox-harness";
    host.style.cssText = "position:fixed;left:60px;top:90px;z-index:2000;width:260px;";
    document.body.append(host);
    function Harness() {
      const [values, setValues] = React.useState([]);
      return React.createElement(NamespaceMultiCombobox, { values, namespaces, language: "en", onChange: setValues });
    }
    window.__nsComboboxRoot = ReactDOM.createRoot(host);
    window.__nsComboboxRoot.render(React.createElement(Harness));
  }, NAMESPACES);
  await page.waitForSelector(`${HOST} .namespace-combobox-toggle`);
}

async function unmountHarness(page) {
  await page.evaluate(() => {
    window.__nsComboboxRoot?.unmount();
    window.__nsComboboxRoot = undefined;
    document.getElementById("ns-combobox-harness")?.remove();
  });
}

async function rowStrongLabels(page) {
  return page.$$eval(`${HOST} .combobox-options-content button strong`, (rows) => rows.map((row) => row.textContent));
}

async function highlightedLabel(page) {
  return page.$eval(`${HOST} .combobox-options-content button.keyboard-highlighted strong`, (row) => row.textContent);
}

async function chipTexts(page) {
  return page.$$eval(`${HOST} .namespace-chip em`, (chips) => chips.map((chip) => chip.textContent));
}

async function rowCheckHidden(page, label) {
  return page.$$eval(`${HOST} .combobox-options-content button`, (rows, name) => {
    const row = rows.find((button) => button.querySelector("strong")?.textContent === name);
    return row ? row.querySelector(".combobox-option-check")?.classList.contains("invisible") : null;
  }, label);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  collectRuntimeErrors(page, errors);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("kubehive.preferences", JSON.stringify({ language: "en", theme: "dark" })));
  await page.reload({ waitUntil: "networkidle" });
  await mountHarness(page);

  const failures = [];
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures.push(name);
  };

  // --- S1: search query + Enter defaults to the first matching namespace ---
  await page.click(`${HOST} .namespace-combobox-toggle`);
  await page.waitForSelector(`${HOST} .combobox-popover`);
  await page.click(`${HOST} .combobox-search input`);
  await page.type(`${HOST} .combobox-search input`, "team", { delay: 5 });
  await page.waitForFunction((host) => {
    const rows = [...document.querySelectorAll(`${host} .combobox-options-content button strong`)];
    return rows.length === 3 && rows[1]?.textContent === "team-a" && rows[2]?.textContent === "team-b";
  }, HOST);
  check("search filters options", true);
  const searchHighlight = await highlightedLabel(page);
  check("typing highlights the first matching namespace", searchHighlight === "team-a", `highlighted ${searchHighlight}`);
  await page.screenshot({ path: "artifacts/namespace-combobox-search-highlight.png" });
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${HOST} .combobox-popover`, { state: "detached" });
  let chips = await chipTexts(page);
  check("Enter with query selects the first matching namespace", JSON.stringify(chips) === JSON.stringify(["team-a"]), chips.join(","));
  const focusOnCaret = await page.evaluate(() => document.activeElement?.classList.contains("namespace-token-input"));
  check("focus returns to the token caret after commit", focusOnCaret === true);

  // --- S2: Enter with an unmatched query keeps the popover open; Escape closes ---
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${HOST} .combobox-popover`);
  await page.click(`${HOST} .combobox-search input`);
  await page.type(`${HOST} .combobox-search input`, "zzz", { delay: 5 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(80);
  const stillOpenAfterUnmatched = await page.isVisible(`${HOST} .combobox-popover`);
  const noOptionsShown = await page.isVisible(`${HOST} .combobox-options-content p`);
  check("Enter with an unmatched query keeps the popover open", stillOpenAfterUnmatched && noOptionsShown);
  await page.keyboard.press("Escape");
  await page.waitForSelector(`${HOST} .combobox-popover`, { state: "detached" });
  chips = await chipTexts(page);
  check("Escape keeps the selection", JSON.stringify(chips) === JSON.stringify(["team-a"]), chips.join(","));

  // --- S3: ArrowDown moves the highlight; Enter adds the row ---
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${HOST} .combobox-popover`);
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction((host) => [...document.querySelectorAll(`${host} .combobox-options-content button.keyboard-highlighted strong`)][0]?.textContent === "All namespaces", HOST);
  check("first ArrowDown highlights 'All namespaces'", true);
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction((host) => [...document.querySelectorAll(`${host} .combobox-options-content button.keyboard-highlighted strong`)][0]?.textContent === "default", HOST);
  check("second ArrowDown highlights the first namespace row", true);
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${HOST} .combobox-popover`, { state: "detached" });
  chips = await chipTexts(page);
  check("Enter adds the highlighted namespace", JSON.stringify(chips) === JSON.stringify(["team-a", "default"]), chips.join(","));

  // --- S4: ArrowUp from rest goes to the last row; Enter on an already picked row is a no-op ---
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${HOST} .combobox-popover`);
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction((host) => [...document.querySelectorAll(`${host} .combobox-options-content button.keyboard-highlighted strong`)][0]?.textContent === "team-b", HOST);
  check("ArrowUp from rest highlights the last namespace row", true);
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction((host) => [...document.querySelectorAll(`${host} .combobox-options-content button.keyboard-highlighted strong`)][0]?.textContent === "team-a", HOST);
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${HOST} .combobox-popover`, { state: "detached" });
  chips = await chipTexts(page);
  const teamACount = chips.filter((chip) => chip === "team-a").length;
  check("Enter on an already-picked row does not duplicate it", JSON.stringify(chips) === JSON.stringify(["team-a", "default"]) && teamACount === 1, chips.join(","));

  // --- S5: the highlight clamps at both ends ---
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${HOST} .combobox-popover`);
  for (let i = 0; i < 10; i += 1) await page.keyboard.press("ArrowDown");
  await page.waitForFunction((host) => [...document.querySelectorAll(`${host} .combobox-options-content button.keyboard-highlighted strong`)][0]?.textContent === "team-b", HOST);
  const highlightedCountAfterDown = await page.$$eval(`${HOST} .combobox-options-content button.keyboard-highlighted`, (rows) => rows.length);
  check("ArrowDown clamps at the last row", highlightedCountAfterDown === 1);
  for (let i = 0; i < 10; i += 1) await page.keyboard.press("ArrowUp");
  await page.waitForFunction((host) => [...document.querySelectorAll(`${host} .combobox-options-content button.keyboard-highlighted strong`)][0]?.textContent === "All namespaces", HOST);
  check("ArrowUp clamps at 'All namespaces'", true);
  await page.screenshot({ path: "artifacts/namespace-combobox-all-highlight.png" });
  await page.keyboard.press("Escape");
  await page.waitForSelector(`${HOST} .combobox-popover`, { state: "detached" });

  // --- S6: Enter with no query and no highlight commits the first row ("All namespaces") ---
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${HOST} .combobox-popover`);
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${HOST} .combobox-popover`, { state: "detached" });
  chips = await chipTexts(page);
  const showsAllLabel = await page.isVisible(`${HOST} .namespace-multi-all`);
  check("plain Enter clears back to All namespaces", chips.length === 0 && showsAllLabel);

  // --- S7: mouse clicks still toggle and keep the popover open ---
  await page.click(`${HOST} .namespace-combobox-toggle`);
  await page.waitForSelector(`${HOST} .combobox-popover`);
  await page.click(`${HOST} .combobox-options-content button:has(strong:text-is("monitoring"))`);
  await page.waitForFunction((host) => document.querySelector(`${host} .namespace-chip em`)?.textContent === "monitoring", HOST);
  const openAfterPick = await page.isVisible(`${HOST} .combobox-popover`);
  const monitoringRowCheckHidden = await rowCheckHidden(page, "monitoring");
  check("clicking a namespace adds it and keeps the popover open", openAfterPick && monitoringRowCheckHidden === false);
  await page.click(`${HOST} .combobox-options-content button:has(strong:text-is("monitoring"))`);
  await page.waitForFunction((host) => document.querySelectorAll(`${host} .namespace-chip`).length === 0, HOST);
  const monitoringRowCheckHiddenAfter = await rowCheckHidden(page, "monitoring");
  check("clicking a picked namespace removes it", monitoringRowCheckHiddenAfter === true);
  await page.keyboard.press("Escape");
  await page.waitForSelector(`${HOST} .combobox-popover`, { state: "detached" });

  await unmountHarness(page);
  await browser.close();

  const passed = failures.length === 0 && errors.length === 0;
  console.log(`\n${passed ? "PASS" : "FAIL"} namespace combobox keyboard checks${errors.length ? `\nruntime errors:\n${errors.join("\n")}` : ""}`);
  if (!passed) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
