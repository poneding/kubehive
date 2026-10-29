/**
 * Resource tables size their columns the way desktop data grids do: every
 * column owns a comfortable floor, a compact fallback floor, a comfortable
 * target, and a share of whatever room is left over.
 *
 *   Σ compact floors The table's minimum width. Below it the workspace scroller
 *                    pans sideways and cells ellipsize.
 *   floor → ideal    The first room that frees up, weighted so every column
 *                    reaches its comfortable width at the same moment.
 *   beyond ideal     Handed out by `grow`, so Kubernetes identities and object
 *                    references stretch while counters, ratios and ages hold
 *                    their size instead of drifting apart.
 *
 * A column the user has dragged keeps the exact width shown at release: the
 * drag is capped at the widest layout that fits, so releasing never causes a
 * snap. A later viewport or page-zoom change scales the complete saved layout
 * proportionally, keeping the table inside the window whenever its compact
 * floors allow.
 *
 * The compact floors are calibrated so a Pod list's default columns still fit
 * a narrow, high-zoom window. Only when even those floors cannot fit does the
 * workspace scroller take over.
 */
export type ColumnSizing = {
  /** Comfortable floor used while the table has enough room. */
  min: number;
  /** Last-resort floor used only to keep the whole table in the viewport. */
  compactMin: number;
  /** Comfortable width, reached before any column grows past it. */
  ideal: number;
  /** Share of the room beyond every ideal width; 0 holds the column steady. */
  grow: number;
};

const tiers = {
  /** Name/Reason: the column every list is scanned by, and the one that should
   *  still show a full `deployment-7d8f9b6c5d-x2k4m` when the table has room. */
  identity: { min: 164, compactMin: 96, ideal: 340, grow: 4 },
  /** Values that are read, not scanned: messages, selectors, image lists. */
  text: { min: 128, compactMin: 64, ideal: 200, grow: 3 },
  /** Another object's name: namespace, node, controller, claim, chart. */
  reference: { min: 100, compactMin: 56, ideal: 150, grow: 2 },
  /** Badges. The floor holds a short phase such as Running; the widest badge
   *  on screen raises this floor and the comfort width until the table reaches
   *  its compact mode, where exceptional labels may ellipsize (badgeSizing). */
  status: { min: 94, compactMin: 88, ideal: 152, grow: .4 },
  /** Enumerations and versions: type, class, access modes, policies. */
  label: { min: 84, compactMin: 52, ideal: 104, grow: .4 },
  /** Endpoints with a known shape: IPs, host:port pairs, local addresses. */
  address: { min: 104, compactMin: 64, ideal: 132, grow: 0 },
  /** Quantities with units: cpu, memory, capacity, requests/limits. */
  metric: { min: 72, compactMin: 48, ideal: 80, grow: 0 },
  /** Relative timestamps: age, last seen, last schedule. */
  time: { min: 62, compactMin: 44, ideal: 74, grow: 0 },
  /** Counters, ratios and booleans — never worth extra room. */
  count: { min: 60, compactMin: 44, ideal: 68, grow: 0 },
} satisfies Record<string, ColumnSizing>;

export type ColumnSizingTier = keyof typeof tiers;

const columnSizingTiers: Record<ColumnSizingTier, ColumnSizing> = tiers;

/**
 * A Kubernetes column keeps the same shape everywhere it appears, so Age reads
 * the same on Pods as on Ingresses and the eye can move between resource lists
 * without re-learning the layout. Unlisted ids fall back to `label`.
 */
const tierColumnIds: Partial<Record<ColumnSizingTier, string[]>> = {
  identity: ["name"],
  text: ["addresses", "description", "hosts", "image", "images", "kubeconfig", "labels", "message", "nodeSelector", "parameters",
    "podSelector", "policyTypes", "ports", "selector", "server", "subjects", "targets", "volumes"],
  reference: ["apiVersion", "chart", "claim", "controlledBy", "controller", "group", "holder", "kind", "namespace", "node", "object",
    "provisioner", "reference", "repository", "resolvedPod", "role", "storageClass", "target", "volume"],
  status: ["connection", "status"],
  address: ["address", "clusterIp", "externalIp", "ip", "localAddress"],
  metric: ["capacity", "containers", "cpu", "default", "duration", "limits", "max", "memory", "min", "overhead", "requests", "value"],
  time: ["age", "lastSchedule", "lastSeen", "renewTime", "updated"],
  count: ["active", "allowExpansion", "allowedDisruptions", "available", "completions", "count", "current", "data", "desired",
    "globalDefault", "instances", "maxPods", "maxUnavailable", "minAvailable", "minPods", "pods", "privileged", "ready", "replicas",
    "restarts", "revision", "rules", "secrets", "servicePort", "suspend", "targetPort", "upToDate", "versions", "webhooks"],
};

const tierByColumnId = new Map<string, ColumnSizingTier>(
  Object.entries(tierColumnIds).flatMap(([tier, ids]) => (ids ?? []).map((id) => [id, tier as ColumnSizingTier])),
);

export const columnSizingTierFor = (columnId: string): ColumnSizingTier => tierByColumnId.get(columnId) ?? "label";

/** Upper-case 10px header text: latin runs ≈ 6.4px per character, CJK ≈ 11px. */
const wideCharacter = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60]/;

const headerLabelWidth = (label: string) => [...label]
  .reduce((width, character) => width + (wideCharacter.test(character) ? 11 : 6.4), 0);

/** Tiers whose values are shorter than their own header, so the header sets the
 *  comfortable width. They take the tighter cell padding (see .col-* in index.css). */
const tightTiers = new Set<ColumnSizingTier>(["count", "metric", "time"]);

/** Cell padding, the sort arrow, and the room the resize handle overlaps. */
const headerChromeWidth = (tier: ColumnSizingTier) => tightTiers.has(tier) ? 36 : 42;

/** No drag needs to take a column past this; a stored width cannot either. */
export const columnWidthCeiling = 2_400;

export type SizedColumn = {
  id: string;
  label: string;
  /** Overrides the id's shared tier where one table reads differently. */
  size?: ColumnSizingTier | Partial<ColumnSizing>;
};

export function columnSizing(column: SizedColumn): ColumnSizing {
  const tier = typeof column.size === "string" ? column.size : columnSizingTierFor(column.id);
  const base = columnSizingTiers[tier];
  const sizing = column.size && typeof column.size === "object" ? { ...base, ...column.size } : base;
  // Headers are the one piece of table text that must not clip once the table
  // fits, so a long label raises its own column's comfortable width.
  return { ...sizing, ideal: Math.max(sizing.ideal, sizing.min, headerLabelWidth(column.label) + headerChromeWidth(tier)) };
}

/** Font size the status badge renders at, and the pill chrome around its label:
 *  border, padding, status dot and the gap before the text (see .ui-badge). */
const badgeFontSize = 12;
const badgePillChrome = 2 + 14 + 7 + 6;
/** Cell padding on both sides of a status cell (see .resource-table td). */
const badgeCellChrome = 24;
/** Past this a status label buys no more room: it ellipsizes inside its pill
 *  rather than pushing the table wider still. */
const badgeWidthCeiling = 224;

let badgeContext: CanvasRenderingContext2D | null | undefined;
const badgeLabelWidths = new Map<string, number>();

/** Width of a status label at the badge font, measured once per label. */
function badgeLabelWidth(label: string): number {
  const cached = badgeLabelWidths.get(label);
  if (cached !== undefined) return cached;
  if (badgeContext === undefined) {
    badgeContext = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  let width: number;
  if (badgeContext) {
    // The pill inherits the app font, so the measurement must use that family:
    // a canvas default would size every badge for the wrong typeface.
    const family = getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim();
    badgeContext.font = `${badgeFontSize}px ${family || "sans-serif"}`;
    width = badgeContext.measureText(label).width;
  } else {
    // No canvas (unit tests): the latin average at 12px.
    width = label.length * 6.7;
  }
  badgeLabelWidths.set(label, width);
  return width;
}

/**
 * A status column is sized by the cluster, not by its tier: a Pod can read
 * Running for weeks and then sit in CrashLoopBackOff, a label no header or
 * static floor predicted. The widest badge on screen raises the column's floor
 * and comfort width until the pill reads whole; only past the ceiling does the
 * label ellipsize inside the pill, so the table never pans for one status.
 */
export function badgeSizing(sizing: ColumnSizing, labels: Iterable<string>): ColumnSizing {
  let needed = 0;
  for (const label of labels) {
    if (!label) continue;
    needed = Math.max(needed, Math.ceil(badgeLabelWidth(label)) + badgePillChrome + badgeCellChrome);
  }
  needed = Math.min(needed, badgeWidthCeiling);
  if (needed <= sizing.min) return sizing;
  return { ...sizing, min: needed, ideal: Math.max(sizing.ideal, needed) };
}

/** How far a drag may stretch one column, bounded only by legibility. */
export const clampColumnWidth = (sizing: ColumnSizing, width: number, minimum = sizing.min) =>
  Math.round(Math.min(Math.max(width, minimum), columnWidthCeiling));

/**
 * Hands `spare` out in proportion to `weights`, never past `headroom`, and
 * returns the room nothing could take. Pass `unbounded` for a pass that has no
 * ceiling: those columns simply never fill up.
 */
function distribute(widths: number[], weights: number[], headroom: number[], spare: number): number {
  const room = [...headroom];
  let active = widths.map((_, index) => index).filter((index) => weights[index] > 0 && room[index] > .5);
  // Every pass either spends the budget or fills at least one column, so the
  // column count bounds how many passes can run.
  for (let pass = 0; pass < widths.length && spare > .5 && active.length; pass += 1) {
    const weight = active.reduce((total, index) => total + weights[index], 0);
    const budget = spare;
    const unfilled: number[] = [];
    for (const index of active) {
      const share = Math.min(budget * weights[index] / weight, room[index]);
      widths[index] += share;
      room[index] -= share;
      spare -= share;
      if (room[index] > .5) unfilled.push(index);
    }
    active = unfilled;
  }
  return spare;
}

const unbounded = (length: number) => new Array<number>(length).fill(Infinity);

/**
 * Shrinks preferred widths into `available`, preserving their proportions as
 * far as the compact floors allow. When even the compact floors do not fit,
 * the caller renders their sum and lets the workspace pan.
 */
function fitWidths(preferred: number[], floors: number[], available: number): number[] {
  const preferredTotal = preferred.reduce((total, width) => total + width, 0);
  const floorTotal = floors.reduce((total, width) => total + width, 0);
  if (available >= preferredTotal) return [...preferred];
  if (available <= floorTotal) return [...floors];
  const widths = [...floors];
  const headroom = preferred.map((width, index) => Math.max(0, width - floors[index]));
  distribute(widths, headroom, headroom, available - floorTotal);
  return widths;
}

/**
 * Rounds the column edges instead of the widths, so the rendered columns always
 * add up to the width the table was laid out for — a stray half pixel would
 * hand the workspace a horizontal scrollbar for nothing.
 */
function wholePixels(widths: number[]): number[] {
  let edge = 0;
  let exact = 0;
  return widths.map((width) => {
    exact += width;
    const next = Math.round(exact);
    const rounded = next - edge;
    edge = next;
    return rounded;
  });
}

/**
 * Resolves one row of column widths. User-adjusted widths stay exact; automatic
 * columns fit around them down to compact floors. If even that cannot fit, the
 * table keeps its adjusted widths and the workspace pans. Spare room goes to
 * data columns, never to the fixed action column.
 */
export function layoutColumns(sizings: ColumnSizing[], pinned: Array<number | undefined>, available: number, resizeIndex?: number): number[] {
  const preferred = sizings.map((sizing, index) => pinned[index] === undefined
    ? sizing.ideal
    : clampColumnWidth(sizing, pinned[index], sizing.compactMin));
  const compactFloors = sizings.map((sizing) => sizing.compactMin);

  // During a drag the divider must remain under the pointer. Freeze the dragged
  // column and everything to its left, then let the right side absorb the change
  // down to its compact floors.
  if (resizeIndex !== undefined) {
    const locked = sizings.slice(0, resizeIndex + 1).map((sizing, index) =>
      clampColumnWidth(sizing, pinned[index] ?? preferred[index], sizing.compactMin));
    const lockedWidth = locked.reduce((total, width) => total + width, 0);
    const rightSizings = sizings.slice(resizeIndex + 1);
    const rightPreferred = preferred.slice(resizeIndex + 1);
    const rightFloors = compactFloors.slice(resizeIndex + 1);
    let rightWidths = fitWidths(rightPreferred, rightFloors, Math.max(0, available - lockedWidth));
    const rightAvailable = available - lockedWidth;
    let spare = rightAvailable - rightWidths.reduce((total, width) => total + width, 0);
    if (spare > .5) {
      const wanted = rightSizings.map((sizing, index) => Math.max(0, sizing.ideal - rightWidths[index]));
      spare = distribute(rightWidths, wanted, wanted, spare);
      distribute(rightWidths, rightSizings.map((sizing) => sizing.grow), unbounded(rightSizings.length), spare);
    }
    return wholePixels([...locked, ...rightWidths]);
  }

  // Once a drag has saved every visible width, resize the complete layout as
  // one proportional system. The release itself happens at the current window
  // width, so this is identical to what the user saw; a later window or zoom
  // change scales every column instead of letting their total overflow.
  if (pinned.length > 0 && pinned.every((width) => width !== undefined)) {
    const widths = fitWidths(preferred, compactFloors, available);
    const spare = available - widths.reduce((total, width) => total + width, 0);
    if (spare > .5) distribute(widths, widths, unbounded(widths.length), spare);
    return wholePixels(widths);
  }

  // A stored width is only ever a starting point: clamping it here keeps one
  // bad localStorage entry from becoming an unreadable column.
  const widths = sizings.map((sizing, index) => pinned[index] === undefined ? sizing.min : clampColumnWidth(sizing, pinned[index], sizing.compactMin));
  const adapts = (index: number) => pinned[index] === undefined;
  let spare = available - widths.reduce((total, width) => total + width, 0);
  if (spare <= .5) {
    // A user-adjusted width is a hard constraint. Let automatic columns absorb
    // the shortfall first; if they reach their compact floors and still do not
    // fit, keep the adjusted width and let the workspace pan rather than moving
    // the edge the user just chose.
    const locked = sizings.map((sizing, index) => pinned[index] === undefined ? undefined : clampColumnWidth(sizing, pinned[index], sizing.compactMin));
    const lockedWidth = locked.reduce<number>((total, width) => total + (width ?? 0), 0);
    const automaticSizings = sizings.filter((_, index) => locked[index] === undefined);
    const automaticPreferred = preferred.filter((_, index) => locked[index] === undefined);
    const automaticFloors = compactFloors.filter((_, index) => locked[index] === undefined);
    const automaticAvailable = available - lockedWidth;
    let automaticWidths = fitWidths(automaticPreferred, automaticFloors, Math.max(0, automaticAvailable));
    let automaticSpare = automaticAvailable - automaticWidths.reduce((total, width) => total + width, 0);
    if (automaticSpare > .5) {
      const wanted = automaticSizings.map((sizing, index) => Math.max(0, sizing.ideal - automaticWidths[index]));
      automaticSpare = distribute(automaticWidths, wanted, wanted, automaticSpare);
      automaticSpare = distribute(automaticWidths, automaticSizings.map((sizing) => sizing.grow), unbounded(automaticSizings.length), automaticSpare);
      if (automaticSpare > .5 && automaticWidths.length) distribute(automaticWidths, automaticWidths, unbounded(automaticWidths.length), automaticSpare);
    }
    let automaticIndex = 0;
    const resolved = sizings.map((_, index) => locked[index] ?? automaticWidths[automaticIndex++]);
    // With every visible column explicitly sized there is no automatic column
    // to absorb extra room. Grow only the final data column so every earlier
    // user-adjusted edge remains exactly where it was placed.
    const extra = available - resolved.reduce((total, width) => total + width, 0);
    if (extra > .5 && automaticSizings.length === 0 && resolved.length) resolved[resolved.length - 1] += extra;
    return wholePixels(resolved);
  }
  if (spare > .5) {
    // Weighting the first pass by the room each column still wants lands them
    // all on their comfortable width together, so a mid-size window reads as
    // deliberate rather than uniformly stretched.
    const wanted = sizings.map((sizing, index) => adapts(index) ? Math.max(0, sizing.ideal - widths[index]) : 0);
    spare = distribute(widths, wanted, wanted, spare);
    spare = distribute(widths, sizings.map((sizing, index) => adapts(index) ? sizing.grow : 0), unbounded(widths.length), spare);
    if (spare > .5) {
      // Room the growth weights left over. Automatic columns take it by their
      // comfortable size. Once every visible column has a user width, only the
      // final column grows; earlier adjusted edges must not move when the window
      // gets wider.
      const adapting = sizings.some((_, index) => adapts(index));
      if (adapting) {
        const fill = sizings.map((sizing, index) => adapts(index) ? sizing.ideal : 0);
        distribute(widths, fill, unbounded(widths.length), spare);
      } else if (widths.length) {
        widths[widths.length - 1] += spare;
      }
    }
  }
  return wholePixels(widths);
}

export type TableColumnWidths = Record<string, number>;

const columnWidthsStorageKey = (tableKey: string) => `kubehive.tableColumnWidths.${tableKey}`;

export function loadColumnWidths(tableKey: string): TableColumnWidths {
  try {
    const saved = JSON.parse(localStorage.getItem(columnWidthsStorageKey(tableKey)) ?? "null") as unknown;
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([, width]) => typeof width === "number" && Number.isFinite(width) && width > 0));
  } catch {
    return {};
  }
}

export function saveColumnWidths(tableKey: string, widths: TableColumnWidths) {
  try {
    if (Object.keys(widths).length) localStorage.setItem(columnWidthsStorageKey(tableKey), JSON.stringify(widths));
    else localStorage.removeItem(columnWidthsStorageKey(tableKey));
  } catch {
    // Resizing still works for the current session when storage is unavailable.
  }
}

/**
 * Width the table may occupy before the workspace scroller has to pan
 * sideways. Measured from the enclosing scrollport — or the nearest ancestor
 * with a width cap, whose own box stays put however wide the table grows —
 * minus every inset between it and the table, so the layout needs no magic
 * pixel constants. The table's own ancestors cannot be measured directly:
 * they grow with the table to keep the toolbar and header aligned with it.
 */
export function measureAvailableWidth(wrap: HTMLElement, scrollport: HTMLElement | null): number {
  const px = (value: string) => Number.parseFloat(value) || 0;
  let inset = 0;
  for (let node: HTMLElement | null = wrap; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const padding = px(style.paddingLeft) + px(style.paddingRight);
    if (node === scrollport || style.maxWidth.endsWith("px") || !node.parentElement) return Math.max(0, Math.floor(node.clientWidth - padding - inset));
    inset += padding + px(style.borderLeftWidth) + px(style.borderRightWidth) + px(style.marginLeft) + px(style.marginRight);
  }
  return 0;
}
