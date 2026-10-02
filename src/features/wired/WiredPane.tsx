/* ============================================================================
   The /wired pane: your agents' work as the pole scene (scene.ts), with each
   pole's tickets beside it. Off by default; settings › widgets turns it on.
   ----------------------------------------------------------------------------
   The data is GET /api/wired (routes/wired.ts), which says which pole each
   task is on. The canvas is the picture, the lists are DOM text: todo and
   doing under their poles, done and blocked to the right of theirs, or under
   the scene when the column is too narrow for them beside it. The canvas is
   scaled by the largest whole number (2 to 4) that fits the column, so its
   pixels stay square. A ticket opens its task over the dashboard, as the
   inbox does.
   ========================================================================== */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { SettingsPage } from "@/features/settings/SettingsModal";
import type { Wired, WiredTask } from "@/domain/types";
import { useWired } from "@/lib/queries";
import { useMediaQuery } from "@/ui/useMediaQuery";
import { WidgetFrame } from "@/ui/WidgetFrame";
import { OpenTask, type InboxTarget } from "../inbox/InboxPane";
import { BH, BW, POLE_H, readColors, TOPB, TOPD, TOPM, WiredScene, X, type SceneData } from "./scene";

/** Room for the done and blocked lists right of the canvas, in px. */
const TEXT_W = 112;
const MAX_SCALE = 4;
/** Lines under todo and doing, and beside done and blocked, a "+n more" included. */
const LINES = 4;
const SIDE_LINES = 3;
const LINE_H = 15;
/** The body's padding each side (p-4). */
const PAD = 16;
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

/** The largest whole scale that fits, and whether the side lists fit beside the canvas at it. */
function fit(width: number): { scale: number; wide: boolean } {
  const room = width - 2 * PAD;
  const wide = Math.min(MAX_SCALE, Math.floor((room - TEXT_W) / BW));
  if (wide >= 2) return { scale: wide, wide: true };
  return { scale: Math.max(2, Math.min(MAX_SCALE, Math.floor(room / BW))), wide: false };
}

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

  const { scale, wide } = fit(width);
  const canvasW = BW * scale;
  const canvasH = BH * scale;
  const listTop = (TOPM + POLE_H) * scale + 2;
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
  const doing = data.doing.map((t) => (
    <Ticket key={t.id} task={t} onOpen={onOpen} className={t.live ? "text-ink" : "text-muted"}>
      {t.key} <span className={t.live ? "text-yellow" : ""}>{handle(t.agentId)}</span>
      {t.live && <span className="text-muted"> {elapsed(t.since, now)}</span>}
    </Ticket>
  ));
  const blocked = data.blocked.map((t) => (
    <Ticket key={t.id} task={t} onOpen={onOpen} className="text-red">
      ▲ {t.key} <span className="text-muted">{handle(t.agentId)}</span>
    </Ticket>
  ));
  const done = data.done.map((t) => (
    <Ticket
      key={t.id}
      task={t}
      onOpen={onOpen}
      className="text-green"
      style={{ opacity: Math.max(0.3, 1 - (now - Date.parse(t.since ?? "")) / windowMs) || 0.3 }}
    >
      ✓ {t.key}
    </Ticket>
  ));
  const sides = [
    { pole: "done", lit: now - latestDone < DONE_LIT_MS, lines: capped(done, SIDE_LINES), top: TOPD },
    { pole: "blocked", lit: blocked.length > 0, lines: capped(blocked, SIDE_LINES), top: TOPB },
  ];
  const col = "absolute flex flex-col gap-px whitespace-nowrap";

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
        <div className="relative shrink-0" style={{ width: wide ? canvasW + TEXT_W : canvasW, height }}>
          <canvas
            ref={canvas}
            className="block [image-rendering:pixelated]"
            style={{ width: canvasW, height: canvasH }}
            role="img"
            aria-label={`${data.todo.length} todo, ${live.length} doing, ${data.blocked.length} blocked, ${data.doneCount} done in the last ${data.doneWindowHours} hours`}
          />
          {!instead && [
            { pole: "todo", x: X[0], lit: todo.length > 0, lines: capped(todo, LINES) },
            { pole: "doing", x: X[1], lit: live.length > 0, lines: capped(doing, LINES) },
          ].map((c) => (
            <div
              key={c.pole}
              className={`${col} items-center -translate-x-1/2 max-w-[160px]`}
              style={{ left: (c.x + 5) * scale, top: listTop }}
            >
              <Head pole={c.pole} lit={c.lit} />
              {c.lines}
            </div>
          ))}
          {wide &&
            !instead &&
            sides.map((c) => (
              <div key={c.pole} className={`${col} items-start`} style={{ left: canvasW + 8, top: c.top * scale - 2, maxWidth: TEXT_W - 8 }}>
                <Head pole={c.pole} lit={c.lit} />
                {c.lines}
              </div>
            ))}
        </div>
      </div>
      {!wide && !instead && (
        <div className="flex justify-center gap-8 px-4 pb-3">
          {sides.map((c) => (
            <div key={c.pole} className="flex flex-col gap-px whitespace-nowrap min-w-0">
              <Head pole={c.pole} lit={c.lit} />
              {c.lines}
            </div>
          ))}
        </div>
      )}
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
