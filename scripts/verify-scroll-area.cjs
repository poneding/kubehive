const fs = require("fs");
const path = require("path");
const postcss = require("postcss");
const ts = require("typescript");
const { chromium } = require("playwright");

const baseUrl = process.env.KUBEHIVE_TEST_URL || "http://127.0.0.1:1420";
const rootDir = path.resolve(__dirname, "..");
const sourceDir = path.join(rootDir, "src");

const allowedNativeScrolling = new Set([
  "container-file-explorer.css::.file-text-editor textarea::overflow:auto",
  "container-terminal.css::.container-terminal .xterm .xterm-viewport::scrollbar-width:thin",
  "container-terminal.css::.container-terminal .xterm .xterm-viewport::scrollbar-color:var(--terminal-scrollbar-thumb) var(--terminal-scrollbar-track)",
  "manifest-editor.css::.manifest-editor .cm-scroller::overflow:auto",
  "manifest-editor.css::.manifest-editor .cm-scroller::scrollbar-width:thin",
  "manifest-editor.css::.manifest-editor .cm-scroller::scrollbar-color:rgba(113, 127, 138, .52) transparent",
  "manifest-editor.css::.manifest-editor.manifest-theme-light .cm-scroller::scrollbar-color:rgba(95, 109, 120, .35) transparent",
]);

const allowedNativeScrollbarSelectors = new Set([
  "container-terminal.css::.container-terminal .xterm .xterm-viewport::-webkit-scrollbar",
  "container-terminal.css::.container-terminal .xterm .xterm-viewport::-webkit-scrollbar-thumb",
  "container-terminal.css::.container-terminal .xterm .xterm-viewport::-webkit-scrollbar-track",
  "manifest-editor.css::.manifest-editor .cm-scroller::-webkit-scrollbar",
  "manifest-editor.css::.manifest-editor .cm-scroller::-webkit-scrollbar-thumb",
  "manifest-editor.css::.manifest-editor .cm-scroller::-webkit-scrollbar-track",
  "manifest-editor.css::.manifest-editor.manifest-theme-light .cm-scroller::-webkit-scrollbar-thumb",
]);

const expectedSurfaceClasses = [
  "about-code-scroll",
  "about-scroll-area",
  "alerts-scroll-area",
  "bottom-session-tabs-scroll-area",
  "bulk-resource-list",
  "cluster-home-scroll-area",
  "cluster-list-scroll-area",
  "column-picker-list",
  "combobox-options",
  "detail-chart-legend",
  "detail-data-scroll",
  "detail-port-table-wrap",
  "drawer-body-scroll-area",
  "file-breadcrumbs",
  "file-delete-list",
  "file-explorer-scroll-area",
  "logs-scroll-area",
  "resource-nav-scroll-area",
  "resource-tree-filter-scroll-area",
  "settings-scroll-area",
  "workspace-scroll-area",
  "workspace-tab-scroll-area",
];

const hiddenScrollbarSurfaceClasses = new Set([
  "bottom-session-tabs-scroll-area",
  "workspace-tab-scroll-area",
]);

const expectedSurfaceCounts = Object.fromEntries(expectedSurfaceClasses.map((className) => [
  className,
  className === "combobox-options" ? 2 : 1,
]));
const expectedScrollAreaUsages = Object.values(expectedSurfaceCounts).reduce((total, count) => total + count, 0);

function listFiles(directory, extension) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(entryPath);
  }
  return files.sort();
}

function sourceLocation(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${path.relative(sourceDir, sourceFile.fileName)}:${position.line + 1}`;
}

function collectRuntimeErrors(page, errors) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
}

function auditNativeScrolling() {
  const declarations = [];
  const nativeScrollbarSelectors = [];
  for (const filePath of listFiles(sourceDir, ".css")) {
    const file = path.relative(sourceDir, filePath);
    const root = postcss.parse(fs.readFileSync(filePath, "utf8"), { from: file });
    root.walkRules((rule) => {
      for (const selector of rule.selectors ?? [rule.selector]) {
        const entry = `${file}::${selector}`;
        if (selector.includes("::-webkit-scrollbar") && !allowedNativeScrollbarSelectors.has(entry)) {
          nativeScrollbarSelectors.push(entry);
        }
      }
      rule.walkDecls((declaration) => {
        const nativeOverflow = /^overflow(?:-x|-y)?$/.test(declaration.prop)
          && /(?:^|\s)(auto|scroll)(?:\s|$)/.test(declaration.value);
        const nativeScrollbar = /^scrollbar-(?:width|color)$/.test(declaration.prop);
        if (nativeOverflow || nativeScrollbar) {
          declarations.push(`${file}::${rule.selector}::${declaration.prop}:${declaration.value}`);
        }
      });
    });
  }
  const unexpectedDeclarations = declarations.filter((entry) => !allowedNativeScrolling.has(entry));
  return { declarations, nativeScrollbarSelectors, unexpectedDeclarations };
}

function auditScrollAreaCoverage() {
  const roots = [];
  const unexpectedInlineScrolling = [];
  const tsxFiles = listFiles(sourceDir, ".tsx");

  for (const file of tsxFiles) {
    const sourceText = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
      if (opening && opening.tagName.getText(sourceFile) === "ScrollArea") {
        const stringAttribute = (name) => {
          const attribute = opening.attributes.properties.find((candidate) => ts.isJsxAttribute(candidate) && candidate.name.text === name);
          if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) return "";
          if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
          if (ts.isJsxExpression(attribute.initializer)
            && attribute.initializer.expression
            && (ts.isStringLiteral(attribute.initializer.expression) || ts.isNoSubstitutionTemplateLiteral(attribute.initializer.expression))) {
            return attribute.initializer.expression.text;
          }
          return "";
        };
        const literal = stringAttribute("className");
        roots.push({
          axes: stringAttribute("scrollbars") || "vertical",
          classes: literal.split(/\s+/).filter(Boolean),
          hideScrollbars: opening.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === "hideScrollbars"),
          location: sourceLocation(sourceFile, opening),
          source: opening.getText(sourceFile),
        });
      }

      if (ts.isPropertyAssignment(node)) {
        const property = node.name.getText(sourceFile).replace(/^['"]|['"]$/g, "");
        if (/^overflow(?:X|Y)?$/.test(property)
          && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
          && /^(auto|scroll)$/.test(node.initializer.text)) {
          unexpectedInlineScrolling.push(`${sourceLocation(sourceFile, node)}::${property}:${node.initializer.text}`);
        }
      }

      if (ts.isJsxAttribute(node) && node.name.text === "className" && node.initializer) {
        const classSource = node.initializer.getText(sourceFile);
        if (/(?:^|[^\w-])overflow(?:-[xy])?-(?:auto|scroll)(?=$|[^\w-])/.test(classSource)) {
          unexpectedInlineScrolling.push(`${sourceLocation(sourceFile, node)}::${classSource}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const surfaceRootCounts = Object.fromEntries(expectedSurfaceClasses.map((className) => [
    className,
    roots.filter((root) => root.classes.includes(className)).length,
  ]));
  const missingSurfaceClasses = expectedSurfaceClasses.filter((className) => surfaceRootCounts[className] === 0);
  const unexpectedSurfaceCounts = expectedSurfaceClasses
    .filter((className) => surfaceRootCounts[className] !== expectedSurfaceCounts[className])
    .map((className) => `${className}: expected ${expectedSurfaceCounts[className]}, received ${surfaceRootCounts[className]}`);
  const surfaceAxes = Object.fromEntries(expectedSurfaceClasses.map((className) => [
    className,
    roots.find((root) => root.classes.includes(className))?.axes ?? null,
  ]));
  const surfaceHideScrollbars = Object.fromEntries(expectedSurfaceClasses.map((className) => [
    className,
    roots.find((root) => root.classes.includes(className))?.hideScrollbars ?? null,
  ]));
  const surfaceVerticalScrollbarOffsets = {
    combobox: roots.filter((root) => root.classes.includes("combobox-options")).every((root) => /className="combobox-options overflow-visible"/.test(root.source) && /verticalScrollbarOffset=\{-10\}/.test(root.source)),
    resourceNav: roots.filter((root) => root.classes.includes("resource-nav-scroll-area")).every((root) => /className="resource-nav-scroll-area overflow-visible"/.test(root.source) && /verticalScrollbarOffset=\{-10\}/.test(root.source)),
  };
  const unexpectedScrollbarVisibility = expectedSurfaceClasses
    .filter((className) => surfaceHideScrollbars[className] !== hiddenScrollbarSurfaceClasses.has(className))
    .map((className) => `${className}: expected hideScrollbars=${hiddenScrollbarSurfaceClasses.has(className)}, received ${surfaceHideScrollbars[className]}`);
  const focusableStaticViewports = Object.fromEntries(["logs-scroll-area", "about-code-scroll"].map((className) => {
    const root = roots.find((candidate) => candidate.classes.includes(className));
    return [className, Boolean(root && /viewportProps=\{\{[\s\S]*?tabIndex:\s*0/.test(root.source))];
  }));
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  return {
    dependencyInstalled: Boolean(packageJson.dependencies?.["@radix-ui/react-scroll-area"]),
    focusableStaticViewports,
    missingSurfaceClasses,
    scrollAreaUsages: roots.length,
    surfaceAxes,
    surfaceHideScrollbars,
    surfaceRootCounts,
    surfaceVerticalScrollbarOffsets,
    unexpectedInlineScrolling,
    unexpectedScrollbarVisibility,
    unexpectedSurfaceCounts,
  };
}

async function resetApp(page, theme = "dark") {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate((nextTheme) => {
    localStorage.clear();
    localStorage.setItem("kubehive.preferences", JSON.stringify({ language: "en", theme: nextTheme }));
  }, theme);
  await page.reload({ waitUntil: "networkidle" });
}

async function inspectScrollArea(page, rootSelector, viewportSelector) {
  return page.evaluate(({ rootSelector: rootQuery, viewportSelector: viewportQuery }) => {
    const root = document.querySelector(rootQuery);
    const viewport = document.querySelector(viewportQuery);
    if (!(root instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return null;
    const rootBounds = root.getBoundingClientRect();
    const viewportBounds = viewport.getBoundingClientRect();
    return {
      rootSlot: root.dataset.slot === "scroll-area",
      viewportSlot: viewport.dataset.slot === "scroll-area-viewport",
      rootWidth: rootBounds.width,
      rootHeight: rootBounds.height,
      viewportWidth: viewportBounds.width,
      viewportHeight: viewportBounds.height,
      clientWidth: viewport.clientWidth,
      clientHeight: viewport.clientHeight,
      scrollWidth: viewport.scrollWidth,
      scrollHeight: viewport.scrollHeight,
      tracks: root.querySelectorAll('[data-slot="scroll-area-scrollbar"]').length,
      thumbs: root.querySelectorAll('[data-slot="scroll-area-thumb"]').length,
    };
  }, { rootSelector, viewportSelector });
}

async function inspectVerticalScrollbarGeometry(page, rootSelector, boundarySelector) {
  return page.locator(rootSelector).evaluate((root, boundaryQuery) => {
    const boundary = document.querySelector(boundaryQuery);
    const track = root.querySelector(':scope > [data-slot="scroll-area-scrollbar"][data-orientation="vertical"]');
    const thumb = track?.querySelector('[data-slot="scroll-area-thumb"]');
    if (!(root instanceof HTMLElement) || !(boundary instanceof HTMLElement) || !(track instanceof HTMLElement) || !(thumb instanceof HTMLElement)) return null;
    const rootBounds = root.getBoundingClientRect();
    const boundaryBounds = boundary.getBoundingClientRect();
    const trackBounds = track.getBoundingClientRect();
    const thumbBounds = thumb.getBoundingClientRect();
    return {
      boundaryInset: boundaryBounds.right - trackBounds.right,
      rootInset: rootBounds.right - trackBounds.right,
      thumbVisible: thumbBounds.width >= 4 && thumbBounds.height > 0,
      trackOutsideRoot: trackBounds.left >= rootBounds.right - 0.5,
      trackVisible: trackBounds.width >= 9 && trackBounds.height > 0,
    };
  }, boundarySelector);
}

async function inspectThumb(page, thumbSelector, surfaceSelector) {
  return page.locator(thumbSelector).evaluate((thumb, surfaceQuery) => {
    const parseColor = (value) => {
      const channels = (value.match(/[\d.]+/g) ?? []).map(Number);
      return { red: channels[0] ?? 0, green: channels[1] ?? 0, blue: channels[2] ?? 0, alpha: channels[3] ?? 1 };
    };
    const luminance = ({ red, green, blue }) => {
      const linear = [red, green, blue].map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const foreground = parseColor(getComputedStyle(thumb).backgroundColor);
    const surface = document.querySelector(surfaceQuery);
    const background = parseColor(surface ? getComputedStyle(surface).backgroundColor : "rgb(0, 0, 0)");
    const composite = {
      red: foreground.red * foreground.alpha + background.red * (1 - foreground.alpha),
      green: foreground.green * foreground.alpha + background.green * (1 - foreground.alpha),
      blue: foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha),
    };
    const foregroundLuminance = luminance(composite);
    const backgroundLuminance = luminance(background);
    const bounds = thumb.getBoundingClientRect();
    const trackBounds = thumb.parentElement?.getBoundingClientRect();
    return {
      color: getComputedStyle(thumb).backgroundColor,
      contrast: (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
      height: bounds.height,
      width: bounds.width,
      trackHeight: trackBounds?.height ?? 0,
      trackWidth: trackBounds?.width ?? 0,
    };
  }, surfaceSelector);
}

async function mountComponentHarness(page) {
  await page.evaluate(async () => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { ColumnPicker } = await import("/src/column-picker.tsx");
    const { Combobox } = await import("/src/combobox.tsx");
    const { LogOutputScrollArea } = await import("/src/log-output-scroll-area.tsx");
    const { useHorizontalTabRail } = await import("/src/tab-scroll.ts");
    const { Button, ScrollArea, TooltipProvider } = await import("/src/components/ui/index.ts");
    const host = document.createElement("div");
    host.id = "scroll-area-harness";
    host.style.cssText = "position:fixed;inset:20px;z-index:40;padding:20px;background:#11151a;color:#e5e7eb";
    document.body.append(host);
    function HiddenTabRail({ surface }) {
      const workspace = surface === "workspace";
      const viewportRef = useHorizontalTabRail();
      return React.createElement(
        ScrollArea,
        {
          className: workspace ? "workspace-tab-scroll-area" : "bottom-session-tabs-scroll-area",
          "data-tab-rail-harness": surface,
          hideScrollbars: true,
          scrollbars: "horizontal",
          style: { flex: "none", width: 220, maxWidth: "none", height: 38 },
          type: "hover",
          viewportClassName: workspace ? "workspace-tab-list" : "bottom-session-tabs",
          viewportRef,
        },
        React.createElement(
          "div",
          { className: workspace ? "workspace-tab-list-content" : "bottom-session-tabs-content" },
          ...Array.from({ length: 8 }, (_, index) => React.createElement("button", { key: index, type: "button" }, `${workspace ? "Resource" : "Session"} ${index + 1}`)),
        ),
      );
    }
    function Harness() {
      const [value, setValue] = React.useState("value-0");
      const logOutput = [
        `wide ${"x".repeat(500)}`,
        ...Array.from({ length: 78 }, (_, index) => `log line ${index + 1}`),
        "TARGET final log line",
      ].join("\n");
      const matchStart = logOutput.indexOf("TARGET");
      return React.createElement(
        TooltipProvider,
        { delayDuration: 0 },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "flex-start", gap: "24px" } },
          React.createElement(
            ScrollArea,
            { className: "generic-scroll-area", scrollbars: "both", style: { width: 240, height: 120 } },
            React.createElement("div", { style: { width: 800, height: 400, padding: 8 } }, "Two-axis production ScrollArea"),
          ),
          React.createElement(
            "aside",
            { className: "resource-nav resource-nav-scroll-harness", style: { position: "absolute", top: 0, left: -240, width: 220, height: 160 } },
            React.createElement(
              ScrollArea,
              { className: "resource-nav-scroll-area overflow-visible", verticalScrollbarOffset: -10, viewportClassName: "resource-nav-scroll" },
              React.createElement("nav", null, ...Array.from({ length: 16 }, (_, index) => React.createElement("button", { key: index, type: "button" }, `Resource ${index + 1}`))),
            ),
          ),
          React.createElement(ColumnPicker, {
            resource: "ScrollAreaHarness",
            language: "en",
            defs: Array.from({ length: 20 }, (_, index) => ({ id: `column-${index}`, label: `Column ${index}`, required: index === 0, defaultVisible: true })),
            isVisible: () => true,
            onToggle: () => undefined,
            onReset: () => undefined,
          }),
          React.createElement(Combobox, {
            value,
            onChange: setValue,
            ariaLabel: "Many options",
            options: Array.from({ length: 30 }, (_, index) => ({ value: `value-${index}`, label: `Option ${index}` })),
          }),
          React.createElement(
            "div",
            { className: "theme-light session-control-harness", style: { display: "grid", width: 420, gap: 10 } },
            React.createElement(
              "div",
              { className: "session-action-bar" },
              React.createElement(
                "div",
                { className: "session-secondary-actions" },
                ...["Timestamps", "Follow", "Previous", "Wrap"].map((label) => React.createElement(
                  "label",
                  { className: "session-checkbox", key: label },
                  React.createElement("input", { type: "checkbox" }),
                  React.createElement("span", null, label),
                )),
              ),
            ),
            React.createElement(
              "div",
              { className: "node-drain-options" },
              React.createElement(
                "label",
                { className: "session-checkbox" },
                React.createElement("input", { type: "checkbox" }),
                React.createElement("span", null,
                  React.createElement("strong", null, "Drain option"),
                  React.createElement("small", null, "This intentionally long explanation must wrap without clipping the option row."),
                ),
              ),
            ),
            React.createElement(
              "div",
              { className: "theme-light generic-button-harness" },
              React.createElement(Button, { className: "generic-ghost-button", variant: "ghost", size: "sm" }, "Ghost"),
              React.createElement(Button, { className: "generic-outline-button", variant: "outline", size: "sm" }, "Outline"),
            ),
          ),
          React.createElement(
            "div",
            { className: "hidden-tab-rail-harnesses", style: { display: "grid", gap: 12 } },
            React.createElement(HiddenTabRail, { surface: "workspace" }),
            React.createElement(HiddenTabRail, { surface: "sessions" }),
          ),
          React.createElement(
            "div",
            { className: "content-theme-light log-output-harness", style: { display: "flex", width: 240, height: 120 } },
            React.createElement(LogOutputScrollArea, {
              ariaLabel: "Harness logs",
              currentIndex: 0,
              fontFamily: "ui-monospace",
              fontSize: 10,
              matches: [{ start: matchStart, end: matchStart + 6 }],
              output: logOutput,
              wrapLines: false,
            }),
          ),
        ),
      );
    }
    window.__kubehiveScrollAreaRoot = ReactDOM.createRoot(host);
    window.__kubehiveScrollAreaRoot.render(React.createElement(Harness));
  });
}

async function unmountComponentHarness(page) {
  await page.evaluate(() => {
    window.__kubehiveScrollAreaRoot?.unmount();
    window.__kubehiveScrollAreaRoot = undefined;
    document.getElementById("scroll-area-harness")?.remove();
  });
}

async function exerciseHiddenTabRail(page, surface) {
  const rootSelector = `[data-tab-rail-harness="${surface}"]`;
  const viewportSelector = `${rootSelector} [data-slot="scroll-area-viewport"]`;
  const viewport = page.locator(viewportSelector);
  await page.waitForFunction((selector) => {
    const element = document.querySelector(selector);
    return element instanceof HTMLElement && element.scrollWidth > element.clientWidth;
  }, viewportSelector);

  const chrome = await page.locator(rootSelector).evaluate((root) => {
    const viewportElement = root.querySelector('[data-slot="scroll-area-viewport"]');
    const rootBounds = root.getBoundingClientRect();
    const viewportBounds = viewportElement?.getBoundingClientRect();
    return {
      noRadixScrollbar: root.querySelectorAll('[data-slot="scroll-area-scrollbar"]').length === 0,
      noRadixThumb: root.querySelectorAll('[data-slot="scroll-area-thumb"]').length === 0,
      noReservedTrackSpace: Boolean(viewportBounds && Math.abs(rootBounds.height - viewportBounds.height) <= 1),
      nativeScrollbarHidden: Boolean(viewportElement && getComputedStyle(viewportElement).scrollbarWidth === "none"),
    };
  });

  await viewport.evaluate(async (element) => {
    element.scrollLeft = 0;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await viewport.hover();
  await page.mouse.wheel(0, 180);
  await page.waitForFunction((selector) => (document.querySelector(selector)?.scrollLeft ?? 0) > 0, viewportSelector);
  const directWheelLeft = await viewport.evaluate((element) => element.scrollLeft);

  await viewport.evaluate(async (element) => {
    element.scrollLeft = 0;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await viewport.hover();
  await page.keyboard.down("Shift");
  try {
    await page.mouse.wheel(0, 180);
  } finally {
    await page.keyboard.up("Shift");
  }
  await page.waitForFunction((selector) => (document.querySelector(selector)?.scrollLeft ?? 0) > 0, viewportSelector);
  const shiftWheelLeft = await viewport.evaluate((element) => element.scrollLeft);

  return { ...chrome, directWheelLeft, shiftWheelLeft };
}

async function exerciseResourceNavFilterLayer(page) {
  await page.evaluate(async () => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { ScrollArea } = await import("/src/components/ui/index.ts");
    const host = document.createElement("div");
    host.id = "resource-nav-filter-layer-harness";
    host.style.cssText = "position:fixed;left:920px;top:30px;z-index:90;width:260px;height:330px;background:#090b0e";
    document.body.append(host);
    const filterPopover = React.createElement(
      "div",
      { className: "resource-tree-filter-popover" },
      React.createElement("header", null, React.createElement("div", null, React.createElement("strong", null, "Resource visibility"), React.createElement("small", null, "Filter resources"))),
      React.createElement("div", { style: { height: 120, padding: 8 } }, "Filter content"),
    );
    const filter = React.createElement(
      "div",
      { className: "resource-tree-filter open" },
      React.createElement("button", { className: "resource-tree-filter-trigger", type: "button" }, "Filter"),
      filterPopover,
    );
    const title = React.createElement(
      "div",
      { className: "nav-title" },
      React.createElement("span", null, "Resources"),
      React.createElement("div", { className: "nav-title-actions" }, filter),
    );
    const content = React.createElement(
      "nav",
      null,
      React.createElement("section", null, ...Array.from({ length: 18 }, (_, index) => React.createElement("button", { key: index, type: "button" }, `Resource ${index + 1}`))),
    );
    const scrollArea = React.createElement(
      ScrollArea,
      { className: "resource-nav-scroll-area overflow-visible", verticalScrollbarOffset: -10, viewportClassName: "resource-nav-scroll" },
      content,
    );
    window.__kubehiveResourceNavFilterLayerRoot = ReactDOM.createRoot(host);
    window.__kubehiveResourceNavFilterLayerRoot.render(React.createElement("aside", { className: "resource-nav", style: { position: "relative", width: "100%", height: "100%" } }, title, scrollArea));
  });
  await page.waitForFunction(() => Boolean(document.querySelector("#resource-nav-filter-layer-harness .resource-tree-filter-popover") && document.querySelector("#resource-nav-filter-layer-harness [data-slot=\"scroll-area-thumb\"]")));
  const layer = await page.locator("#resource-nav-filter-layer-harness").evaluate((host) => {
    const title = host.querySelector(".nav-title");
    const popover = host.querySelector(".resource-tree-filter-popover");
    const track = host.querySelector('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]');
    if (!(title instanceof HTMLElement) || !(popover instanceof HTMLElement) || !(track instanceof HTMLElement)) return null;
    const popoverBounds = popover.getBoundingClientRect();
    const trackBounds = track.getBoundingClientRect();
    const left = Math.max(popoverBounds.left, trackBounds.left);
    const right = Math.min(popoverBounds.right, trackBounds.right);
    const top = Math.max(popoverBounds.top, trackBounds.top);
    const bottom = Math.min(popoverBounds.bottom, trackBounds.bottom);
    const overlapsTrack = right - left > 1 && bottom - top > 1;
    const topElement = overlapsTrack ? document.elementFromPoint((left + right) / 2, (top + bottom) / 2) : null;
    return {
      navTitleLayer: Number(getComputedStyle(title).zIndex),
      overlapsTrack,
      popoverOnTop: Boolean(topElement?.closest(".resource-tree-filter-popover")),
    };
  });
  await page.evaluate(() => {
    window.__kubehiveResourceNavFilterLayerRoot?.unmount();
    window.__kubehiveResourceNavFilterLayerRoot = undefined;
    document.getElementById("resource-nav-filter-layer-harness")?.remove();
  });
  return layer;
}

async function exerciseWorkspaceHarness(page) {
  const rowCount = 240;
  await page.evaluate(async (count) => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { WorkspaceScroll } = await import("/src/App.tsx");
    const { VirtualResourceTable } = await import("/src/table-extras.tsx");
    const host = document.createElement("div");
    host.id = "scroll-area-workspace-harness";
    host.style.cssText = "position:fixed;left:80px;top:40px;z-index:50;display:flex;width:720px;height:360px;background:#0b0e12";
    document.body.append(host);
    const rows = Array.from({ length: count }, (_, index) => ({
      key: `pod-${index}`,
      name: `pod-${String(index).padStart(3, "0")}`,
      namespace: "default",
      kind: "Pod",
      status: index % 7 === 0 ? "Pending" : "Running",
      data: { age: `${index}m`, image: `registry.example.test/team/image-${index}:latest`, ready: "1/1", restarts: index },
    }));
    const columns = [
      { id: "name", label: "Name", render: (row) => row.name },
      { id: "namespace", label: "Namespace", render: (row) => row.namespace },
      { id: "status", label: "Status", render: (row) => row.status },
      { id: "image", label: "Image", render: (row) => row.data.image },
      { id: "ready", label: "Ready", render: (row) => row.data.ready },
      { id: "restarts", label: "Restarts", render: (row) => row.data.restarts },
      { id: "age", label: "Age", render: (row) => row.data.age },
    ];
    function Harness() {
      const [selected, setSelected] = React.useState(new Set());
      return React.createElement(
        WorkspaceScroll,
        null,
        React.createElement(
          "div",
          { className: "page-head" },
          React.createElement("div", null,
            React.createElement("div", { className: "eyebrow" }, "KUBERNETES RESOURCES"),
            React.createElement("h1", null, "Pods"),
            React.createElement("p", null, `${count} resources`),
          ),
        ),
        React.createElement(
          "div",
          { className: "resource-list-block" },
          React.createElement("div", { className: "table-toolbar" }, React.createElement("strong", null, "Pods")),
          React.createElement(
            "div",
            { className: "resource-table-panel" },
            React.createElement(VirtualResourceTable, {
              rows,
              columns,
              tableKey: "scroll-area-workspace-harness",
              selectedKeys: selected,
              onSelectionChange: setSelected,
            }),
          ),
        ),
      );
    }
    window.__kubehiveWorkspaceHarnessRoot = ReactDOM.createRoot(host);
    window.__kubehiveWorkspaceHarnessRoot.render(React.createElement(Harness));
  }, rowCount);

  await page.waitForFunction(() => (
    document.querySelectorAll("#scroll-area-workspace-harness .resource-table tbody tr[data-index]").length > 0
    && document.querySelectorAll('#scroll-area-workspace-harness [data-slot="scroll-area-thumb"]').length === 2
  ));
  const viewport = page.locator("#scroll-area-workspace-harness .workspace-scroll");
  const initialVirtualRows = await page.locator("#scroll-area-workspace-harness .resource-table tbody tr[data-index]").evaluateAll((rows) => rows.map((row) => Number(row.getAttribute("data-index"))));
  const geometry = await inspectScrollArea(page, "#scroll-area-workspace-harness .workspace-scroll-area", "#scroll-area-workspace-harness .workspace-scroll");

  await viewport.evaluate((element) => { element.scrollTop = 0; });
  await viewport.hover();
  await page.mouse.wheel(0, 900);
  await page.waitForFunction(() => (document.querySelector("#scroll-area-workspace-harness .workspace-scroll")?.scrollTop ?? 0) > 0);
  const wheelTop = await viewport.evaluate((element) => element.scrollTop);
  await page.waitForFunction((initialMaximum) => {
    const indexes = [...document.querySelectorAll("#scroll-area-workspace-harness .resource-table tbody tr[data-index]")]
      .map((row) => Number(row.getAttribute("data-index")));
    return indexes.length > 0 && Math.max(...indexes) > initialMaximum;
  }, Math.max(...initialVirtualRows));
  const scrolledVirtualRows = await page.locator("#scroll-area-workspace-harness .resource-table tbody tr[data-index]").evaluateAll((rows) => rows.map((row) => Number(row.getAttribute("data-index"))));
  const sticky = await page.locator("#scroll-area-workspace-harness .workspace-scroll").evaluate((element) => {
    const toolbar = element.querySelector(".table-toolbar");
    const header = element.querySelector(".resource-table thead");
    const viewportBounds = element.getBoundingClientRect();
    const toolbarBounds = toolbar?.getBoundingClientRect();
    const headerBounds = header?.getBoundingClientRect();
    return {
      headerPinned: Boolean(headerBounds && Math.abs(headerBounds.top - (viewportBounds.top + 42)) <= 2),
      headerSticky: Boolean(header && getComputedStyle(header).position === "sticky"),
      toolbarPinned: Boolean(toolbarBounds && Math.abs(toolbarBounds.top - viewportBounds.top) <= 2),
      toolbarSticky: Boolean(toolbar && getComputedStyle(toolbar).position === "sticky"),
    };
  });

  const sortButton = page.locator("#scroll-area-workspace-harness .table-sort-button").first();
  await sortButton.click();
  await page.waitForFunction(() => (document.querySelector("#scroll-area-workspace-harness .workspace-scroll")?.scrollTop ?? -1) === 0);
  const sortResetTop = await viewport.evaluate((element) => element.scrollTop);

  await viewport.evaluate((element) => { element.scrollLeft = 0; });
  const tableWrap = page.locator("#scroll-area-workspace-harness .resource-table-wrap");
  await tableWrap.hover();
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 220);
  await page.keyboard.up("Shift");
  await page.waitForFunction(() => (document.querySelector("#scroll-area-workspace-harness .workspace-scroll")?.scrollLeft ?? 0) > 0);
  const shiftWheelLeft = await viewport.evaluate((element) => element.scrollLeft);

  await viewport.evaluate(async (element) => {
    element.scrollLeft = 0;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const horizontalThumb = page.locator('#scroll-area-workspace-harness [data-slot="scroll-area-scrollbar"][data-orientation="horizontal"] [data-slot="scroll-area-thumb"]');
  const horizontalThumbBounds = await horizontalThumb.boundingBox();
  if (!horizontalThumbBounds) throw new Error("Horizontal workspace scrollbar thumb is not measurable");
  await page.mouse.move(horizontalThumbBounds.x + horizontalThumbBounds.width / 2, horizontalThumbBounds.y + horizontalThumbBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(horizontalThumbBounds.x + horizontalThumbBounds.width / 2 + 45, horizontalThumbBounds.y + horizontalThumbBounds.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => (document.querySelector("#scroll-area-workspace-harness .workspace-scroll")?.scrollLeft ?? 0) > 0);
  const horizontalDragLeft = await viewport.evaluate((element) => element.scrollLeft);

  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction((lastIndex) => Boolean(document.querySelector(`#scroll-area-workspace-harness .resource-table tbody tr[data-index="${lastIndex}"]`)), rowCount - 1);
  const lastRowReachable = await page.locator(`#scroll-area-workspace-harness .resource-table tbody tr[data-index="${rowCount - 1}"]`).evaluate((row) => {
    const viewportElement = row.closest(".workspace-scroll");
    if (!viewportElement) return false;
    const rowBounds = row.getBoundingClientRect();
    const viewportBounds = viewportElement.getBoundingClientRect();
    return rowBounds.top < viewportBounds.bottom && rowBounds.bottom <= viewportBounds.bottom + 1;
  });

  await viewport.evaluate(async (element) => {
    element.scrollTop = 0;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const verticalThumb = page.locator('#scroll-area-workspace-harness [data-slot="scroll-area-scrollbar"][data-orientation="vertical"] [data-slot="scroll-area-thumb"]');
  const thumbBounds = await verticalThumb.boundingBox();
  if (!thumbBounds) throw new Error("Workspace scrollbar thumb is not measurable");
  await page.mouse.move(thumbBounds.x + thumbBounds.width / 2, thumbBounds.y + thumbBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumbBounds.x + thumbBounds.width / 2, thumbBounds.y + thumbBounds.height / 2 + 70, { steps: 7 });
  await page.mouse.up();
  await page.waitForFunction(() => (document.querySelector("#scroll-area-workspace-harness .workspace-scroll")?.scrollTop ?? 0) > 0);
  const dragTop = await viewport.evaluate((element) => element.scrollTop);
  await page.screenshot({ path: "artifacts/shadcn-scroll-area-workspace.png", fullPage: true });

  await viewport.evaluate(async (element) => {
    element.scrollTop = 0;
    element.scrollLeft = 0;
    const host = document.getElementById("scroll-area-workspace-harness");
    if (host) host.style.width = "320px";
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.waitForFunction(() => {
    const viewportElement = document.querySelector("#scroll-area-workspace-harness .workspace-scroll");
    const header = document.querySelector("#scroll-area-workspace-harness th.selection-col");
    return viewportElement instanceof HTMLElement
      && header instanceof HTMLElement
      && viewportElement.clientWidth <= 320
      && viewportElement.scrollWidth > viewportElement.clientWidth;
  });
  const narrowSelection = await page.locator("#scroll-area-workspace-harness .workspace-scroll").evaluate((viewportElement) => {
    const within = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
    const header = viewportElement.querySelector("th.selection-col");
    const cell = viewportElement.querySelector("tbody tr[data-index] td.selection-col");
    const headerControl = header?.querySelector(".resource-selection-checkbox");
    const cellControl = cell?.querySelector(".resource-selection-checkbox");
    const headerBounds = header?.getBoundingClientRect();
    const cellBounds = cell?.getBoundingClientRect();
    return {
      checkboxFitsCells: Boolean(headerBounds && cellBounds && headerControl && cellControl
        && within(headerControl.getBoundingClientRect(), headerBounds)
        && within(cellControl.getBoundingClientRect(), cellBounds)),
      fixedColumnWidth: Boolean(headerBounds && cellBounds && headerBounds.width >= 35 && cellBounds.width >= 35 && Math.abs(headerBounds.width - cellBounds.width) <= 1),
      horizontalOverflow: viewportElement.scrollWidth > viewportElement.clientWidth,
    };
  });
  await page.screenshot({ path: "artifacts/shadcn-scroll-area-workspace-narrow.png", fullPage: true });

  await page.evaluate(() => {
    window.__kubehiveWorkspaceHarnessRoot?.unmount();
    window.__kubehiveWorkspaceHarnessRoot = undefined;
    document.getElementById("scroll-area-workspace-harness")?.remove();
  });
  return {
    dragTop,
    geometry,
    horizontalDragLeft,
    initialMaximum: Math.max(...initialVirtualRows),
    initialRendered: initialVirtualRows.length,
    lastRowReachable,
    narrowSelection,
    scrolledMaximum: Math.max(...scrolledVirtualRows),
    scrolledMinimum: Math.min(...scrolledVirtualRows),
    shiftWheelLeft,
    sortResetTop,
    sticky,
    wheelTop,
    rowCount,
  };
}

async function exerciseSurfaceMatrix(page, surfaceAxes, surfaceHideScrollbars) {
  const definitions = Object.entries(surfaceAxes).map(([className, axes]) => ({
    className,
    axes,
    hideScrollbars: surfaceHideScrollbars[className],
  }));
  await page.evaluate(async (items) => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { ScrollArea } = await import("/src/components/ui/index.ts");
    const host = document.createElement("div");
    host.id = "scroll-area-surface-matrix";
    host.style.cssText = "position:fixed;left:-10000px;top:0;display:grid;grid-template-columns:repeat(4,180px);gap:12px";
    document.body.append(host);
    function SurfaceMatrix() {
      return React.createElement(
        React.Fragment,
        null,
        ...items.map(({ className, axes, hideScrollbars }) => React.createElement(
          ScrollArea,
          {
            key: className,
            className: `scroll-area-audit-instance ${className}`,
            "data-audit-surface": className,
            hideScrollbars,
            scrollbars: axes,
            style: { flex: "none", width: 180, height: 90, minWidth: 0, minHeight: 0 },
            type: "always",
            viewportClassName: "scroll-area-audit-viewport",
          },
          React.createElement("div", {
            style: {
              height: axes === "vertical" || axes === "both" ? 320 : 60,
              width: axes === "horizontal" || axes === "both" ? 480 : 160,
            },
          }, className),
        )),
      );
    }
    window.__kubehiveSurfaceMatrixRoot = ReactDOM.createRoot(host);
    window.__kubehiveSurfaceMatrixRoot.render(React.createElement(SurfaceMatrix));
  }, definitions);

  const expectedThumbs = definitions.reduce((count, { axes, hideScrollbars }) => count + (hideScrollbars ? 0 : axes === "both" ? 2 : 1), 0);
  await page.waitForFunction(({ roots, thumbs }) => (
    document.querySelectorAll('#scroll-area-surface-matrix [data-slot="scroll-area"]').length === roots
    && document.querySelectorAll('#scroll-area-surface-matrix [data-slot="scroll-area-thumb"]').length === thumbs
  ), { roots: definitions.length, thumbs: expectedThumbs });

  const results = await page.evaluate((items) => Object.fromEntries(items.map(({ className, axes, hideScrollbars }) => {
    const root = document.querySelector(`#scroll-area-surface-matrix [data-audit-surface="${className}"]`);
    const viewport = root?.querySelector('[data-slot="scroll-area-viewport"]');
    if (!(root instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return [className, null];
    if (axes === "vertical" || axes === "both") viewport.scrollTop = 80;
    if (axes === "horizontal" || axes === "both") viewport.scrollLeft = 120;
    return [className, {
      hiddenScrollbars: hideScrollbars && root.querySelectorAll('[data-slot="scroll-area-scrollbar"]').length === 0,
      horizontalOverflow: viewport.scrollWidth > viewport.clientWidth,
      left: viewport.scrollLeft,
      rootSlot: root.dataset.slot === "scroll-area",
      thumbs: root.querySelectorAll('[data-slot="scroll-area-thumb"]').length,
      top: viewport.scrollTop,
      tracks: root.querySelectorAll('[data-slot="scroll-area-scrollbar"]').length,
      verticalOverflow: viewport.scrollHeight > viewport.clientHeight,
      viewportSlot: viewport.dataset.slot === "scroll-area-viewport",
    }];
  })), definitions);

  await page.evaluate(() => {
    window.__kubehiveSurfaceMatrixRoot?.unmount();
    window.__kubehiveSurfaceMatrixRoot = undefined;
    document.getElementById("scroll-area-surface-matrix")?.remove();
  });
  return results;
}

(async () => {
  const nativeAudit = auditNativeScrolling();
  const coverageAudit = auditScrollAreaCoverage();
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  collectRuntimeErrors(page, errors);
  await resetApp(page);

  const home = await inspectScrollArea(page, ".cluster-home-scroll-area", ".cluster-home-scroll");
  const rail = await inspectScrollArea(page, ".cluster-list-scroll-area", ".cluster-list");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settingsViewport = page.locator(".settings-scroll");
  await settingsViewport.waitFor();
  await page.waitForFunction(() => Boolean(document.querySelector('.settings-scroll-area [data-slot="scroll-area-thumb"]')));
  const settings = await inspectScrollArea(page, ".settings-scroll-area", ".settings-scroll");
  await settingsViewport.evaluate((viewport) => { viewport.scrollTop = 0; });
  await settingsViewport.hover();
  await page.mouse.wheel(0, 420);
  await page.waitForFunction(() => (document.querySelector(".settings-scroll")?.scrollTop ?? 0) > 0);
  const settingsWheelTop = await settingsViewport.evaluate((viewport) => viewport.scrollTop);
  const settingsThumb = await inspectThumb(page, '.settings-scroll-area [data-slot="scroll-area-thumb"]', ".settings-modal");
  await page.screenshot({ path: "artifacts/shadcn-scroll-area-settings.png", fullPage: true });
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await mountComponentHarness(page);
  await page.locator(".generic-scroll-area").waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.generic-scroll-area [data-slot="scroll-area-thumb"]').length === 2);
  const genericViewport = page.locator('.generic-scroll-area [data-slot="scroll-area-viewport"]');
  await genericViewport.evaluate((viewport) => {
    viewport.scrollTop = 140;
    viewport.scrollLeft = 300;
  });
  const generic = await inspectScrollArea(page, ".generic-scroll-area", '.generic-scroll-area [data-slot="scroll-area-viewport"]');
  const genericOffset = await genericViewport.evaluate((viewport) => ({ top: viewport.scrollTop, left: viewport.scrollLeft }));
  await page.waitForFunction(() => Boolean(document.querySelector('.resource-nav-scroll-harness [data-slot="scroll-area-thumb"]')));
  const resourceNavScrollbarGeometry = await inspectVerticalScrollbarGeometry(page, ".resource-nav-scroll-harness .resource-nav-scroll-area", ".resource-nav-scroll-harness");
  const resourceNavViewport = page.locator(".resource-nav-scroll-harness .resource-nav-scroll");
  await resourceNavViewport.evaluate((viewport) => { viewport.scrollTop = viewport.scrollHeight; });
  const resourceNavScrollTop = await resourceNavViewport.evaluate((viewport) => viewport.scrollTop);
  const sessionCheckboxLayout = await page.locator(".session-control-harness").evaluate((root) => {
    const within = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
    const actionBar = root.querySelector(".session-action-bar");
    const compact = [...root.querySelectorAll(".session-action-bar .session-checkbox")];
    const drain = root.querySelector(".node-drain-options .session-checkbox");
    const drainInput = drain?.querySelector("input");
    const drainText = drain?.querySelector("span");
    const drainBounds = drain?.getBoundingClientRect();
    return {
      actionBarCompact: Boolean(actionBar && actionBar.getBoundingClientRect().height <= 38),
      compactCheckboxes: compact.length === 4 && compact.every((checkbox) => {
        const bounds = checkbox.getBoundingClientRect();
        const input = checkbox.querySelector("input")?.getBoundingClientRect();
        return Math.abs(bounds.height - 26) <= 1 && checkbox.scrollHeight <= checkbox.clientHeight && Boolean(input && within(input, bounds));
      }),
      drainCheckboxFits: Boolean(drainBounds && drainInput && drainText && within(drainInput.getBoundingClientRect(), drainBounds) && within(drainText.getBoundingClientRect(), drainBounds)),
      drainNaturalHeight: Boolean(drain && drainBounds && drainBounds.height > 26 && drain.scrollHeight <= drain.clientHeight),
    };
  });
  const inspectNeutralHover = async (selector) => {
    const button = page.locator(selector);
    await button.hover();
    await page.waitForFunction((query) => {
      const element = document.querySelector(query);
      if (!(element instanceof HTMLElement)) return false;
      const channels = (getComputedStyle(element).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
      return channels.length === 3 || (channels.length === 4 && channels[3] >= 0.99);
    }, selector);
    return button.evaluate((element) => {
      const color = getComputedStyle(element).backgroundColor;
      const channels = (color.match(/\d+/g) ?? []).slice(0, 3).map(Number);
      return {
        backgroundColor: color,
        neutral: channels.length === 3 && Math.max(...channels) - Math.min(...channels) <= 12,
        visible: color !== "rgba(0, 0, 0, 0)",
      };
    });
  };
  const lightButtonHover = {
    ghost: await inspectNeutralHover(".generic-ghost-button"),
    outline: await inspectNeutralHover(".generic-outline-button"),
  };
  const lightSessionCheckboxHover = await inspectNeutralHover(".session-control-harness .session-action-bar .session-checkbox:first-child");

  await page.getByRole("button", { name: "Columns", exact: true }).click();
  const columnViewport = page.locator(".column-picker-list-viewport");
  await page.waitForFunction(() => Boolean(document.querySelector('.column-picker-list [data-slot="scroll-area-thumb"]')));
  const columnPicker = await inspectScrollArea(page, ".column-picker-list", ".column-picker-list-viewport");
  await columnViewport.hover();
  await page.mouse.wheel(0, 260);
  await page.waitForFunction(() => (document.querySelector(".column-picker-list-viewport")?.scrollTop ?? 0) > 0);
  const columnScrollTop = await columnViewport.evaluate((viewport) => viewport.scrollTop);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Many options", exact: true }).click();
  const comboboxViewport = page.locator(".combobox-options-viewport");
  await page.waitForFunction(() => Boolean(document.querySelector('.combobox-options [data-slot="scroll-area-thumb"]')));
  const combobox = await inspectScrollArea(page, ".combobox-options", ".combobox-options-viewport");
  const comboboxScrollbarGeometry = await inspectVerticalScrollbarGeometry(page, ".combobox-options", ".combobox-popover");
  await comboboxViewport.evaluate((viewport) => { viewport.scrollTop = viewport.scrollHeight; });
  const comboboxScrollTop = await comboboxViewport.evaluate((viewport) => viewport.scrollTop);
  await page.screenshot({ path: "artifacts/shadcn-scroll-area-components.png", fullPage: true });
  await page.keyboard.press("Escape");
  const hiddenTabRails = {
    workspace: await exerciseHiddenTabRail(page, "workspace"),
    sessions: await exerciseHiddenTabRail(page, "sessions"),
  };
  const resourceNavFilterLayer = await exerciseResourceNavFilterLayer(page);

  const logViewport = page.locator(".log-output-harness .logs-output");
  await page.waitForFunction(() => (document.querySelector(".log-output-harness .logs-output")?.scrollTop ?? 0) > 0);
  const logMatchScrollTop = await logViewport.evaluate((viewport) => viewport.scrollTop);
  const lightLog = await inspectScrollArea(page, ".log-output-harness .logs-scroll-area", ".log-output-harness .logs-output");
  const lightLogThumb = await inspectThumb(
    page,
    '.log-output-harness [data-slot="scroll-area-scrollbar"][data-orientation="vertical"] [data-slot="scroll-area-thumb"]',
    ".log-output-harness .logs-scroll-area",
  );
  const logAccessibility = await logViewport.evaluate((viewport) => ({
    focusable: viewport.tabIndex === 0,
    labelled: viewport.getAttribute("aria-label") === "Harness logs",
    region: viewport.getAttribute("role") === "region",
  }));

  await logViewport.evaluate((viewport) => { viewport.scrollTop = 0; });
  await logViewport.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => (document.querySelector(".log-output-harness .logs-output")?.scrollTop ?? 0) > 0);
  const logKeyboardScrollTop = await logViewport.evaluate((viewport) => viewport.scrollTop);

  await logViewport.evaluate((viewport) => { viewport.scrollTop = 0; });
  await logViewport.hover();
  await page.mouse.wheel(0, 240);
  await page.waitForFunction(() => (document.querySelector(".log-output-harness .logs-output")?.scrollTop ?? 0) > 0);
  const logWheelScrollTop = await logViewport.evaluate((viewport) => viewport.scrollTop);

  await logViewport.evaluate((viewport) => { viewport.scrollLeft = 0; });
  const logHorizontalThumb = page.locator('.log-output-harness [data-slot="scroll-area-scrollbar"][data-orientation="horizontal"] [data-slot="scroll-area-thumb"]');
  const logHorizontalThumbBounds = await logHorizontalThumb.boundingBox();
  if (!logHorizontalThumbBounds) throw new Error("Horizontal log scrollbar thumb is not measurable");
  await page.mouse.move(logHorizontalThumbBounds.x + logHorizontalThumbBounds.width / 2, logHorizontalThumbBounds.y + logHorizontalThumbBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(logHorizontalThumbBounds.x + logHorizontalThumbBounds.width / 2 + 40, logHorizontalThumbBounds.y + logHorizontalThumbBounds.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => (document.querySelector(".log-output-harness .logs-output")?.scrollLeft ?? 0) > 0);
  const logHorizontalDragLeft = await logViewport.evaluate((viewport) => viewport.scrollLeft);

  await logViewport.evaluate((viewport) => { viewport.scrollTop = 0; });
  const logVerticalThumb = page.locator('.log-output-harness [data-slot="scroll-area-scrollbar"][data-orientation="vertical"] [data-slot="scroll-area-thumb"]');
  const logThumbBounds = await logVerticalThumb.boundingBox();
  if (!logThumbBounds) throw new Error("Log scrollbar thumb is not measurable");
  await page.mouse.move(logThumbBounds.x + logThumbBounds.width / 2, logThumbBounds.y + logThumbBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(logThumbBounds.x + logThumbBounds.width / 2, logThumbBounds.y + logThumbBounds.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => (document.querySelector(".log-output-harness .logs-output")?.scrollTop ?? 0) > 0);
  const logDragScrollTop = await logViewport.evaluate((viewport) => viewport.scrollTop);

  await unmountComponentHarness(page);
  const workspace = await exerciseWorkspaceHarness(page);
  const surfaceMatrix = await exerciseSurfaceMatrix(page, coverageAudit.surfaceAxes, coverageAudit.surfaceHideScrollbars);

  const mobileErrors = [];
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  collectRuntimeErrors(mobile, mobileErrors);
  await resetApp(mobile);
  await mobile.getByRole("button", { name: "Settings", exact: true }).click();
  const mobileSettingsViewport = mobile.locator(".settings-scroll");
  await mobileSettingsViewport.waitFor();
  await mobile.waitForFunction(() => Boolean(document.querySelector('.settings-scroll-area [data-slot="scroll-area-thumb"]')));
  const mobileSettings = await inspectScrollArea(mobile, ".settings-scroll-area", ".settings-scroll");
  const mobileLayout = await mobile.locator(".settings-modal").evaluate((modal) => {
    const bounds = modal.getBoundingClientRect();
    return {
      withinViewport: bounds.left >= 8 && bounds.right <= innerWidth - 8 && bounds.top >= 8 && bounds.bottom <= innerHeight - 8,
      noPageOverflow: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
    };
  });
  await mobileSettingsViewport.evaluate((viewport) => { viewport.scrollTop = viewport.scrollHeight; });
  const mobileScrollTop = await mobileSettingsViewport.evaluate((viewport) => viewport.scrollTop);
  await mobile.screenshot({ path: "artifacts/shadcn-scroll-area-mobile.png", fullPage: true });

  const lightErrors = [];
  const light = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  collectRuntimeErrors(light, lightErrors);
  await resetApp(light, "light");
  await light.getByRole("button", { name: "Settings", exact: true }).click();
  await light.waitForFunction(() => Boolean(document.querySelector('.settings-scroll-area [data-slot="scroll-area-thumb"]')));
  const lightSettings = await inspectScrollArea(light, ".settings-scroll-area", ".settings-scroll");
  const lightThumb = await inspectThumb(light, '.settings-scroll-area [data-slot="scroll-area-thumb"]', ".settings-modal");
  await light.locator(".settings-scroll").evaluate((viewport) => { viewport.scrollTop = viewport.scrollHeight; });
  const lightScrollTop = await light.locator(".settings-scroll").evaluate((viewport) => viewport.scrollTop);
  await light.screenshot({ path: "artifacts/shadcn-scroll-area-light.png", fullPage: true });

  const result = {
    nativeAudit,
    coverageAudit,
    home,
    rail,
    settings,
    settingsWheelTop,
    settingsThumb,
    generic,
    genericOffset,
    resourceNavScrollbarGeometry,
    resourceNavScrollTop,
    sessionCheckboxLayout,
    lightButtonHover,
    lightSessionCheckboxHover,
    columnPicker,
    columnScrollTop,
    combobox,
    comboboxScrollbarGeometry,
    comboboxScrollTop,
    hiddenTabRails,
    resourceNavFilterLayer,
    lightLog,
    lightLogThumb,
    logAccessibility,
    logDragScrollTop,
    logHorizontalDragLeft,
    logKeyboardScrollTop,
    logMatchScrollTop,
    logWheelScrollTop,
    workspace,
    surfaceMatrix,
    mobileSettings,
    mobileLayout,
    mobileScrollTop,
    lightSettings,
    lightThumb,
    lightScrollTop,
    errors: [...errors, ...mobileErrors, ...lightErrors],
  };
  console.log(JSON.stringify(result, null, 2));

  const hiddenTabRailsPassed = Object.values(hiddenTabRails).every((rail) => (
    rail.noRadixScrollbar
    && rail.noRadixThumb
    && rail.noReservedTrackSpace
    && rail.nativeScrollbarHidden
    && rail.directWheelLeft > 0
    && rail.shiftWheelLeft > 0
  ));

  const surfaceMatrixPassed = expectedSurfaceClasses.every((className) => {
    const axes = coverageAudit.surfaceAxes[className];
    const surface = surfaceMatrix[className];
    const hiddenScrollbars = coverageAudit.surfaceHideScrollbars[className];
    const expectedTracks = hiddenScrollbars ? 0 : axes === "both" ? 2 : 1;
    const verticalWorks = axes === "vertical" || axes === "both" ? surface?.verticalOverflow && surface.top > 0 : true;
    const horizontalWorks = axes === "horizontal" || axes === "both" ? surface?.horizontalOverflow && surface.left > 0 : true;
    return surface?.rootSlot && surface.viewportSlot && surface.tracks === expectedTracks && surface.thumbs === expectedTracks && (!hiddenScrollbars || surface.hiddenScrollbars) && verticalWorks && horizontalWorks;
  });

  const passed = nativeAudit.unexpectedDeclarations.length === 0
    && nativeAudit.nativeScrollbarSelectors.length === 0
    && coverageAudit.dependencyInstalled
    && coverageAudit.missingSurfaceClasses.length === 0
    && coverageAudit.scrollAreaUsages === expectedScrollAreaUsages
    && coverageAudit.unexpectedInlineScrolling.length === 0
    && coverageAudit.unexpectedScrollbarVisibility.length === 0
    && coverageAudit.unexpectedSurfaceCounts.length === 0
    && Object.values(coverageAudit.surfaceVerticalScrollbarOffsets).every(Boolean)
    && Object.values(coverageAudit.focusableStaticViewports).every(Boolean)
    && home?.rootSlot && home.viewportSlot && home.tracks === 2
    && rail?.rootSlot && rail.viewportSlot && rail.tracks === 1
    && settings?.scrollHeight > settings?.clientHeight
    && Math.abs(settings.rootHeight - settings.viewportHeight) <= 1
    && settings.thumbs === 1
    && settingsWheelTop > 0
    && settingsThumb.trackWidth >= 9 && settingsThumb.trackWidth <= 11
    && settingsThumb.width >= 4 && settingsThumb.width <= 7
    && settingsThumb.contrast >= 3
    && generic?.scrollHeight > generic?.clientHeight
    && generic?.scrollWidth > generic?.clientWidth
    && generic.thumbs === 2
    && genericOffset.top > 0 && genericOffset.left > 0
    && resourceNavScrollbarGeometry?.trackVisible && resourceNavScrollbarGeometry.thumbVisible
    && resourceNavScrollbarGeometry.trackOutsideRoot
    && Math.abs(resourceNavScrollbarGeometry.rootInset + 10) <= 1
    && resourceNavScrollbarGeometry.boundaryInset >= 0 && resourceNavScrollbarGeometry.boundaryInset <= 2
    && resourceNavScrollTop > 0
    && Object.values(sessionCheckboxLayout).every(Boolean)
    && Object.values(lightButtonHover).every((button) => button.visible && button.neutral)
    && lightSessionCheckboxHover.visible && lightSessionCheckboxHover.neutral
    && columnPicker?.scrollHeight > columnPicker?.clientHeight
    && columnPicker.thumbs === 1
    && columnScrollTop > 0
    && combobox?.scrollHeight > combobox?.clientHeight
    && combobox.thumbs === 1
    && comboboxScrollbarGeometry?.trackVisible && comboboxScrollbarGeometry.thumbVisible
    && comboboxScrollbarGeometry.trackOutsideRoot
    && Math.abs(comboboxScrollbarGeometry.rootInset + 10) <= 1
    && comboboxScrollbarGeometry.boundaryInset >= 0 && comboboxScrollbarGeometry.boundaryInset <= 2
    && comboboxScrollTop > 0
    && hiddenTabRailsPassed
    && resourceNavFilterLayer?.overlapsTrack
    && resourceNavFilterLayer.popoverOnTop
    && resourceNavFilterLayer.navTitleLayer > 30
    && lightLog?.scrollHeight > lightLog?.clientHeight
    && lightLog?.scrollWidth > lightLog?.clientWidth
    && lightLog.thumbs === 2
    && lightLogThumb.contrast >= 3
    && Object.values(logAccessibility).every(Boolean)
    && logDragScrollTop > 0
    && logHorizontalDragLeft > 0
    && logKeyboardScrollTop > 0
    && logMatchScrollTop > 0
    && logWheelScrollTop > 0
    && workspace.geometry?.scrollHeight > workspace.geometry?.clientHeight
    && workspace.geometry?.scrollWidth > workspace.geometry?.clientWidth
    && workspace.geometry.thumbs === 2
    && workspace.initialRendered > 0 && workspace.initialRendered < workspace.rowCount
    && workspace.lastRowReachable
    && Object.values(workspace.narrowSelection).every(Boolean)
    && workspace.scrolledMaximum > workspace.initialMaximum
    && workspace.scrolledMinimum > 0
    && workspace.shiftWheelLeft > 0
    && workspace.horizontalDragLeft > 0
    && workspace.sortResetTop === 0
    && Object.values(workspace.sticky).every(Boolean)
    && workspace.wheelTop > 0
    && workspace.dragTop > 0
    && surfaceMatrixPassed
    && mobileSettings?.scrollHeight > mobileSettings?.clientHeight
    && mobileSettings.thumbs === 1
    && Object.values(mobileLayout).every(Boolean)
    && mobileScrollTop > 0
    && lightSettings?.scrollHeight > lightSettings?.clientHeight
    && lightSettings.thumbs === 1
    && lightThumb.color !== "rgba(0, 0, 0, 0)"
    && lightThumb.contrast >= 3
    && lightScrollTop > 0
    && result.errors.length === 0;

  await browser.close();
  if (!passed) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
