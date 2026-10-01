/* ============================================================================
   One event: read it, or write it.
   ----------------------------------------------------------------------------
   Opening an event shows it. Events on a writable Google calendar can be
   edited or deleted; ICS events and read-only calendars cannot, and say so
   by not offering it. Opened with a day and no event, it is a new event on
   that day, on the first writable calendar (the primary, when there is one).

   Times are entered in local time and sent as instants with the browser's
   time zone, which Google keeps on the event.
   ========================================================================== */

import { useMemo, useState } from "react";
import { Clock, ExternalLink, MapPin, Trash2, Video } from "lucide-react";
import type { CalendarEvent, CalendarInfo } from "@/domain/calendar";
import { addDays } from "@/domain/tasks";
import { localDate, localTime, useCalendarSetup, useEventEdits } from "@/lib/calendar";
import { Checkbox } from "@/ui/Checkbox";
import { ModalFrame } from "@/ui/ModalFrame";
import { toneBg } from "@/ui/tone";

const field = "bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent";

function whenText(event: CalendarEvent): string {
  if (event.allDay) {
    const last = addDays(event.end, -1);
    return last === event.start ? `${event.start} · all day` : `${event.start} → ${last} · all day`;
  }
  const s = new Date(event.start);
  const e = new Date(event.end);
  const sameDay = localDate(s) === localDate(e);
  return sameDay
    ? `${localDate(s)} · ${localTime(event.start)}–${localTime(event.end)}`
    : `${localDate(s)} ${localTime(event.start)} → ${localDate(e)} ${localTime(event.end)}`;
}

interface Draft {
  calendarId: string;
  title: string;
  allDay: boolean;
  date: string;
  endDate: string;
  startTime: string;
  endTime: string;
  location: string;
  description: string;
  addMeet: boolean;
}

function draftFrom(event: CalendarEvent | null, day: Date, calendars: CalendarInfo[]): Draft {
  const writable = calendars.filter((c) => c.writable);
  const fallback = (writable.find((c) => c.isPrimary) ?? writable[0])?.id ?? "";
  if (!event) {
    const d = localDate(day);
    return { calendarId: fallback, title: "", allDay: false, date: d, endDate: d, startTime: "09:00", endTime: "10:00", location: "", description: "", addMeet: false };
  }
  const start = new Date(event.start);
  const end = new Date(event.end);
  return {
    calendarId: event.calendarId,
    title: event.title,
    allDay: event.allDay,
    date: event.allDay ? event.start : localDate(start),
    endDate: event.allDay ? addDays(event.end, -1) : localDate(end),
    startTime: event.allDay ? "09:00" : localTime(event.start),
    endTime: event.allDay ? "10:00" : localTime(event.end),
    location: event.location ?? "",
    description: event.description ?? "",
    addMeet: false,
  };
}

interface EventModalProps {
  /** The event to show, or null to create one on `day`. */
  event: CalendarEvent | null;
  day: Date;
  onClose: () => void;
}

export function EventModal({ event, day, onClose }: EventModalProps) {
  const setup = useCalendarSetup();
  const calendars = setup.data?.calendars ?? [];
  const writable = calendars.filter((c) => c.writable && c.visible);
  const edits = useEventEdits();
  const [editing, setEditing] = useState(event === null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const initial = useMemo(() => draftFrom(event, day, calendars), [event, day, calendars]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const d = draft ?? initial;
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });
  const calendar = calendars.find((c) => c.id === (event?.calendarId ?? d.calendarId));
  const error = edits.create.error ?? edits.update.error ?? edits.remove.error;

  const save = () => {
    const start = d.allDay ? d.date : new Date(`${d.date}T${d.startTime}`).toISOString();
    const endDate = d.endDate < d.date ? d.date : d.endDate;
    const end = d.allDay ? addDays(endDate, 1) : new Date(`${endDate}T${d.endTime}`).toISOString();
    const input = {
      calendarId: d.calendarId,
      title: d.title.trim(),
      allDay: d.allDay,
      start,
      end,
      location: d.location.trim() || null,
      description: d.description.trim() || null,
      addMeet: d.addMeet,
    };
    if (event?.sourceId) edits.update.mutate({ ...input, sourceId: event.sourceId }, { onSuccess: onClose });
    else edits.create.mutate(input, { onSuccess: onClose });
  };

  if (!editing && event) {
    return (
      <ModalFrame
        title={
          <span className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 ${toneBg(event.tone)}`} aria-hidden />
            {calendar?.name ?? "event"}
          </span>
        }
        onClose={onClose}
        size="lg"
        footer={
          event.canEdit && event.sourceId ? (
            <>
              {error && <span className="text-red text-xs mr-auto">{error.message}</span>}
              <button
                onClick={() =>
                  confirmDelete
                    ? edits.remove.mutate({ calendarId: event.calendarId, sourceId: event.sourceId as string }, { onSuccess: onClose })
                    : setConfirmDelete(true)
                }
                onBlur={() => setConfirmDelete(false)}
                className={`flex items-center gap-1.5 px-3 py-1.5 pointer-coarse:py-2.5 border transition-colors ${
                  confirmDelete ? "border-red text-red" : "border-faint text-muted hover:border-red hover:text-red"
                }`}
              >
                <Trash2 size={14} /> {confirmDelete ? "really delete" : "delete"}
              </button>
              <button onClick={() => setEditing(true)} className="px-3 py-1.5 pointer-coarse:py-2.5 border border-faint text-ink hover:border-accent hover:text-accent">
                edit
              </button>
            </>
          ) : undefined
        }
      >
        <h2 className="text-bright text-lg mb-3 break-words">{event.title}</h2>
        <div className="space-y-2 text-sm">
          <p className="flex items-center gap-2 text-yellow">
            <Clock size={14} /> {whenText(event)}
          </p>
          {event.location && (
            <p className="flex items-center gap-2 text-muted break-all">
              <MapPin size={14} className="shrink-0" /> {event.location}
            </p>
          )}
          {event.videoLink && (
            <a href={event.videoLink} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-accent hover:underline break-all">
              <Video size={14} className="shrink-0" /> join call
            </a>
          )}
          {event.htmlLink && (
            <a href={event.htmlLink} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-muted hover:text-accent">
              <ExternalLink size={14} /> open in {event.sourceId ? "Google Calendar" : "its calendar"}
            </a>
          )}
        </div>
        {event.description && <p className="mt-4 text-ink whitespace-pre-wrap break-words leading-relaxed">{event.description}</p>}
      </ModalFrame>
    );
  }

  const valid = d.title.trim() && d.calendarId && (d.allDay || `${d.endDate}T${d.endTime}` >= `${d.date}T${d.startTime}`);

  return (
    <ModalFrame
      title={event ? "edit event" : "new event"}
      onClose={onClose}
      size="lg"
      footer={
        <>
          {error && <span className="text-red text-xs mr-auto">{error.message}</span>}
          <button
            onClick={save}
            disabled={!valid || edits.create.isPending || edits.update.isPending}
            className="px-3 py-1.5 pointer-coarse:py-2.5 border border-faint text-ink hover:border-accent hover:text-accent disabled:opacity-50"
          >
            save
          </button>
        </>
      }
    >
      {writable.length === 0 ? (
        <p className="text-muted text-sm">
          None of your visible calendars can be written to. Connect a Google account in settings to add events.
        </p>
      ) : (
        <div className="space-y-3">
          <input
            autoFocus
            className={`${field} w-full text-bright`}
            value={d.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="title"
            maxLength={300}
          />
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" className={field} value={d.date} onChange={(e) => set({ date: e.target.value, endDate: e.target.value > d.endDate ? e.target.value : d.endDate })} />
            {!d.allDay && <input type="time" className={field} value={d.startTime} onChange={(e) => set({ startTime: e.target.value })} />}
            <span className="text-faint">→</span>
            <input type="date" className={field} value={d.endDate} min={d.date} onChange={(e) => set({ endDate: e.target.value })} />
            {!d.allDay && <input type="time" className={field} value={d.endTime} onChange={(e) => set({ endTime: e.target.value })} />}
          </div>
          <Checkbox checked={d.allDay} onChange={(allDay) => set({ allDay })} label={<span className="text-ink">all day</span>} size={15} />
          <select className={`${field} w-full`} value={d.calendarId} disabled={event !== null} onChange={(e) => set({ calendarId: e.target.value })}>
            {writable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input className={`${field} w-full`} value={d.location} onChange={(e) => set({ location: e.target.value })} placeholder="location" />
          <textarea
            className={`${field} w-full min-h-24 resize-y`}
            value={d.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="description"
          />
          {!event?.videoLink && (
            <Checkbox checked={d.addMeet} onChange={(addMeet) => set({ addMeet })} label={<span className="text-ink">add a Google Meet link</span>} size={15} />
          )}
        </div>
      )}
    </ModalFrame>
  );
}
