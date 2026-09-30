/* ============================================================================
   Calendar shapes shared by the Worker and the browser.
   ----------------------------------------------------------------------------
   Every source (a Google calendar, an ICS feed) comes out of the Worker as
   the same CalendarEvent, so the panes never care where an event is from.

   Times: `start`/`end` are ISO instants for timed events. For all-day events
   they are YYYY-MM-DD dates, `end` exclusive (the day after the last day),
   which is what Google and ICS both use.
   ========================================================================== */

export interface CalendarEvent {
  /** Unique across sources: "<calendarId>:<source event id>[:<occurrence>]". */
  id: string;
  calendarId: string;
  /** Google's event id, for edits. Null for ICS events. */
  sourceId: string | null;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  /** Plain text; Google's HTML descriptions are flattened by the Worker. */
  description: string | null;
  /** A video call link (Meet, Zoom, Teams) found on the event. */
  videoLink: string | null;
  /** The event's page on Google Calendar. */
  htmlLink: string | null;
  tone: number;
  canEdit: boolean;
}

export interface CalendarInfo {
  id: string;
  kind: "google" | "ics";
  accountId: string | null;
  name: string;
  tone: number;
  visible: boolean;
  writable: boolean;
  isPrimary: boolean;
}

export interface CalendarAccount {
  id: string;
  email: string;
  /** Google stopped accepting the connection; it needs connecting again. */
  broken: boolean;
}

/** GET /api/calendar */
export interface CalendarSetup {
  accounts: CalendarAccount[];
  calendars: CalendarInfo[];
}

/** GET /api/calendar/events: events, plus any source that failed. */
export interface CalendarEvents {
  events: CalendarEvent[];
  errors: { calendarId: string; name: string; message: string }[];
}

/** POST /api/calendar/events and PUT .../:calendarId/:eventId */
export interface EventInput {
  calendarId: string;
  title: string;
  allDay: boolean;
  /** Timed: ISO instants. All-day: YYYY-MM-DD, end exclusive. */
  start: string;
  end: string;
  location?: string | null;
  description?: string | null;
  /** Ask Google to attach a Meet link. */
  addMeet?: boolean;
}
