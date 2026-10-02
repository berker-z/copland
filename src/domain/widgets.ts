/* ============================================================================
   The widget registry: every pane on the dashboard and every item in the
   statusline, as data. Plain TypeScript, because the Worker validates the
   `dashboard` setting against these ids; which component draws each one is
   the browser's half, in src/app/widgets.tsx.

   Where things go is the setting's business, not the registry's: the
   `dashboard` setting lists the columns (one to three, as many as the person
   chose) and the panes in each, top to bottom, and the statusline items left
   to right. The dashboard draws exactly that. A phone reads the columns left
   to right, one after the other.
   ========================================================================== */

export const PANE_IDS = ["calendar", "agenda", "notepad", "tasks", "boards", "inbox", "markets"] as const;
export const TOPBAR_IDS = ["weather", "moon", "clock", "inbox-badge"] as const;

export type PaneId = (typeof PANE_IDS)[number];
export type TopbarId = (typeof TOPBAR_IDS)[number];

/** How many columns the dashboard can have on a wide screen. Below lg they are one. */
export const MIN_COLUMNS = 1;
export const MAX_COLUMNS = 3;

interface WidgetBase {
  name: string;
  /** One line for settings: what it shows. */
  description: string;
  /** On for someone who has not chosen. */
  defaultOn: boolean;
  /** Always on: it can be moved but not switched off. */
  required?: boolean;
  /**
   * A setting it cannot work without. Settings will not turn it on before
   * the setting is there, and the Worker refuses a layout that has it on
   * without one.
   */
  requires?: "location";
  /** A service key that adds to it but is not needed (settings › keys). */
  enhancedBy?: "coingecko";
}

export interface PaneSpec extends WidgetBase {
  id: PaneId;
}

export interface TopbarSpec extends WidgetBase {
  id: TopbarId;
  /** An icon button, at the right end with settings and logout, rather than a readout. */
  icon?: boolean;
  /** Below sm the bar has no room: it moves into the ⋯ menu instead. */
  phoneMenu?: boolean;
}

export const PANES: PaneSpec[] = [
  { id: "calendar", name: "calendar", description: "The month, with your calendars' events.", defaultOn: true },
  { id: "agenda", name: "agenda", description: "Today's events, and a line where now is.", defaultOn: true },
  { id: "notepad", name: "notepad", description: "Notes that save as you type.", defaultOn: true },
  { id: "tasks", name: "tasks", description: "Your work across boards.", defaultOn: true },
  { id: "boards", name: "boards", description: "Every board you are on, and a way to make one.", defaultOn: true, required: true },
  { id: "inbox", name: "inbox", description: "Tasks given to you, mentions and comments.", defaultOn: true },
  {
    id: "markets",
    name: "markets",
    description: "Crypto prices from Binance; market caps and NFT floors with a CoinGecko key.",
    defaultOn: false,
    enhancedBy: "coingecko",
  },
];

export const TOPBAR: TopbarSpec[] = [
  { id: "weather", name: "weather", description: "The temperature where you are, from Open-Meteo.", defaultOn: false, requires: "location" },
  { id: "moon", name: "moon", description: "Tonight's moon phase.", defaultOn: false, phoneMenu: true },
  { id: "clock", name: "clock", description: "The date and time.", defaultOn: true, required: true },
  { id: "inbox-badge", name: "inbox", description: "Unread inbox items, on every screen.", defaultOn: true, required: true, icon: true },
];

export const paneSpec = (id: PaneId) => PANES.find((p) => p.id === id)!;
export const topbarSpec = (id: TopbarId) => TOPBAR.find((t) => t.id === id)!;

/**
 * The `dashboard` setting. What is listed is on; what is not is off.
 * `columns` has as many entries as the dashboard has columns (MIN_COLUMNS
 * to MAX_COLUMNS), each the panes in it, top to bottom; a column can be
 * empty, and still takes its width. `topbar` is the statusline, left to
 * right.
 */
export interface DashboardLayout {
  columns: PaneId[][];
  topbar: TopbarId[];
}

export const DEFAULT_LAYOUT: DashboardLayout = {
  columns: [
    ["calendar", "agenda", "notepad"],
    ["tasks", "boards", "inbox"],
  ],
  topbar: TOPBAR.filter((t) => t.defaultOn).map((t) => t.id),
};

export const isPaneId = (id: unknown): id is PaneId => PANE_IDS.includes(id as PaneId);
export const isTopbarId = (id: unknown): id is TopbarId => TOPBAR_IDS.includes(id as TopbarId);

/**
 * Where a pane goes when it is switched on without being placed (a click
 * rather than a drop): the end of the shortest column, the rightmost of
 * equally short ones.
 */
export function landingColumn(columns: PaneId[][]): number {
  let best = 0;
  columns.forEach((c, i) => {
    if (c.length <= columns[best].length) best = i;
  });
  return best;
}

/**
 * A layout as sent, or null. Unknown and repeated ids are refused; a
 * required widget left out is put back. Layouts saved before the column
 * count was a choice always had three columns, some maybe empty; they are
 * the same shape and keep their three.
 */
export function parseLayout(raw: unknown): DashboardLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const { columns, topbar } = raw as Record<string, unknown>;
  if (!Array.isArray(columns) || columns.length < MIN_COLUMNS || columns.length > MAX_COLUMNS) return null;
  if (!columns.every((c) => Array.isArray(c) && c.every(isPaneId))) return null;
  if (!Array.isArray(topbar) || !topbar.every(isTopbarId)) return null;
  const panes = (columns as PaneId[][]).flat();
  if (new Set(panes).size !== panes.length || new Set(topbar).size !== topbar.length) return null;

  const layout: DashboardLayout = { columns: (columns as PaneId[][]).map((c) => [...c]), topbar: [...(topbar as TopbarId[])] };
  for (const p of PANES) if (p.required && !panes.includes(p.id)) layout.columns[landingColumn(layout.columns)].push(p.id);
  for (const t of TOPBAR) if (t.required && !layout.topbar.includes(t.id)) layout.topbar.push(t.id);
  return layout;
}

export const paneOn = (layout: DashboardLayout, id: PaneId) => layout.columns.some((c) => c.includes(id));
export const topbarOn = (layout: DashboardLayout, id: TopbarId) => layout.topbar.includes(id);

/** The panes in the order a phone shows them: the columns read left to right. */
export const phoneOrder = (layout: DashboardLayout): PaneId[] => layout.columns.flat();

/** The statusline's readouts (what can be reordered) and its icon buttons, each in order. */
export function topbarParts(layout: DashboardLayout): { readouts: TopbarId[]; icons: TopbarId[] } {
  return {
    readouts: layout.topbar.filter((id) => !topbarSpec(id).icon),
    icons: layout.topbar.filter((id) => topbarSpec(id).icon),
  };
}

/**
 * The layout with one widget switched on or off. A pane switched on lands
 * at the end of landingColumn, a statusline item at the end of the bar. A
 * required widget is never switched off.
 */
export function toggleWidget(layout: DashboardLayout, id: PaneId | TopbarId, on: boolean): DashboardLayout {
  if (isPaneId(id)) {
    if (paneOn(layout, id) === on || (!on && paneSpec(id).required)) return layout;
    const columns = layout.columns.map((c) => c.filter((p) => p !== id));
    if (on) columns[landingColumn(columns)].push(id);
    return { ...layout, columns };
  }
  if (topbarOn(layout, id) === on || (!on && topbarSpec(id).required)) return layout;
  const topbar = layout.topbar.filter((t) => t !== id);
  return { ...layout, topbar: on ? [...topbar, id] : topbar };
}

/** The layout with a pane put at `index` in `column`, from wherever it was (or off). */
export function movePane(layout: DashboardLayout, id: PaneId, column: number, index: number): DashboardLayout {
  const columns = layout.columns.map((c) => c.filter((p) => p !== id));
  const target = columns[Math.max(0, Math.min(column, columns.length - 1))];
  target.splice(Math.max(0, Math.min(index, target.length)), 0, id);
  return { ...layout, columns };
}

/**
 * The layout with a statusline readout put at `index` among the readouts,
 * from wherever it was (or off). Icon buttons keep their own end of the bar.
 */
export function moveTopbar(layout: DashboardLayout, id: TopbarId, index: number): DashboardLayout {
  const { readouts, icons } = topbarParts(layout);
  const rest = readouts.filter((t) => t !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return { ...layout, topbar: [...rest, ...icons.filter((t) => t !== id)] };
}

/**
 * The layout with `count` columns. New ones start empty; the panes of
 * columns taken away move, in order, to the end of the last one kept.
 */
export function withColumnCount(layout: DashboardLayout, count: number): DashboardLayout {
  const n = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, count));
  const columns = layout.columns.slice(0, n).map((c) => [...c]);
  while (columns.length < n) columns.push([]);
  columns[n - 1].push(...layout.columns.slice(n).flat());
  return { ...layout, columns };
}

/** Whether what a widget requires is set. */
export function requirementMet(spec: WidgetBase, settings: { location: unknown }): boolean {
  return spec.requires !== "location" || settings.location !== null;
}
