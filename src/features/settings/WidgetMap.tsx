/* ============================================================================
   Settings › widgets: the map of the dashboard.
   ----------------------------------------------------------------------------
   A small copy of the screen: the statusline along the top, the columns as
   lanes under it, every pane a block in its lane. What is off waits in the
   tray below. Drag a block to reorder it or move it to another lane, from
   the tray to switch it on, to the tray to switch it off. The dashboard
   draws exactly what the map shows, column count and empty columns
   included (domain/widgets.ts has the shape).

   Dragging is pointer events, not HTML5 drag and drop and not a library:
   one code path for a mouse and a finger (HTML5 drag never fires on a
   touchscreen), a ghost that follows the pointer instead of the browser's
   snapshot, and nothing added to the bundle. While a block is dragged the
   map is drawn as if it had already been dropped where the pointer is, so
   the drop indicator is the gap the block would fill; blocks glide to their
   new places (a FLIP transition) unless reduced motion is asked for.

   A mouse drags a block from anywhere on it, a finger from its grip, so the
   page still scrolls under a finger elsewhere. Without dragging at all:
   every block is focusable, arrow keys move it, Delete switches it off,
   Enter switches a tray block on, and the ⋯ menu on each block does the
   same by tap. Required widgets move but never leave (a lock, no "off").

   The weather needs a place: dropping it in, or switching it on, without
   one asks for the place under the statusline, and picking one saves both.
   ========================================================================== */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Bell, Clock, GripVertical, LayoutDashboard, Lock, LogOut, MoreHorizontal, Plus, Settings as SettingsIcon, Sun } from "lucide-react";
import { DEFAULT_SETTINGS, type Settings } from "@/domain/settings";
import {
  MAX_COLUMNS,
  MIN_COLUMNS,
  PANES,
  TOPBAR,
  moveTopbar,
  movePane,
  paneOn,
  paneSpec,
  phoneOrder,
  requirementMet,
  toggleWidget,
  topbarOn,
  topbarParts,
  topbarSpec,
  withColumnCount,
  type DashboardLayout,
  type PaneId,
  type TopbarId,
} from "@/domain/widgets";
import { formatDate, useMoon } from "@/features/shell/topbar";
import { searchCities, type GeoResult } from "@/features/shell/weather";
import { useSettings } from "@/lib/queries";
import { useUpdateSettings } from "@/lib/settings";
import { LogoMark } from "@/ui/LogoMark";
import { MoonPhaseIcon } from "@/ui/MoonPhaseIcon";
import { useDismiss } from "@/ui/useDismiss";
import { input } from "./Section";

/* ------------------------------------------------------------ city search -- */

/**
 * Pick a place by name. Open-Meteo's geocoder turns what is typed into
 * candidates; choosing one hands its name and coordinates to `onPick`.
 */
function CityPicker({ onPick, autoFocus }: { onPick: (place: GeoResult) => void; autoFocus?: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Search as you type, once typing pauses; a newer search cancels the one
     in flight so results never arrive out of order. */
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      searchCities(q, controller.signal)
        .then((found) => {
          setResults(found);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Search failed");
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <div>
      <input
        className={`${input} w-full`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search a city"
        maxLength={80}
        aria-label="Search a city"
        autoFocus={autoFocus}
      />
      {searching && <p className="text-xs text-muted mt-2 animate-pulse">searching…</p>}
      {results && !searching && results.length === 0 && <p className="text-xs text-faint mt-2">no match</p>}
      {results && results.length > 0 && (
        <ul className="mt-2">
          {results.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => {
                  onPick(r);
                  setQuery("");
                  setResults(null);
                }}
                className="w-full flex items-baseline gap-2 px-2 py-2 text-left border-b border-divider last:border-b-0 hover:bg-raised transition-colors"
              >
                <span className="text-bright">{r.name}</span>
                <span className="text-xs text-muted truncate">{r.detail}</span>
                <span className="ml-auto text-xs text-faint tabular-nums shrink-0">
                  {r.latitude.toFixed(2)}, {r.longitude.toFixed(2)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-red text-xs mt-2">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------ the model -- */

type Item = { kind: "pane"; id: PaneId } | { kind: "topbar"; id: TopbarId };
/** Where a block can be dropped: a place in a lane, a place among the statusline's readouts, or the tray. */
type Spot = { zone: "lane"; column: number; index: number } | { zone: "strip"; index: number } | { zone: "tray" };

const specOf = (item: Item) => (item.kind === "pane" ? paneSpec(item.id) : topbarSpec(item.id));
const sameItem = (a: Item | null | undefined, b: Item) => !!a && a.kind === b.kind && a.id === b.id;
const sameLayout = (a: DashboardLayout, b: DashboardLayout) => JSON.stringify(a) === JSON.stringify(b);

/** Where an item is now. */
function spotOf(layout: DashboardLayout, item: Item): Spot {
  if (item.kind === "pane") {
    const column = layout.columns.findIndex((c) => c.includes(item.id));
    if (column >= 0) return { zone: "lane", column, index: layout.columns[column].indexOf(item.id) };
  } else {
    const index = topbarParts(layout).readouts.indexOf(item.id);
    if (index >= 0) return { zone: "strip", index };
  }
  return { zone: "tray" };
}

/** The layout with an item put at a spot, or null when it cannot go there. */
function place(layout: DashboardLayout, item: Item, spot: Spot): DashboardLayout | null {
  if (spot.zone === "tray") return specOf(item).required ? null : toggleWidget(layout, item.id, false);
  if (item.kind === "pane" && spot.zone === "lane") return movePane(layout, item.id, spot.column, spot.index);
  if (item.kind === "topbar" && spot.zone === "strip" && !topbarSpec(item.id).icon) return moveTopbar(layout, item.id, spot.index);
  return null;
}

interface Action {
  label: string;
  /** The key that does it on a focused block. */
  keys: string[];
  /** Words for the screen reader once done. */
  said: string;
  to: (layout: DashboardLayout) => DashboardLayout;
}

/** What can be done to an item where it is, for its ⋯ menu and its keys. */
function actionsFor(layout: DashboardLayout, item: Item): Action[] {
  const at = spotOf(layout, item);
  const spec = specOf(item);
  const out: Action[] = [];
  const move = (label: string, keys: string[], spot: Spot, said: string) =>
    out.push({ label, keys, said, to: (l) => place(l, item, spot) ?? l });

  if (at.zone === "lane") {
    const length = layout.columns[at.column].length;
    const count = layout.columns.length;
    if (at.index > 0) move("move up", ["ArrowUp"], { ...at, index: at.index - 1 }, `${spec.name} moved up`);
    if (at.index < length - 1) move("move down", ["ArrowDown"], { ...at, index: at.index + 1 }, `${spec.name} moved down`);
    if (at.column > 0)
      move("move left", ["ArrowLeft"], { zone: "lane", column: at.column - 1, index: at.index }, `${spec.name} moved to column ${at.column}`);
    if (at.column < count - 1)
      move("move right", ["ArrowRight"], { zone: "lane", column: at.column + 1, index: at.index }, `${spec.name} moved to column ${at.column + 2}`);
  } else if (at.zone === "strip") {
    const length = topbarParts(layout).readouts.length;
    if (at.index > 0) move("move left", ["ArrowLeft", "ArrowUp"], { zone: "strip", index: at.index - 1 }, `${spec.name} moved left`);
    if (at.index < length - 1) move("move right", ["ArrowRight", "ArrowDown"], { zone: "strip", index: at.index + 1 }, `${spec.name} moved right`);
  }
  if (at.zone === "tray") {
    out.push({ label: "switch on", keys: ["Enter", " "], said: `${spec.name} switched on`, to: (l) => toggleWidget(l, item.id, true) });
  } else if (!spec.required) {
    out.push({ label: "switch off", keys: ["Delete", "Backspace"], said: `${spec.name} switched off`, to: (l) => toggleWidget(l, item.id, false) });
  }
  return out;
}

/** The first widget the layout has on without what it needs (the weather without a place). */
function missingRequirement(layout: DashboardLayout, settings: Settings) {
  return TOPBAR.find((t) => topbarOn(layout, t.id) && !requirementMet(t, settings)) ?? null;
}

/* ------------------------------------------------------------- dragging -- */

interface Drag {
  item: Item;
  /** The pointer. */
  x: number;
  y: number;
  over: Spot | null;
  /** Over the tray with something that is always on. */
  refused: boolean;
}

/** The block as it looked when picked up, drawn under the pointer. */
interface Ghost {
  html: string;
  className: string;
  grabX: number;
  grabY: number;
  width: number;
  height: number;
}

const THRESHOLD = 4;
type Rests = Map<string, DOMRect>;

/** Where every block sits, relative to the map, with no glide in flight. */
function measure(root: HTMLElement): Rests {
  const origin = root.getBoundingClientRect();
  const rests: Rests = new Map();
  for (const block of root.querySelectorAll<HTMLElement>("[data-block]")) {
    const r = block.getBoundingClientRect();
    rests.set(block.dataset.block!, new DOMRect(r.x - origin.left, r.y - origin.top, r.width, r.height));
  }
  return rests;
}

/**
 * Where the pointer would drop the item, from the blocks' resting places
 * (measured after each change) rather than live rects, which are mid-glide
 * while the FLIP transition runs. A pane over the lanes goes to the lane
 * under it sideways, so dropping below a short column's last pane works.
 */
function spotAt(root: HTMLElement, rests: Rests, item: Item, x: number, y: number): Spot | "refused" | null {
  const inside = (r: DOMRect, pad = 0) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  const origin = root.getBoundingClientRect();
  const rest = (el: HTMLElement) => {
    const r = rests.get(el.dataset.block!);
    return r ? new DOMRect(r.x + origin.left, r.y + origin.top, r.width, r.height) : el.getBoundingClientRect();
  };
  const others = (zone: Element) =>
    [...zone.querySelectorAll<HTMLElement>("[data-block]")].filter((el) => el.dataset.block !== `${item.kind}:${item.id}`).map(rest);

  const tray = root.querySelector<HTMLElement>("[data-tray]");
  if (tray && inside(tray.getBoundingClientRect(), 8)) return specOf(item).required ? "refused" : { zone: "tray" };

  if (item.kind === "pane") {
    const lanes = root.querySelector<HTMLElement>("[data-lanes]");
    if (!lanes || !inside(lanes.getBoundingClientRect(), 16)) return null;
    const all = [...lanes.querySelectorAll<HTMLElement>("[data-lane]")];
    const lane =
      all.find((l) => {
        const r = l.getBoundingClientRect();
        return x >= r.left - 4 && x <= r.right + 4;
      }) ?? (x < lanes.getBoundingClientRect().left + 1 ? all[0] : all[all.length - 1]);
    const index = others(lane).filter((r) => r.top + r.height / 2 < y).length;
    return { zone: "lane", column: Number(lane.dataset.lane), index };
  }
  const strip = root.querySelector<HTMLElement>("[data-strip]");
  if (strip && inside(strip.getBoundingClientRect(), 16)) {
    const readouts = root.querySelector<HTMLElement>("[data-readouts]")!;
    /* On a narrow screen the readouts wrap: rows above come first, then this row by x. */
    const index = others(readouts).filter((r) => r.bottom < y || (r.top <= y && r.left + r.width / 2 < x)).length;
    return { zone: "strip", index };
  }
  return null;
}

/**
 * Glide blocks from where they were drawn to where they are now (FLIP), and
 * remember where they rest. Runs only when the arrangement changes, so a
 * pointer move that changes nothing leaves a glide in flight alone; a block
 * caught mid-glide starts its next one from where it is on screen.
 */
function useGlide(root: React.RefObject<HTMLElement | null>, rests: React.RefObject<Rests>, arrangement: string) {
  const seen = useRef(new WeakSet<HTMLElement>());
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const origin = el.getBoundingClientRect();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const blocks = [...el.querySelectorAll<HTMLElement>("[data-block]")];
    const relative = (r: DOMRect) => new DOMRect(r.x - origin.left, r.y - origin.top, r.width, r.height);
    /* Where each is drawn now: on screen if this element was here before,
       else (a block that moved lanes is a new element) where it last rested. */
    const drawn = blocks.map((b) => (seen.current.has(b) ? relative(b.getBoundingClientRect()) : rests.current.get(b.dataset.block!)));
    for (const b of blocks) {
      b.style.transition = "none";
      b.style.transform = "";
    }
    const next: Rests = new Map();
    blocks.forEach((b, i) => {
      seen.current.add(b);
      const at = relative(b.getBoundingClientRect());
      next.set(b.dataset.block!, at);
      const was = drawn[i];
      if (still || !was) return;
      const dx = was.x - at.x;
      const dy = was.y - at.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      b.style.transform = `translate(${dx}px, ${dy}px)`;
      void b.offsetWidth;
      b.style.transition = "transform 160ms cubic-bezier(0.2, 0, 0, 1)";
      b.style.transform = "";
    });
    rests.current = next;
  }, [root, rests, arrangement]);
}

/* ---------------------------------------------------------------- blocks -- */

/** A tiny drawing of what a pane shows, so blocks read at a glance. */
function Sketch({ id }: { id: PaneId }) {
  const line = "h-[3px] bg-faint/50";
  switch (id) {
    case "calendar":
      return (
        <div className="grid grid-cols-7 gap-[3px] w-fit" aria-hidden>
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} className={`w-[5px] h-[5px] ${i === 9 ? "bg-accent" : "bg-faint/50"}`} />
          ))}
        </div>
      );
    case "agenda":
      return (
        <div className="space-y-[5px]" aria-hidden>
          {[60, 80, 45].map((w, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-2.5 h-[3px] bg-faint/70" />
              <span className={`w-[2px] h-[7px] ${["bg-blue", "bg-magenta", "bg-teal"][i]}`} />
              <span className={line} style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      );
    case "notepad":
      return (
        <div className="space-y-[5px] border-l-2 border-faint/50 pl-1.5" aria-hidden>
          {[90, 70, 82].map((w, i) => (
            <span key={i} className={`block ${line}`} style={{ width: `${w}%` }} />
          ))}
        </div>
      );
    case "tasks":
    case "boards":
    case "inbox":
      return (
        <div className="space-y-[5px]" aria-hidden>
          {[75, 55, 68].map((w, i) => (
            <div key={i} className="flex items-center gap-1.5">
              {id === "tasks" && <span className={`w-[6px] h-[6px] border ${i === 1 ? "border-green bg-green/40" : "border-faint"}`} />}
              {id === "boards" && <span className="text-[8px] leading-none text-faint">#</span>}
              {id === "inbox" && <span className={`w-[4px] h-[4px] ${i === 0 ? "bg-accent" : "bg-faint/50"}`} />}
              <span className={line} style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      );
    case "wired":
      return (
        <div className="flex items-start gap-[9px] pt-[3px]" aria-hidden>
          {["bg-blue", "bg-yellow", "bg-green"].map((lamp, i) => (
            <span key={i} className="relative w-[8px] h-[13px]">
              <span className={`absolute left-[3px] -top-[3px] w-[2px] h-[2px] ${lamp}`} />
              <span className="absolute left-[3px] top-0 w-[2px] h-[13px] bg-faint/70" />
              <span className="absolute left-0 top-[2px] w-[8px] h-[2px] bg-faint/70" />
            </span>
          ))}
        </div>
      );
    case "nudge":
      return (
        <div className="space-y-[5px]" aria-hidden>
          {[50, 65].map((w, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-[6px] h-[6px] bg-faint/70" />
              <span className={i === 0 ? "h-[3px] bg-accent/70" : line} style={{ width: `${w}%` }} />
            </div>
          ))}
          <span className="block h-[7px] w-[85%] border border-faint/70" />
        </div>
      );
    case "markets":
      return (
        <div className="space-y-[5px]" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-5 h-[3px] bg-faint/70" />
              <span className="flex-1" />
              <span className={`w-3 h-[3px] ${i === 1 ? "bg-red/70" : "bg-green/70"}`} />
            </div>
          ))}
        </div>
      );
  }
}

/** The glyph a statusline item shows in the bar. */
function ReadoutGlyph({ id }: { id: TopbarId }) {
  const { moon } = useMoon(formatDate(new Date()));
  if (id === "weather") return <Sun size={12} className="text-yellow" aria-hidden />;
  if (id === "moon") return <MoonPhaseIcon phase={moon} size={12} />;
  if (id === "clock") return <Clock size={12} className="text-ink" aria-hidden />;
  return <Bell size={12} className="text-ink" aria-hidden />;
}

/** A block's ⋯ menu: the same moves as its keys, for a finger or a mouse. */
function BlockMenu({ name, actions, run }: { name: string; actions: Action[]; run: (a: Action) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  if (actions.length === 0) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          /* Escape closes the menu, not the settings around it. */
          if (e.key === "Escape" && open) e.stopPropagation();
          e.stopPropagation();
        }}
        className="tap flex items-center text-muted hover:text-accent transition-[color,opacity] pointer-fine:opacity-0 pointer-fine:group-hover/block:opacity-100 pointer-fine:group-focus-within/block:opacity-100 aria-expanded:opacity-100"
        aria-label={`${name}: moves`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Move or switch off"
      >
        <MoreHorizontal size={14} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-20 min-w-[9rem] bg-surface border border-faint py-1">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                run(a);
              }}
              onKeyDown={(e) => e.stopPropagation()}
              className={`w-full text-left px-3 py-1.5 pointer-coarse:py-2.5 text-xs hover:bg-raised transition-colors ${
                a.label === "switch off" ? "text-muted hover:text-red" : "text-ink hover:text-accent"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- the map -- */

export function WidgetMap() {
  const { data: settings = DEFAULT_SETTINGS } = useSettings();
  const update = useUpdateSettings();
  const saved = settings.dashboard;

  /** A layout waiting for a place (the weather dropped in without one). */
  const [asking, setAsking] = useState<DashboardLayout | null>(null);
  /** Picking a new place for weather that already has one. */
  const [moving, setMoving] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [said, say] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);

  const root = useRef<HTMLDivElement | null>(null);
  const rests = useRef<Rests>(new Map());
  const layout = asking ?? saved;
  /* The map as if the block were dropped where the pointer is. */
  const preview = (drag?.over && place(layout, drag.item, drag.over)) || layout;

  useGlide(root, rests, `${JSON.stringify(preview)}|${drag ? `${drag.item.kind}:${drag.item.id}` : ""}`);

  /* Keep focus on a block moved by key or menu. The optimistic write lands a
     tick after the keypress, and a block that changes lanes is a new
     element, so focus follows it on every layout until the request lapses. */
  useEffect(() => {
    if (!focusId) return;
    root.current?.querySelector<HTMLElement>(`[data-block="${focusId}"]`)?.focus();
    const lapse = setTimeout(() => setFocusId(null), 1000);
    return () => clearTimeout(lapse);
  }, [focusId, saved, asking]);

  const commit = (next: DashboardLayout) => {
    if (sameLayout(next, saved)) return setAsking(null);
    if (missingRequirement(next, settings)) {
      setMoving(false);
      return setAsking(next);
    }
    setAsking(null);
    update.mutate({ dashboard: next });
  };
  /* The window listeners of a drag outlive the render that started it. */
  const live = useRef({ layout, commit });
  live.current = { layout, commit };

  const run = (item: Item, action: Action) => {
    commit(action.to(layout));
    say(action.said);
    setFocusId(`${item.kind}:${item.id}`);
  };

  /* ---- pointer drag ---- */

  const begin = (event: ReactPointerEvent<HTMLElement>, item: Item) => {
    if (event.button !== 0 || asking || !root.current) return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    /* A finger takes hold by the grip only, so the page scrolls elsewhere. */
    if (event.pointerType !== "mouse" && !target.closest("[data-grip]")) return;
    const block = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    let current: Drag | null = null;

    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId || !root.current) return;
      if (!current) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
        const box = block.getBoundingClientRect();
        rests.current = measure(root.current);
        setGhost({
          html: block.innerHTML,
          className: block.className,
          grabX: startX - box.left,
          grabY: startY - box.top,
          width: box.width,
          height: box.height,
        });
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      e.preventDefault();
      const spot = spotAt(root.current, rests.current, item, e.clientX, e.clientY);
      current = { item, x: e.clientX, y: e.clientY, over: spot === "refused" ? null : spot, refused: spot === "refused" };
      setDrag(current);
    };
    const finish = (drop: boolean) => (e: Event) => {
      if (e instanceof PointerEvent && e.pointerId !== event.pointerId) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        /* Escape drops nothing and leaves the settings open. */
        e.stopPropagation();
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", cancel, true);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (!current) return;
      /* The click that ends a drag is not a click on whatever is under it
         (outside the settings, that would close them). */
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      const next = drop && current.over ? place(live.current.layout, current.item, current.over) : null;
      setDrag(null);
      setGhost(null);
      if (next) {
        live.current.commit(next);
        say(`${specOf(item).name} ${current.over?.zone === "tray" ? "switched off" : "placed"}`);
      }
    };
    const up = finish(true);
    const cancel = finish(false);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", cancel, true);
  };


  /** What every block shares: focus, keys, dragging, and its id for the map. */
  const blockProps = (item: Item) => {
    const actions = actionsFor(layout, item);
    return {
      "data-block": `${item.kind}:${item.id}`,
      tabIndex: 0,
      "aria-roledescription": "movable widget",
      "aria-describedby": "widget-map-help",
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => begin(e, item),
      onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
        if (e.target !== e.currentTarget) return;
        const action = actions.find((a) => a.keys.includes(e.key));
        if (!action) return;
        e.preventDefault();
        run(item, action);
      },
      menu: <BlockMenu name={specOf(item).name} actions={actions} run={(a) => run(item, a)} />,
    };
  };

  const dragging = (item: Item) => sameItem(drag?.item, item);
  const pickingUp = drag?.item;

  /* ---- the pieces ---- */

  const grip = (
    <span data-grip className="tap touch-none flex items-center text-faint group-hover/block:text-muted cursor-grab" aria-hidden>
      <GripVertical size={12} />
    </span>
  );

  /** The hole a dragged block leaves, or fills where it would land, about its size. */
  const slot = (className: string, style?: CSSProperties) => (
    <div className={`border border-dashed border-accent bg-accent/5 ${className}`} style={style} />
  );

  const paneBlock = (id: PaneId) => {
    const item: Item = { kind: "pane", id };
    const spec = paneSpec(id);
    const { menu, ...props } = blockProps(item);
    if (dragging(item))
      return (
        <div key={id} data-block={props["data-block"]}>
          {slot("", { height: Math.min(Math.max(ghost?.height ?? 64, 44), 96) })}
        </div>
      );
    return (
      <div
        key={id}
        {...props}
        aria-label={`${spec.name}${spec.required ? ", always on" : ""}`}
        className="group/block relative bg-surface border border-divider hover:border-faint focus:outline-none focus-visible:border-accent select-none pointer-fine:cursor-grab transition-colors"
      >
        <div className="flex items-center gap-1 pl-0.5 pr-1 pt-1 text-xs whitespace-nowrap">
          {grip}
          <span className="text-blue group-hover/block:text-accent group-focus-visible/block:text-accent tracking-[0.1em] truncate min-w-0 transition-colors">
            /{spec.name}
          </span>
          <span className="flex-1 min-w-1 border-t border-faint/50" aria-hidden />
          {spec.required && (
            <span title="Always on: it moves, but cannot be switched off" className="text-faint shrink-0">
              <Lock size={10} aria-label="always on" />
            </span>
          )}
          {menu}
        </div>
        <div className="px-2.5 pb-2.5 pt-1">
          <Sketch id={id} />
        </div>
      </div>
    );
  };

  const readoutChip = (id: TopbarId) => {
    const item: Item = { kind: "topbar", id };
    const spec = topbarSpec(id);
    const { menu, ...props } = blockProps(item);
    const pending = asking && !requirementMet(spec, settings);
    if (dragging(item))
      return (
        <div key={id} data-block={props["data-block"]}>
          {slot("h-6", { width: Math.min(Math.max(ghost?.width ?? 64, 48), 110) })}
        </div>
      );
    return (
      <div
        key={id}
        {...props}
        aria-label={`${spec.name}${spec.required ? ", always on" : ""}`}
        className={`group/block flex items-center gap-1 h-6 pr-0.5 text-xs whitespace-nowrap select-none pointer-fine:cursor-grab border focus:outline-none focus-visible:border-accent transition-colors ${
          pending ? "border-dashed border-yellow text-yellow" : "bg-surface border-divider hover:border-faint text-ink"
        }`}
      >
        {grip}
        <ReadoutGlyph id={id} />
        <span className="group-hover/block:text-accent transition-colors">{spec.name}</span>
        {spec.required && <Lock size={9} className="text-faint" aria-label="always on" />}
        {menu}
      </div>
    );
  };

  const trayItem = (item: Item) => {
    const spec = specOf(item);
    const { menu: _menu, ...props } = blockProps(item);
    const on = actionsFor(layout, item).find((a) => a.label === "switch on");
    if (dragging(item))
      return (
        <li key={`${item.kind}:${item.id}`} data-block={props["data-block"]} className="w-full sm:w-[calc(50%-0.25rem)]">
          {slot("h-full min-h-[3.5rem]")}
        </li>
      );
    return (
      <li
        key={`${item.kind}:${item.id}`}
        {...props}
        aria-label={`${spec.name}, switched off`}
        className="group/block w-full sm:w-[calc(50%-0.25rem)] flex items-start gap-1 bg-surface border border-divider hover:border-faint focus:outline-none focus-visible:border-accent select-none pointer-fine:cursor-grab py-1.5 pr-1 transition-colors"
      >
        {grip}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm text-ink group-hover/block:text-accent transition-colors">
            {item.kind === "topbar" && <ReadoutGlyph id={item.id} />}
            {item.kind === "pane" ? `/${spec.name}` : spec.name}
            <span className="text-[10px] text-faint">{item.kind === "pane" ? "pane" : "statusline"}</span>
          </span>
          <span className="block text-xs text-muted leading-snug">
            {spec.description}
            {spec.requires === "location" && !requirementMet(spec, settings) && <span className="text-faint"> Asks for a place.</span>}
          </span>
        </span>
        <button
          type="button"
          onClick={() => on && run(item, on)}
          className="tap shrink-0 flex items-center text-muted hover:text-green transition-colors"
          aria-label={`Switch ${spec.name} on`}
          title="Switch on"
        >
          <Plus size={14} aria-hidden />
        </button>
      </li>
    );
  };

  /* ---- layout ---- */

  const { readouts, icons } = topbarParts(preview);
  const off: Item[] = [
    ...PANES.filter((p) => !paneOn(preview, p.id)).map((p) => ({ kind: "pane" as const, id: p.id })),
    ...TOPBAR.filter((t) => !topbarOn(preview, t.id)).map((t) => ({ kind: "topbar" as const, id: t.id })),
  ];
  const count = preview.columns.length;
  const laneTarget = pickingUp?.kind === "pane";
  const stripTarget = pickingUp?.kind === "topbar";
  const overLane = drag?.over?.zone === "lane" ? drag.over.column : null;
  const overTray = drag?.over?.zone === "tray";
  const home = settings.location;

  return (
    <div ref={root} className="relative">
      <p id="widget-map-help" className="sr-only">
        Arrow keys move it, Delete switches it off, Enter switches it on from the tray. The menu button does the same.
      </p>
      <p aria-live="polite" className="sr-only">
        {said}
      </p>

      {/* columns */}
      <div className="flex items-center gap-3 mb-2">
        <span className="text-label">dashboard</span>
        <span className="flex-1 border-t border-divider" aria-hidden />
        <span className="text-xs text-muted">columns</span>
        <div role="radiogroup" aria-label="Columns" className="flex">
          {Array.from({ length: MAX_COLUMNS - MIN_COLUMNS + 1 }, (_, i) => i + MIN_COLUMNS).map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={n === count}
              disabled={!!asking}
              onClick={() => {
                commit(withColumnCount(layout, n));
                say(`${n} column${n > 1 ? "s" : ""}`);
              }}
              className={`w-7 h-7 pointer-coarse:w-10 pointer-coarse:h-10 -ml-px first:ml-0 border text-xs tabular-nums transition-colors disabled:opacity-50 ${
                n === count ? "relative z-10 border-accent text-accent bg-raised" : "border-faint text-muted hover:text-accent hover:border-accent"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* the screen */}
      <div className="border border-faint bg-divider">
        <div
          data-strip
          className={`min-h-9 pointer-coarse:min-h-11 py-1.5 bg-bar border-b border-divider flex items-center gap-2 px-2 whitespace-nowrap transition-colors ${
            stripTarget ? "outline outline-1 -outline-offset-1 outline-accent/60" : ""
          }`}
        >
          <span className="flex items-center gap-1.5 text-accent shrink-0" aria-hidden>
            <LogoMark />
            <span className="hidden md:inline text-xs">copland</span>
          </span>
          <span className="flex-1" />
          <div data-readouts className="flex flex-wrap justify-end items-center gap-1 min-w-0">
            {readouts.map(readoutChip)}
          </div>
          <span className="flex items-center gap-2 pl-1 shrink-0 text-faint">
            {icons.map((id) => (
              <span key={id} className="flex items-center gap-0.5" title={`${topbarSpec(id).name}: always on, always here`}>
                <ReadoutGlyph id={id} />
                <Lock size={8} aria-label="always on" />
              </span>
            ))}
            <span className="hidden sm:flex items-center gap-2" aria-hidden>
              <LayoutDashboard size={12} />
              <SettingsIcon size={12} />
              <LogOut size={12} />
            </span>
          </span>
        </div>

        {asking && (
          <div className="bg-surface border-b border-divider p-3 text-sm">
            <p className="text-xs text-muted mb-2">
              Where is the weather for? Picking a place puts it in the statusline.{" "}
              <button type="button" onClick={() => setAsking(null)} className="tap text-muted hover:text-ink underline">
                cancel
              </button>
            </p>
            <CityPicker
              autoFocus
              onPick={(r) => {
                const next = asking;
                setAsking(null);
                update.mutate({ location: { name: r.name, latitude: r.latitude, longitude: r.longitude }, dashboard: next });
                say(`weather in ${r.name} switched on`);
              }}
            />
          </div>
        )}

        <div data-lanes className={`grid gap-2 p-2 ${["", "grid-cols-1", "grid-cols-2", "grid-cols-3"][count]}`}>
          {preview.columns.map((column, i) => {
            const over = overLane === i;
            return (
              <div
                key={i}
                data-lane={i}
                aria-label={`Column ${i + 1}`}
                role="group"
                className={`flex flex-col gap-1.5 min-w-0 min-h-[9rem] transition-colors ${
                  column.length === 0 || laneTarget ? "outline outline-1 outline-dashed outline-offset-2" : ""
                } ${over ? "outline-accent" : laneTarget ? "outline-faint" : "outline-faint/70"}`}
              >
                {column.map(paneBlock)}
                {column.length === 0 && (
                  <div className="flex-1 flex flex-col items-center justify-center gap-1 text-center px-2 text-faint text-xs select-none">
                    <span aria-hidden className="text-base leading-none">⇣</span>
                    drop panes here
                    <span className="text-[10px]">an empty column keeps its width</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* the weather's place */}
      {topbarOn(saved, "weather") && home && !asking && (
        <div className="mt-2 text-xs">
          {moving ? (
            <div>
              <p className="text-muted mb-2">
                Pick a new place for the weather.{" "}
                <button type="button" onClick={() => setMoving(false)} className="tap text-muted hover:text-ink underline">
                  cancel
                </button>
              </p>
              <CityPicker
                autoFocus
                onPick={(r) => {
                  setMoving(false);
                  update.mutate({ location: { name: r.name, latitude: r.latitude, longitude: r.longitude } });
                }}
              />
            </div>
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-muted">weather in</span>
              <span className="text-bright">{home.name}</span>
              <span className="text-faint tabular-nums">
                {home.latitude.toFixed(2)}, {home.longitude.toFixed(2)}
              </span>
              <span className="flex-1" />
              <button type="button" onClick={() => setMoving(true)} className="tap text-muted hover:text-accent">
                change
              </button>
              <button
                type="button"
                onClick={() => update.mutate({ location: null, dashboard: toggleWidget(saved, "weather", false) })}
                className="tap text-muted hover:text-red"
                title="Forget the place and switch the weather off"
              >
                clear
              </button>
            </div>
          )}
        </div>
      )}

      {/* the tray */}
      <div className="flex items-center gap-3 mt-5 mb-2">
        <span className="text-label">switched off</span>
        <span className="flex-1 border-t border-divider" aria-hidden />
      </div>
      <ul
        data-tray
        aria-label="Switched off"
        className={`flex flex-wrap gap-2 p-2 min-h-[4.5rem] border border-dashed transition-colors ${
          drag?.refused ? "border-red bg-red/5" : overTray ? "border-accent bg-accent/5" : drag && !drag.over ? "border-faint" : "border-faint/70"
        }`}
      >
        {off.map(trayItem)}
        {off.length === 0 && !drag && <li className="m-auto text-xs text-faint select-none">everything is on</li>}
        {drag && (drag.refused || (!overTray && spotOf(layout, drag.item).zone !== "tray")) && (
          <li className={`m-auto px-2 text-xs select-none ${drag.refused ? "text-red" : "text-faint"}`}>
            {drag.refused ? `${specOf(drag.item).name} is always on` : "drop here to switch it off"}
          </li>
        )}
      </ul>

      <p className="mt-3 text-xs text-faint leading-relaxed">
        <span className="text-muted">on a phone</span> one column, read left to right:{" "}
        {phoneOrder(preview)
          .map((id) => paneSpec(id).name)
          .join(" → ")}
      </p>
      {update.error && <p className="text-red text-xs mt-2">{update.error.message}</p>}

      {drag &&
        ghost &&
        createPortal(
          <div
            aria-hidden
            className={`${ghost.className} fixed z-[70] pointer-events-none opacity-95 outline outline-1 outline-accent rotate-[1.5deg] [&_button]:invisible`}
            style={{ position: "fixed", margin: 0, left: drag.x - ghost.grabX, top: drag.y - ghost.grabY, width: ghost.width, height: ghost.height }}
            dangerouslySetInnerHTML={{ __html: ghost.html }}
          />,
          document.body,
        )}
    </div>
  );
}

export default WidgetMap;
