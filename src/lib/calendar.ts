/* ============================================================================
   Calendar data on the client.
   ----------------------------------------------------------------------------
   Events are fetched a month grid at a time (six weeks, Monday first), keyed
   by that range. The agenda asks for the current month's grid too, so while
   the calendar pane shows this month both panes share one request. nord-dash
   fetched every calendar once per pane and again every minute.
   ========================================================================== */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CalendarEvent, CalendarEvents, CalendarSetup, EventInput } from "@/domain/calendar";
import { api, send } from "./api";

export const CALENDAR_KEY = ["calendar"];
const SETUP_KEY = ["calendar", "setup"];
const eventsKey = (from: string, to: string) => ["calendar", "events", from, to];

/** Local midnight at the Monday on or before the 1st, and six weeks on. */
export function monthGrid(year: number, month: number): { from: Date; to: Date; days: Date[] } {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const from = new Date(year, month, 1 - offset);
  const days = Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - offset + i));
  return { from, to: new Date(year, month, 1 - offset + 42), days };
}

const pad = (n: number) => String(n).padStart(2, "0");
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

/** Does the event touch this local day? */
export function onDay(event: CalendarEvent, day: Date): boolean {
  const key = localDate(day);
  if (event.allDay) return event.start <= key && key < event.end;
  const dayStart = day.getTime();
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const s = Date.parse(event.start);
  const e = Math.max(Date.parse(event.end), s + 1);
  return s < dayEnd && e > dayStart;
}

export const useCalendarSetup = () =>
  useQuery({ queryKey: SETUP_KEY, queryFn: () => api<CalendarSetup>("/calendar") });

export function useCalendarEvents(year: number, month: number, enabled = true) {
  const { from, to } = monthGrid(year, month);
  const f = from.toISOString();
  const t = to.toISOString();
  return useQuery({
    queryKey: eventsKey(f, t),
    queryFn: () => api<CalendarEvents>(`/calendar/events?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`),
    enabled,
    /* Outside changes (someone invites you) have no live topic: poll gently. */
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
}

function useInvalidateCalendar() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: CALENDAR_KEY });
}

export function useCalendarSetupEdits() {
  const invalidate = useInvalidateCalendar();
  const queryClient = useQueryClient();
  const put = (setup: CalendarSetup) => {
    queryClient.setQueryData(SETUP_KEY, setup);
    void invalidate();
  };
  return {
    patch: useMutation({
      mutationFn: ({ id, ...patch }: { id: string; name?: string; tone?: number; visible?: boolean }) =>
        send<CalendarSetup>("PATCH", `/calendar/calendars/${id}`, patch),
      onSuccess: put,
    }),
    sync: useMutation({
      mutationFn: (accountId: string) => send<CalendarSetup>("POST", `/calendar/accounts/${accountId}/sync`),
      onSuccess: put,
    }),
    disconnect: useMutation({
      mutationFn: (accountId: string) => send<CalendarSetup>("DELETE", `/calendar/accounts/${accountId}`),
      onSuccess: put,
    }),
    addFeed: useMutation({
      mutationFn: (input: { name: string; url: string }) => send<CalendarSetup>("POST", "/calendar/ics", input),
      onSuccess: put,
    }),
    removeFeed: useMutation({
      mutationFn: (id: string) => send<CalendarSetup>("DELETE", `/calendar/calendars/${id}`),
      onSuccess: put,
    }),
  };
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function useEventEdits() {
  const invalidate = useInvalidateCalendar();
  return {
    create: useMutation({
      mutationFn: (input: EventInput) => send<CalendarEvent>("POST", "/calendar/events", { ...input, timeZone: timeZone() }),
      onSettled: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ sourceId, ...input }: EventInput & { sourceId: string }) =>
        send<CalendarEvent>("PUT", `/calendar/events/${input.calendarId}/${encodeURIComponent(sourceId)}`, {
          ...input,
          timeZone: timeZone(),
        }),
      onSettled: invalidate,
    }),
    remove: useMutation({
      mutationFn: ({ calendarId, sourceId }: { calendarId: string; sourceId: string }) =>
        send("DELETE", `/calendar/events/${calendarId}/${encodeURIComponent(sourceId)}`),
      onSettled: invalidate,
    }),
  };
}
