/* ============================================================================
   The /wired pane: your agents' work as the pole scene (scene.ts), with each
   pole's tickets under it. Off by default; settings › widgets turns it on.
   ----------------------------------------------------------------------------
   The data is GET /api/wired (routes/wired.ts), which says which pole each
   task is on. The canvas is the picture, the lists are DOM text, one row of
   them under the poles. The canvas is scaled by the largest whole number
   (2 to 4) that fits the column, so its pixels stay square, and a ticket
   opens its task over the dashboard, as the inbox does.

   Blocked stands only half a span from doing and from done, so the lists
   share the row by rule (budgets below): todo is centred under its pole,
   doing hangs flush right with its pole, done flush left with its pole, and
   blocked is centred in what is left between them. Each list has a width
   in characters from the scale, and each line shows the longest form that
   fits it, dropping the timer first and then the agent (the status strip
   under the scene keeps both).
   ========================================================================== */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { SettingsPage } from "@/features/settings/SettingsModal";
import type { Wired, WiredTask } from "@/domain/types";
import { useWired } from "@/lib/queries";
import { useMediaQuery } from "@/ui/useMediaQuery";
import { WidgetFrame } from "@/ui/WidgetFrame";
import { OpenTask, type InboxTarget } from "../inbox/InboxPane";
import { BH, BW, POLE_H, readColors, SPACING, TOP, WiredScene, X, type SceneData } from "./scene";

const MAX_SCALE = 4;
/** Lines under todo and doing, and under done and blocked, a "+n more" included. */
const LINES = 4;
const SHORT_LINES = 3;
const LINE_H = 15;
/** The body's padding each side (p-4). */
const PAD = 16;
/** One character of the lists (11px JetBrains Mono, 0.03em tracking is 6.93px), rounded up. */
const CH = 7;
/** Space kept between two lists, in px. */
const GAP = 8;
/** Half the todo list's width at most: room for "+12 more" and keys like COPL-123. */
const TODO_HALF = 28;

/**
 * Each list's width in px at a scale, from where the poles stand (s is the
 * scale, S the span; a pole is 10 logo pixels wide, so its centre is 5 in):
 *   todo     centred on its pole: 2·min(TODO_HALF, its centre + PAD − 2)
 *   doing    right edge at its pole's right edge, left edge clear of todo:
 *            (S + 5)·s − TODO_HALF − GAP
 *   blocked  centred, clear of doing's right edge and done's left edge,
 *            each S/2 − 5 from its centre: (S − 10)·s − 2·GAP
 *   done     left edge at its pole's left edge, out to the canvas edge and
 *            the padding: (BW − X[3])·s + PAD − 2
 */
function budgets(s: number) {
  return {
    todo: 2 * Math.min(TODO_HALF, (X[0] + 5) * s + PAD - 2),
    doing: (SPACING + 5) * s - TODO_HALF - GAP,
    blocked: (SPACING - 10) * s - 2 * GAP,
    done: (BW - X[3]) * s + PAD - 2,
  };
}

/**
 * Which form a list shows, its lines' forms given longest first: the first
 * that every line fits in `width` px, so the list reads alike; the shortest
 * when none does (a ticket truncates rather than overlap).
 */
function formFor(lines: string[][], width: number): number {
  const chars = Math.floor(width / CH);
  const forms = Math.max(0, ...lines.map((l) => l.length));
  for (let f = 0; f < forms; f++) if (lines.every((l) => (l[Math.min(f, l.length - 1)] ?? "").length <= chars)) return f;
  return Math.max(0, forms - 1);
}

/** A done header stays lit this long after the last one. */
const DONE_LIT_MS = 15 * 60_000;

function elapsed(since: string | null, now: number): string {
  if (!since) return "";
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
  return `${m}m${String(s % 60).padStart(2, "0")}`;
}

const toScene = (w: Wired): SceneData => ({
  todo: w.todo.map((t) => t.id),
  doing: w.doing.map((t) => ({ id: t.id, live: t.live })),
  blocked: w.blocked.map((t) => t.id),
  done: w.done.map((t) => t.id),
});

/** The largest whole scale that fits the column, 2 at the least. */
const fit = (width: number) => Math.max(2, Math.min(MAX_SCALE, Math.floor((width - 2 * PAD) / BW)));

function Head({ pole, lit }: { pole: string; lit: boolean }) {
  const on: Record<string, string> = { todo: "text-blue", doing: "text-yellow", done: "text-green", blocked: "text-red" };
  return <span className={`mb-0.5 ${lit ? on[pole] : "text-faint"}`}>{pole}</span>;
}

function Ticket({ task, onOpen, className, children, style }: {
  task: WiredTask;
  onOpen: (t: InboxTarget) => void;
  className: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <button
      onClick={() => onOpen({ boardId: task.boardId, taskId: task.id })}
      title={`${task.key} · ${task.title}`}
      className={`max-w-full truncate text-left hover:text-accent transition-colors ${className}`}
      style={style}
    >
      {children}
    </button>
  );
}

type Part = [text: string, className?: string];

/** Each line of a list in the form formFor picks, its parts spaced and coloured. */
function fitted(lines: Part[][][], width: number): ReactNode[] {
  const f = formFor(lines.map((forms) => forms.map((parts) => parts.map(([text]) => text).join(" "))), width);
  return lines.map((forms) =>
    forms[Math.min(f, forms.length - 1)].flatMap(([text, className], i) => [
      i ? " " : "",
      className ? <span key={i} className={className}>{text}</span> : text,
    ]),
  );
}

/** How many of `n` lines capped shows as tickets. */
const shown = (n: number, max: number) => (n > max ? max - 1 : n);

/** At most `max` lines; the last says how many more when they do not fit. */
function capped(lines: ReactNode[], max: number): ReactNode[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max - 1), <span key="more" className="text-muted">+{lines.length - max + 1} more</span>];
}

/**
 * The scene and its lists. With `instead`, only the poles: that line takes
 * the place of the lists and the status strip (the no-agents state).
 */
function Scene({ data, onOpen, instead }: { data: Wired; onOpen: (t: InboxTarget) => void; instead?: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<WiredScene | null>(null);
  const motion = !useMediaQuery("(prefers-reduced-motion: reduce)");
  const [width, setWidth] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* The scene lives as long as the pane; the theme is re-read whenever <html> changes. */
  useEffect(() => {
    const cv = canvas.current;
    const el = wrap.current;
    if (!cv || !el) return;
    const s = new WiredScene(cv, readColors(cv), motion);
    scene.current = s;
    const themes = new MutationObserver(() => s.setColors(readColors(cv)));
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    const seen = new IntersectionObserver(([entry]) => s.setVisible(entry.isIntersecting));
    seen.observe(el);
    return () => {
      themes.disconnect();
      seen.disconnect();
      s.destroy();
      scene.current = null;
    };
    /* Made once: motion and data are handed to it below, not by remaking it. */
  }, []);

  useEffect(() => scene.current?.setMotion(motion), [motion]);
  useEffect(() => scene.current?.setData(toScene(data)), [data]);

  const ticking = data.doing.some((t) => t.live);
  /* Every second while a timer runs; otherwise only for the done list's fading. */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ticking ? 1000 : 30_000);
    return () => clearInterval(id);
  }, [ticking]);

  const scale = fit(width);
  const room = budgets(scale);
  const canvasW = BW * scale;
  const canvasH = BH * scale;
  const listTop = (TOP + POLE_H) * scale + 2;
  const height = instead ? canvasH + 6 : Math.max(canvasH + 6, listTop + 20 + LINES * LINE_H);
  const handle = (id: string) => data.agents.find((a) => a.id === id)?.name ?? "?";
  const live = data.doing.filter((t) => t.live);
  const latestDone = data.done[0]?.since ? Date.parse(data.done[0].since) : 0;
  const windowMs = data.doneWindowHours * 3600_000;

  const todo = data.todo.map((t) => (
    <Ticket key={t.id} task={t} onOpen={onOpen} className="text-blue">
      {t.key}
    </Ticket>
  ));
  /* Each line's forms, longest first: the timer drops first, then the agent, then the mark. */
  const doingText = fitted(
    data.doing.slice(0, shown(data.doing.length, LINES)).map((t) => {
      const agent: Part = [handle(t.agentId), t.live ? "text-yellow" : undefined];
      const full: Part[] = t.live ? [[t.key], agent, [elapsed(t.since, now), "text-muted"]] : [[t.key], agent];
      return [full, [[t.key], agent], [[t.key]]];
    }),
    room.doing,
  );
  const doing = data.doing.map((t, i) => (
    <Ticket key={t.id} task={t} onOpen={onOpen} className={t.live ? "text-ink" : "text-muted"}>
      {doingText[i]}
    </Ticket>
  ));
  const blockedText = fitted(
    data.blocked.slice(0, shown(data.blocked.length, SHORT_LINES)).map((t) => [[["▲"], [t.key], [handle(t.agentId), "text-muted"]], [["▲"], [t.key]], [[t.key]]]),
    room.blocked,
  );
  const blocked = data.blocked.map((t, i) => (
    <Ticket key={t.id} task={t} onOpen={onOpen} className="text-red">
      {blockedText[i]}
    </Ticket>
  ));
  const doneText = fitted(
    data.done.slice(0, shown(data.done.length, SHORT_LINES)).map((t) => [[["✓"], [t.key]], [[t.key]]]),
    room.done,
  );
  const done = data.done.map((t, i) => (
    <Ticket
      key={t.id}
      task={t}
      onOpen={onOpen}
      className="text-green"
      style={{ opacity: Math.max(0.3, 1 - (now - Date.parse(t.since ?? "")) / windowMs) || 0.3 }}
    >
      {doneText[i]}
    </Ticket>
  ));
  /* Where each list hangs: `left` is its anchor in px, `align` which of its edges (or its centre) sits there. */
  const cols = [
    { pole: "todo", lit: todo.length > 0, lines: capped(todo, LINES), left: (X[0] + 5) * scale, align: "center", width: room.todo },
    { pole: "doing", lit: live.length > 0, lines: capped(doing, LINES), left: (X[1] + 10) * scale, align: "end", width: room.doing },
    { pole: "blocked", lit: blocked.length > 0, lines: capped(blocked, SHORT_LINES), left: (X[2] + 5) * scale, align: "center", width: room.blocked },
    { pole: "done", lit: now - latestDone < DONE_LIT_MS, lines: capped(done, SHORT_LINES), left: X[3] * scale, align: "start", width: room.done },
  ] as const;
  const anchor = { center: "items-center -translate-x-1/2", end: "items-end -translate-x-full text-right", start: "items-start" };

  const sep = <span className="text-faint">│</span>;
  const status: ReactNode[] = data.agents.map((a) => {
    if (a.paused) return <span key={a.id} className="text-faint">{a.name} paused</span>;
    const w = live.find((t) => t.agentId === a.id);
    return w ? (
      <span key={a.id}>
        {a.name} <span className="text-yellow">●</span> {w.key} {elapsed(w.since, now)}
      </span>
    ) : (
      <span key={a.id}>{a.name} ○</span>
    );
  });
  const quiet = !data.todo.length && !data.doing.length && !data.blocked.length && !data.done.length;
  if (quiet) status.push(<span key="quiet" className="text-faint">nothing on the wire</span>);
  else {
    status.push(<span key="todo"><span className="text-blue">{data.todo.length}</span> todo</span>);
    if (data.blocked.length) status.push(<span key="blocked"><span className="text-red">▲</span> {data.blocked.map((t) => t.key).join(" ")}</span>);
    status.push(<span key="done"><span className="text-green">✓</span> {data.doneCount}</span>);
  }

  return (
    <div ref={wrap} className="w-full [contain:inline-size] overflow-hidden text-[11px] leading-[1.35] tracking-[0.03em]">
      <div className="flex justify-center p-4 pb-2">
        <div className="relative shrink-0" style={{ width: canvasW, height }}>
          <canvas
            ref={canvas}
            className="block [image-rendering:pixelated]"
            style={{ width: canvasW, height: canvasH }}
            role="img"
            aria-label={`${data.todo.length} todo, ${live.length} doing, ${data.blocked.length} blocked, ${data.doneCount} done in the last ${data.doneWindowHours} hours`}
          />
          {!instead &&
            cols.map((c) => (
              <div
                key={c.pole}
                className={`absolute flex flex-col gap-px whitespace-nowrap ${anchor[c.align]}`}
                style={{ left: c.left, top: listTop, maxWidth: c.width }}
              >
                <Head pole={c.pole} lit={c.lit} />
                {c.lines}
              </div>
            ))}
        </div>
      </div>
      {instead ?? (
        <div className="flex gap-2.5 items-center px-4 py-1.5 bg-bar text-muted whitespace-nowrap overflow-hidden">
          {status.flatMap((s, i) => (i ? [<span key={`sep${i}`}>{sep}</span>, s] : [s]))}
        </div>
      )}
    </div>
  );
}

export function WiredPane({ onOpenSettings }: { onOpenSettings: (page: SettingsPage) => void }) {
  const { data, error } = useWired();
  const [open, setOpen] = useState<InboxTarget | null>(null);
  const live = data?.doing.filter((t) => t.live).length ?? 0;
  const meta =
    data && data.agents.length > 0 ? (
      <>
        {live} doing · <span className={data.blocked.length ? "text-red" : ""}>{data.blocked.length} need you</span>
      </>
    ) : undefined;

  return (
    <WidgetFrame title="/wired" meta={meta} bodyClassName="!p-0">
      {error && <p className="p-4 text-red text-sm">{error.message}</p>}
      {!data && !error && <p className="px-4 py-3 text-muted text-sm animate-pulse">loading…</p>}
      {data && data.agents.length === 0 && (
        <Scene
          data={data}
          onOpen={setOpen}
          instead={
            <p className="px-4 pb-4 text-sm text-muted leading-relaxed">
              The wires are quiet: you have no agents yet. An agent is an assistant with a name of its own that you hand
              tasks to; what it picks up, works on, gets stuck on and finishes runs along here.{" "}
              <button onClick={() => onOpenSettings("new-agent")} className="text-accent hover:underline">
                make one in settings › agents
              </button>
            </p>
          }
        />
      )}
      {data && data.agents.length > 0 && <Scene data={data} onOpen={setOpen} />}
      {open && <OpenTask {...open} onClose={() => setOpen(null)} />}
    </WidgetFrame>
  );
}
