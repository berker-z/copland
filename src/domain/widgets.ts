/* ============================================================================
   The widget registry: every pane on the dashboard and every item in the
   statusline, as data. Plain TypeScript, because the Worker validates the
   `dashboard` setting against these ids; which component draws each one is
   the browser's half, in src/app/widgets.tsx.

   Order matters: panes are listed column by column, top to bottom, which is
   where a pane goes when it is turned on; statusline items are listed left
   to right, which is where they sit in the bar.
   ========================================================================== */

export const PANE_IDS = ["calendar", "agenda", "notepad", "tasks", "boards", "inbox", "markets"] as const;
export const TOPBAR_IDS = ["weather", "moon", "clock", "inbox-badge"] as const;

export type PaneId = (typeof PANE_IDS)[number];
export type TopbarId = (typeof TOPBAR_IDS)[number];

/** The dashboard's columns on a wide screen. Below lg they are one. */
export const COLUMNS = 3;

interface WidgetBase {
  name: string;
  /** One line for settings: what it shows. */
  description: string;
  /** On for someone who has not chosen. */
  defaultOn: boolean;
  /** Always on: there is no switch for it. */
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
  /** Which column it goes in when turned on. */
  column: number;
  /** Its place in the one-column phone layout: what a phone is opened for first. */
  phoneOrder: number;
}

export interface TopbarSpec extends WidgetBase {
  id: TopbarId;
  /** An icon button, at the right end with settings and logout, rather than a readout. */
  icon?: boolean;
  /** Below sm the bar has no room: it moves into the ⋯ menu instead. */
  phoneMenu?: boolean;
}

export const PANES: PaneSpec[] = [
  { id: "calendar", name: "calendar", description: "The month, with your calendars' events.", defaultOn: true, column: 0, phoneOrder: 5 },
  { id: "agenda", name: "agenda", description: "Today's events, and a line where now is.", defaultOn: true, column: 0, phoneOrder: 1 },
  { id: "notepad", name: "notepad", description: "Notes that save as you type.", defaultOn: true, column: 0, phoneOrder: 6 },
  { id: "tasks", name: "tasks", description: "Your work across boards.", defaultOn: true, column: 1, phoneOrder: 2 },
  { id: "boards", name: "boards", description: "Every board you are on, and a way to make one.", defaultOn: true, required: true, column: 1, phoneOrder: 4 },
  { id: "inbox", name: "inbox", description: "Tasks given to you, mentions and comments.", defaultOn: true, column: 1, phoneOrder: 3 },
  {
    id: "markets",
    name: "markets",
    description: "Crypto prices from Binance; market caps and NFT floors with a CoinGecko key.",
    defaultOn: false,
    enhancedBy: "coingecko",
    column: 2,
    phoneOrder: 7,
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
 * The `dashboard` setting. What is listed is on; what is not is off. Panes
 * are kept as columns, top to bottom, so moving and reordering them later
 * changes this shape's contents, not the shape.
 */
export interface DashboardLayout {
  columns: PaneId[][];
  topbar: TopbarId[];
}

export const DEFAULT_LAYOUT: DashboardLayout = {
  columns: Array.from({ length: COLUMNS }, (_, i) => PANES.filter((p) => p.defaultOn && p.column === i).map((p) => p.id)),
  topbar: TOPBAR.filter((t) => t.defaultOn).map((t) => t.id),
};

const isPaneId = (id: unknown): id is PaneId => PANE_IDS.includes(id as PaneId);
const isTopbarId = (id: unknown): id is TopbarId => TOPBAR_IDS.includes(id as TopbarId);

/** A layout as sent, or null. Unknown and repeated ids are refused; a required widget left out is put back. */
export function parseLayout(raw: unknown): DashboardLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const { columns, topbar } = raw as Record<string, unknown>;
  if (!Array.isArray(columns) || columns.length !== COLUMNS) return null;
  if (!columns.every((c) => Array.isArray(c) && c.every(isPaneId))) return null;
  if (!Array.isArray(topbar) || !topbar.every(isTopbarId)) return null;
  const panes = (columns as PaneId[][]).flat();
  if (new Set(panes).size !== panes.length || new Set(topbar).size !== topbar.length) return null;

  const layout: DashboardLayout = { columns: (columns as PaneId[][]).map((c) => [...c]), topbar: [...(topbar as TopbarId[])] };
  for (const p of PANES) if (p.required && !panes.includes(p.id)) layout.columns[p.column].push(p.id);
  for (const t of TOPBAR) if (t.required && !layout.topbar.includes(t.id)) layout.topbar.push(t.id);
  return layout;
}

export const paneOn = (layout: DashboardLayout, id: PaneId) => layout.columns.some((c) => c.includes(id));
export const topbarOn = (layout: DashboardLayout, id: TopbarId) => layout.topbar.includes(id);

/** The layout with one widget switched on (at the end of its column) or off. */
export function toggleWidget(layout: DashboardLayout, id: PaneId | TopbarId, on: boolean): DashboardLayout {
  if (isPaneId(id)) {
    const columns = layout.columns.map((c) => c.filter((p) => p !== id));
    if (on) columns[paneSpec(id).column].push(id);
    return { ...layout, columns };
  }
  const topbar = layout.topbar.filter((t) => t !== id);
  return { ...layout, topbar: on ? [...topbar, id] : topbar };
}

/** Whether what a widget requires is set. */
export function requirementMet(spec: WidgetBase, settings: { location: unknown }): boolean {
  return spec.requires !== "location" || settings.location !== null;
}
