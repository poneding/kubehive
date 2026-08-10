# UI foundation

## Import policy

Import shared primitives directly from `@/components/ui` (or an individual module when that is clearer). Import `cn` from `@/lib/utils`. Do not add compatibility-barrel imports such as `./ui`, and do not create local copies of foundation primitives.

## Tokens and variants

Use the foundation's semantic Tailwind tokens (`background`, `foreground`, `popover`, `border`, `primary`, and `ring`) and the supplied `Button`/`Badge` variants before adding component-specific values. Use `ScrollArea` for every first-party application scroll surface; keep its root responsible for layout sizing and pass legacy scroll-container classes through `viewportClassName`. Keep legacy class hooks when migrating an existing surface; use a narrowly-scoped selector only when its compact visual contract cannot be expressed by tokens. Foundation defaults are canonical, but legacy dialog layouts must explicitly neutralize default grid, padding, width, and positioning utilities.

## This first slice

This slice adds stable checkbox and switch hooks, distinguishes checked from indeterminate checkboxes, and makes dialog overlays configurable. It migrates settings switches, resource/table selection checkboxes, Add Cluster's dialog and connection tabs, Cluster Settings' dialog/inputs, and the column picker Popover/Tooltip/checkboxes.

The ScrollArea follow-up migrates all 22 first-party scroll surfaces: navigation rails, workspace/home content, top and bottom tab rails, settings/about/detail/alert surfaces, comboboxes and filters, bulk actions, logs, data previews, and the file browser. `ScrollArea` supports vertical, horizontal, and dual-axis tracks plus a forwarded viewport ref for existing wheel, sticky, drag, and keyboard behavior. The top resource-tab rail and bottom Sheet-tab rail intentionally set `hideScrollbars`; their hover viewport still maps ordinary wheel and `Shift+wheel` gestures to horizontal scrolling without reserving scrollbar space. Its compact scrollbar keeps a 10px interaction track around a 5px visible thumb and maintains at least 3:1 thumb-to-surface contrast in both application themes.

## Verification

With the Vite development server running, validate the foundation and migrated slice with:

```bash
npm run verify:ui-foundation
npm run verify:scroll-area
```

The foundation check exercises the real Settings and Add Cluster flows, then mounts focused Column Picker, virtual-table selection, and Cluster Settings harnesses. The ScrollArea check recursively audits CSS and TSX, permits only exact CodeMirror/xterm/textarea native-scroll boundaries, maps every documented surface class to an actual `ScrollArea` JSX root, and requires exact root counts and configured axes. A structural overflow/offset matrix exercises all 22 surface class contracts; focused production-component checks separately cover Settings and Column Picker wheel scrolling, long Combobox content, light-theme log contrast, log `scrollIntoView`/keyboard/thumb drag, and `WorkspaceScroll` with a sticky, horizontally pannable `VirtualResourceTable`. Desktop/mobile dark/light checks guard responsive geometry. Both checks capture screenshots under `artifacts/`.

## Intentionally native

CodeMirror's `.cm-scroller`, xterm's `.xterm-viewport`, and native file-editor `textarea` retain their own internal scrolling. Those controls own selection, viewport measurement, terminal rendering, and input behavior; wrapping or replacing their internals would break their supported integration contracts. `verify:scroll-area` treats only these selectors as an allowlist.

## Intentionally legacy

Large operational dialogs, command palette, resource tree filter popover, comboboxes, context menu, sheets, and specialized editors remain legacy in this slice. Their class hooks and behavior are unchanged.

## Next order

1. Migrate remaining dialogs and sheets to `Dialog`.
2. Replace combobox and remaining popover implementations with Radix primitives.
3. Consolidate remaining native inputs and menus, then remove obsolete scoped CSS selectors after visual regression coverage.
