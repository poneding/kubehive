/**
 * Resource tables size their columns the way desktop data grids do: every
 * column owns a hard floor, a comfortable target, and a share of whatever room
 * is left over.
 *
 *   Σ floors         The table's minimum width. Below it the workspace
 *                    scroller pans sideways and cells ellipsize — a squeezed
 *                    kubectl column is worse than a scrollbar.
 *   floor → ideal    The first room that frees up, weighted so every column
 *                    reaches its comfortable width at the same moment.
 *   beyond ideal     Handed out by `grow`, so Kubernetes identities and object
 *                    references stretch while counters, ratios and ages hold
 *                    their size instead of drifting apart.
 *
 * A column the user has dragged is pinned to that exact pixel width and drops
 * out of the distribution; every other column keeps adapting around it.
 *
 * The floors are calibrated so a resource list's default columns still fit a
 * 1200px window beside the resource navigation — the widest window that has to
 * scroll sideways is the one the tiers below are answering for.
 */
export type ColumnSizing = {
  /** Hard floor. Content ellipsizes rather than pushing the column wider. */
  min: number;
  /** Comfortable width, reached before any column grows past it. */
  ideal: number;
  /** Share of the room beyond every ideal width; 0 holds the column steady. */
  grow: number;
};

const tiers = {
  /** Name/Reason: the column every list is scanned by, and the one that should
   *  still show a full `deployment-7d8f9b6c5d-x2k4m` when the table has room. */
  identity: { min: 164, ideal: 340, grow: 4 },
  /** Values that are read, not scanned: messages, selectors, image lists. */
  text: { min: 128, ideal: 200, grow: 3 },
  /** Another object's name: namespace, node, controller, claim, chart. */
  reference: { min: 100, ideal: 150, grow: 2 },
  /** Badges, sized for the longest kubectl phase (ContainerCreating). */
  status: { min: 94, ideal: 152, grow: .4 },
  /** Enumerations and versions: type, class, access modes, policies. */
  label: { min: 84, ideal: 104, grow: .4 },
  /** Endpoints with a known shape: IPs, host:port pairs, local addresses. */
  address: { min: 104, ideal: 132, grow: 0 },
  /** Quantities with units: cpu, memory, capacity, requests/limits. */
  metric: { min: 72, ideal: 80, grow: 0 },
  /** Relative timestamps: age, last seen, last schedule. */
  time: { min: 62, ideal: 74, grow: 0 },
  /** Counters, ratios and booleans — never worth extra room. */
  count: { min: 60, ideal: 68, grow: 0 },
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

/** How far a drag may stretch one column, bounded only by legibility. */
export const clampColumnWidth = (sizing: ColumnSizing, width: number) =>
  Math.round(Math.min(Math.max(width, sizing.min), columnWidthCeiling));

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
 * Resolves one row of column widths. Their sum is the width the table renders
 * at, and it is always `max(available, Σ floors)` — where a column the user has
 * pinned contributes that pinned width as its floor. Above the floor a table
 * shows every column inside the window and cells ellipsize; below it the table
 * holds the floor and the workspace pans. Spare room goes to a data column,
 * never to the action column, which stays exactly as wide as its buttons.
 */
export function layoutColumns(sizings: ColumnSizing[], pinned: Array<number | undefined>, available: number): number[] {
  // A stored width is only ever a starting point: clamping it here keeps one
  // bad localStorage entry from becoming an unreadable column.
  const widths = sizings.map((sizing, index) => pinned[index] === undefined ? sizing.min : clampColumnWidth(sizing, pinned[index]));
  const adapts = (index: number) => pinned[index] === undefined;
  let spare = available - widths.reduce((total, width) => total + width, 0);
  if (spare > .5) {
    // Weighting the first pass by the room each column still wants lands them
    // all on their comfortable width together, so a mid-size window reads as
    // deliberate rather than uniformly stretched.
    const wanted = sizings.map((sizing, index) => adapts(index) ? Math.max(0, sizing.ideal - widths[index]) : 0);
    spare = distribute(widths, wanted, wanted, spare);
    spare = distribute(widths, sizings.map((sizing, index) => adapts(index) ? sizing.grow : 0), unbounded(widths.length), spare);
    if (spare > .5) {
      // Room the growth weights left over — every growing column is pinned, so
      // the remaining automatic columns take it by their comfortable size.
      // Hiding a column or restoring old settings can leave every visible
      // column pinned. Only the last column (which has no resize handle) may
      // then fill the panel: distributing to pinned columns would enlarge the
      // dragged width again and jump its edge away from the pointer.
      const adapting = sizings.some((_, index) => adapts(index));
      const fill = sizings.map((sizing, index) => adapting ? (adapts(index) ? sizing.ideal : 0) : (index === sizings.length - 1 ? 1 : 0));
      distribute(widths, fill, unbounded(widths.length), spare);
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
