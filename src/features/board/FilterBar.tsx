/* ============================================================================
   The board's filter bar, under the header, over every view.
   ----------------------------------------------------------------------------
   Search, level chips, assignee, labels, "under" (scope to a task's
   subtree), and whether closed tasks older than two weeks show. The state is
   the URL (filters.ts); every change replaces the history entry rather than
   pushing one, so back still leaves the board.

   `/` focuses the search (not while typing somewhere or with a modal open),
   Escape in it clears and leaves it. On a phone the search stays and the
   rest folds behind a "filters" toggle.
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from "react";
import { CornerLeftUp, Search, SlidersHorizontal, X } from "lucide-react";
import type { BoardDetail } from "@/domain/types";
import { toneText } from "@/ui/tone";
import { useDismiss } from "@/ui/useDismiss";
import { activeCount, LEVEL_FILTERS, NO_FILTERS, RECENT_DONE_DAYS, type BoardFilters, type Filtered } from "./filters";

interface FilterBarProps {
  detail: BoardDetail;
  filters: BoardFilters;
  result: Filtered;
  onChange: (next: BoardFilters) => void;
}

const chip = (on: boolean) => `tap px-1.5 py-0.5 transition-colors ${on ? "text-accent bg-raised" : "text-muted hover:text-ink"}`;

/** Typing somewhere, or a modal over the board: `/` is a character there, not a shortcut. */
function typingOrModal(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return true;
  return document.querySelector('[aria-modal="true"]') !== null;
}

function ScopePicker({ detail, onPick }: { detail: BoardDetail; onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(ref, open, () => setOpen(false));

  /* Tasks with children first (what you scope to), then the rest, each in key order. */
  const options = useMemo(() => {
    const kids = new Map<string, number>();
    for (const t of detail.tasks) if (t.parentId) kids.set(t.parentId, (kids.get(t.parentId) ?? 0) + 1);
    const needle = text.trim().toLowerCase();
    return detail.tasks
      .filter((t) => !needle || `${t.key} ${t.title}`.toLowerCase().includes(needle))
      .map((t) => ({ task: t, children: kids.get(t.id) ?? 0 }))
      .sort((a, b) => (b.children > 0 ? 1 : 0) - (a.children > 0 ? 1 : 0) || a.task.number - b.task.number)
      .slice(0, 50);
  }, [detail.tasks, text]);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className={chip(open)} title="Show only what is under a task">
        under…
      </button>
      {open && (
        <div className="absolute z-30 left-0 mt-1 w-[min(22rem,calc(100vw-2rem))] bg-surface border border-faint">
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && options[0]) {
                onPick(options[0].task.key);
                setOpen(false);
              }
            }}
            placeholder="task key or title"
            className="w-full bg-raised border-b border-faint px-3 py-1.5 focus:outline-none text-ink placeholder:text-faint"
          />
          <div className="max-h-72 overflow-y-auto">
            {options.length === 0 && <p className="px-3 py-2 text-faint text-xs">No task matches.</p>}
            {options.map(({ task, children }) => (
              <button
                key={task.id}
                onClick={() => {
                  onPick(task.key);
                  setOpen(false);
                }}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 pointer-coarse:py-2.5 text-left border-b border-divider hover:bg-raised"
              >
                <span className="text-faint shrink-0">{task.key}</span>
                {task.level && <span className="text-faint shrink-0">[{task.level}]</span>}
                <span className="text-ink truncate flex-1">{task.title}</span>
                {children > 0 && <span className="text-muted text-xs shrink-0">{children}↓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function FilterBar({ detail, filters, result, onChange }: FilterBarProps) {
  const search = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  /* What is typed is the input's own state, written through to the URL: the
     URL catches up a render later, and an input bound to it straight drops
     keys typed faster than that. It follows the URL when that changes
     without typing (clear, back, a shared link). */
  const [text, setText] = useState(filters.q);
  useEffect(() => {
    if (document.activeElement !== search.current) setText(filters.q);
  }, [filters.q]);
  const type = (q: string) => {
    setText(q);
    onChange({ ...filters, q });
  };
  const set = (patch: Partial<BoardFilters>) => onChange({ ...filters, ...patch });
  const active = activeCount(filters);
  const total = detail.tasks.length;
  const shown = result.tasks.length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || typingOrModal(event.target)) return;
      event.preventDefault();
      search.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const people = detail.members.filter((m) => m.user.kind === "person");
  const agents = detail.members.filter((m) => m.user.kind === "agent");
  /* A ?who= handle that is not a member any more still shows, so the select says what is filtering. */
  const strayWho = filters.who && !["me", "none"].includes(filters.who) && !detail.members.some((m) => m.user.handle.toLowerCase() === filters.who);
  const hasClosed = filters.allDone || result.olderDone > 0;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 md:px-8 py-1.5 bg-surface border-b border-divider text-sm">
      <label className="flex items-center gap-1.5 bg-raised border border-faint focus-within:border-accent px-2 flex-1 sm:flex-none min-w-0">
        <Search size={13} className="text-muted shrink-0" />
        <input
          ref={search}
          value={text}
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              type("");
              e.currentTarget.blur();
            }
          }}
          placeholder="filter"
          aria-label="Filter tasks by text"
          className="bg-transparent py-0.5 w-full sm:w-40 focus:outline-none text-ink placeholder:text-faint"
        />
        {!text && <kbd className="hidden pointer-fine:inline text-faint text-xs">/</kbd>}
      </label>

      <button onClick={() => setOpen(!open)} className={`sm:hidden ${chip(open)} flex items-center gap-1`} aria-expanded={open}>
        <SlidersHorizontal size={13} /> filters{active > 0 && <span className="text-accent">{active}</span>}
      </button>

      <div className={`${open ? "flex" : "hidden"} sm:flex basis-full sm:basis-auto flex-wrap items-center gap-x-3 gap-y-1.5`}>
        <span className="flex items-center gap-px" role="group" aria-label="Level">
          {LEVEL_FILTERS.map((l) => (
            <button key={l} onClick={() => set({ levels: toggle(filters.levels, l) })} className={chip(filters.levels.includes(l))} aria-pressed={filters.levels.includes(l)}>
              {l}
            </button>
          ))}
        </span>

        <select
          value={filters.who ?? ""}
          onChange={(e) => set({ who: e.target.value || null })}
          aria-label="Assignee"
          className={`bg-raised border border-faint px-1.5 py-0.5 focus:border-accent focus:outline-none ${filters.who ? "text-accent" : "text-muted"}`}
        >
          <option value="">anyone</option>
          <option value="me">me</option>
          <option value="none">unassigned</option>
          {strayWho && <option value={filters.who ?? ""}>{filters.who} (not on board)</option>}
          {people.length > 0 && (
            <optgroup label="people">
              {people.map((m) => (
                <option key={m.user.id} value={m.user.handle.toLowerCase()}>
                  {m.user.handle}
                </option>
              ))}
            </optgroup>
          )}
          {agents.length > 0 && (
            <optgroup label="agents">
              {agents.map((m) => (
                <option key={m.user.id} value={m.user.handle.toLowerCase()}>
                  {m.user.handle}
                </option>
              ))}
            </optgroup>
          )}
        </select>

        {detail.labels.length > 0 && (
          <span className="flex flex-wrap items-center gap-x-1" role="group" aria-label="Labels">
            {detail.labels.map((l) => {
              const on = filters.labels.includes(l.name.toLowerCase());
              return (
                <button
                  key={l.id}
                  onClick={() => set({ labels: toggle(filters.labels, l.name.toLowerCase()) })}
                  className={`tap px-1 py-0.5 ${on ? `${toneText(l.tone)} bg-raised` : "text-faint hover:text-ink"}`}
                  aria-pressed={on}
                >
                  #{l.name}
                </button>
              );
            })}
          </span>
        )}

        {filters.under ? (
          <span className={`flex items-center gap-1 bg-raised px-1.5 py-0.5 ${result.scope === "missing" ? "text-red" : "text-accent"}`}>
            <CornerLeftUp size={12} />
            <span className="truncate max-w-48" title={result.scope && result.scope !== "missing" ? result.scope.title : "No such task on this board"}>
              under {filters.under}
              {result.scope === "missing" && " (not on this board)"}
            </span>
            <button onClick={() => set({ under: null })} className="tap text-muted hover:text-accent" title="Whole board" aria-label="Stop showing only the subtree">
              <X size={12} />
            </button>
          </span>
        ) : (
          <ScopePicker detail={detail} onPick={(key) => set({ under: key })} />
        )}

        {hasClosed && (
          <button
            onClick={() => set({ allDone: !filters.allDone })}
            className={chip(filters.allDone)}
            title={filters.allDone ? `Hide tasks closed more than ${RECENT_DONE_DAYS} days ago` : `Show tasks closed more than ${RECENT_DONE_DAYS} days ago`}
          >
            {filters.allDone ? "all closed" : `+${result.olderDone} closed before ${RECENT_DONE_DAYS}d`}
          </button>
        )}
      </div>

      {(active > 0 || filters.allDone || shown < total) && (
        <span className="flex items-center gap-2 ml-auto text-xs whitespace-nowrap">
          <span className="text-muted tabular-nums">
            {shown} of {total} shown
          </span>
          {(active > 0 || filters.allDone) && (
            <button
              onClick={() => {
                setText("");
                onChange(NO_FILTERS);
              }}
              className="tap text-muted hover:text-accent">
              clear
            </button>
          )}
        </span>
      )}
    </div>
  );
}
