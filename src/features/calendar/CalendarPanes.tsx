/* ============================================================================
   /calendar and /daily_agenda.
   ----------------------------------------------------------------------------
   The month grid marks each day with its events' calendar colours; a click
   lists that day's events. The agenda is today: what is on, what is next,
   and a line where now is. Both read lib/calendar.ts, and on the current
   month they are the same request.

   With no calendars at all, both panes say how to add one instead of
   showing an empty grid that looks broken.
   ========================================================================== */

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Settings, Video } from "lucide-react";
import type { CalendarEvent } from "@/domain/calendar";
import { localDate, localTime, monthGrid, onDay, useCalendarEvents, useCalendarSetup } from "@/lib/calendar";
import { ModalFrame } from "@/ui/ModalFrame";
import { toneBg } from "@/ui/tone";
import { WidgetFrame } from "@/ui/WidgetFrame";
import { EventModal } from "./EventModal";

const WEEKDAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"];

type Open = { event: CalendarEvent | null; day: Date } | null;

function EventRow({ event, onOpen, now }: { event: CalendarEvent; onOpen: () => void; now?: number }) {
  const past = now !== undefined && !event.allDay && Date.parse(event.end) < now;
  return (
    <button
      onClick={onOpen}
      className={`w-full flex items-center gap-3 px-2 py-2 text-left hover:bg-raised transition-colors border-b border-divider ${past ? "opacity-50" : ""}`}
    >
      <span className="text-muted text-xs shrink-0 w-[5ch] tabular-nums">{event.allDay ? "all" : localTime(event.start)}</span>
      <span className={`w-0.5 self-stretch shrink-0 ${toneBg(event.tone)}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="text-ink block truncate">{event.title}</span>
        {(event.location || event.description) && (
          <span className="text-xs text-muted block truncate">{event.location ?? event.description}</span>
        )}
      </span>
      {event.videoLink && <Video size={13} className="text-accent shrink-0" aria-label="has a call link" />}
    </button>
  );
}

function Empty({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="text-sm text-muted">
      <p className="mb-2">No calendars yet.</p>
      <button onClick={onOpenSettings} className="text-accent hover:underline">
        connect Google or add an ICS link in settings
      </button>
    </div>
  );
}

function Errors({ errors }: { errors: { name: string; message: string }[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="mb-2 text-xs text-red">
      {errors.map((e) => (
        <p key={e.name}>
          {e.name}: {e.message}
        </p>
      ))}
    </div>
  );
}

/** One-time note after coming back from Google's consent screen. */
function useConnectResult(): string | null {
  const [result] = useState(() => new URLSearchParams(location.search).get("calendar"));
  useEffect(() => {
    if (!result) return;
    const url = new URL(location.href);
    url.searchParams.delete("calendar");
    history.replaceState(null, "", url);
  }, [result]);
  return result;
}

const CONNECT_RESULT: Record<string, { text: string; ok: boolean }> = {
  connected: { text: "Google Calendar connected.", ok: true },
  no_refresh: { text: "Google did not hand over offline access. Remove Copland at myaccount.google.com/permissions and connect again.", ok: false },
  failed: { text: "Connecting Google Calendar failed. Try again from settings.", ok: false },
};

export function CalendarPane({ onOpenSettings }: { onOpenSettings: () => void }) {
  const today = new Date();
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const setup = useCalendarSetup();
  const hasCalendars = (setup.data?.calendars.length ?? 0) > 0;
  const events = useCalendarEvents(cursor.year, cursor.month, hasCalendars);
  const [selected, setSelected] = useState<Date | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const connect = useConnectResult();
  const note = connect ? CONNECT_RESULT[connect] : null;

  const grid = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const byDay = useMemo(() => {
    const list = events.data?.events ?? [];
    return new Map(grid.days.map((day) => [localDate(day), list.filter((e) => onDay(e, day))]));
  }, [events.data, grid]);
  const todayKey = localDate(today);
  const shift = (delta: number) =>
    setCursor(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  const selectedEvents = selected ? (byDay.get(localDate(selected)) ?? []) : [];

  return (
    <WidgetFrame
      title="/calendar"
      controls={
        <button onClick={onOpenSettings} className="p-1 hover:text-accent transition-colors" title="Calendars">
          <Settings size={14} />
        </button>
      }
    >
      {note && <p className={`mb-3 text-xs ${note.ok ? "text-green" : "text-red"}`}>{note.text}</p>}
      {setup.data && !hasCalendars ? (
        <Empty onOpenSettings={onOpenSettings} />
      ) : (
        <>
          <Errors errors={events.data?.errors ?? []} />
          <div className="flex justify-between items-center mb-3 pb-2 border-b border-divider">
            <button onClick={() => shift(-1)} className="p-1 text-muted hover:text-accent" aria-label="Previous month">
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => setCursor({ year: today.getFullYear(), month: today.getMonth() })}
              className="tracking-[0.22em] uppercase text-ink hover:text-accent"
              title="Back to this month"
            >
              {new Date(cursor.year, cursor.month, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
            </button>
            <button onClick={() => shift(1)} className="p-1 text-muted hover:text-accent" aria-label="Next month">
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="grid grid-cols-7 mb-1 text-center">
            {WEEKDAYS.map((d) => (
              <span key={d} className="text-[10px] text-muted uppercase tracking-[0.08em]">
                {d}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px">
            {grid.days.map((day) => {
              const key = localDate(day);
              const list = byDay.get(key) ?? [];
              const inMonth = day.getMonth() === cursor.month;
              const isToday = key === todayKey;
              return (
                <button
                  key={key}
                  onClick={() => setSelected(day)}
                  className={`min-h-11 py-1 flex flex-col items-center gap-1 transition-colors ${
                    isToday ? "bg-accent text-divider" : "hover:bg-raised"
                  } ${inMonth ? "" : "opacity-35"}`}
                >
                  <span className={isToday ? "" : list.length ? "text-bright" : "text-ink"}>{day.getDate()}</span>
                  <span className="flex gap-0.5 h-1">
                    {[...new Set(list.map((e) => e.tone))].slice(0, 4).map((tone) => (
                      <span key={tone} className={`w-1 h-1 ${isToday ? "bg-divider" : toneBg(tone)}`} />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
          {events.isFetching && !events.data && <p className="text-muted text-xs mt-2 animate-pulse">syncing…</p>}
        </>
      )}

      {selected && (
        <ModalFrame
          title={selected.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).toLowerCase()}
          onClose={() => setSelected(null)}
          headerActions={
            <button onClick={() => setOpen({ event: null, day: selected })} className="p-2 hover:bg-raised hover:text-green transition-colors" title="Add event">
              <Plus size={16} />
            </button>
          }
          className="max-h-[90vh]"
        >
          {selectedEvents.length === 0 && <p className="text-faint text-sm">nothing on</p>}
          {selectedEvents.map((e) => (
            <EventRow key={e.id} event={e} onOpen={() => setOpen({ event: e, day: selected })} />
          ))}
        </ModalFrame>
      )}
      {open && <EventModal event={open.event} day={open.day} onClose={() => setOpen(null)} />}
    </WidgetFrame>
  );
}

export function AgendaPane({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  /* The "now" line and what counts as past move once a minute. */
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const today = new Date(now);
  const setup = useCalendarSetup();
  const hasCalendars = (setup.data?.calendars.length ?? 0) > 0;
  const events = useCalendarEvents(today.getFullYear(), today.getMonth(), hasCalendars);
  const [open, setOpen] = useState<Open>(null);

  const list = (events.data?.events ?? []).filter((e) => onDay(e, new Date(today.getFullYear(), today.getMonth(), today.getDate())));
  const allDay = list.filter((e) => e.allDay);
  const timed = list.filter((e) => !e.allDay);
  const nowIndex = timed.findIndex((e) => Date.parse(e.start) > now);

  return (
    <WidgetFrame
      title="/daily_agenda"
      meta={today.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).toLowerCase()}
      controls={
        hasCalendars && (
          <button onClick={() => setOpen({ event: null, day: today })} className="p-1 hover:text-green transition-colors" title="Add event">
            <Plus size={14} />
          </button>
        )
      }
      bodyClassName="!px-2"
    >
      {setup.data && !hasCalendars ? (
        <div className="px-2">
          <Empty onOpenSettings={onOpenSettings} />
        </div>
      ) : (
        <>
          <Errors errors={events.data?.errors ?? []} />
          {events.isPending && hasCalendars && <p className="px-2 text-muted text-sm animate-pulse">syncing…</p>}
          {events.data && list.length === 0 && <p className="px-2 text-faint text-sm">nothing on today</p>}
          {allDay.map((e) => (
            <EventRow key={e.id} event={e} onOpen={() => setOpen({ event: e, day: today })} />
          ))}
          {timed.map((e, i) => (
            <div key={e.id}>
              {i === nowIndex && <div className="border-t border-accent my-0.5" title="now" />}
              <EventRow event={e} now={now} onOpen={() => setOpen({ event: e, day: today })} />
            </div>
          ))}
          {timed.length > 0 && nowIndex === -1 && <div className="border-t border-accent/40 my-0.5" title="now" />}
        </>
      )}
      {open && <EventModal event={open.event} day={open.day} onClose={() => setOpen(null)} />}
    </WidgetFrame>
  );
}
