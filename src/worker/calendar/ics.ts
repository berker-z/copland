/* ============================================================================
   ICS feeds: the calendar option that needs no Google project.
   ----------------------------------------------------------------------------
   Most calendar apps (Google, iCloud, Outlook, Fastmail) can publish a
   calendar as a secret .ics link. The Worker fetches it, parses the VEVENTs
   and expands repeating ones into the requested range.

   What this handles, which covers what those apps publish in practice:
     - DTSTART/DTEND/DURATION, all-day (VALUE=DATE), UTC (Z), TZID (IANA
       names, through Intl), and floating times (read as UTC).
     - RRULE with FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL,
       BYDAY (weekly days, and "2TU"/"-1FR" in monthly), BYMONTHDAY.
     - EXDATE, and RECURRENCE-ID overrides (a moved or edited occurrence).
   Not handled: BYSETPOS, BYWEEKNO, BYYEARDAY, RDATE, and Windows zone names
   (those events come out as if the time were UTC).

   Repeats are expanded in wall-clock time and converted to instants per
   occurrence, so a 09:00 weekly meeting stays at 09:00 across a DST change.
   ========================================================================== */

import type { CalendarEvent } from "@/domain/calendar";

const DAY_MS = 86_400_000;
const MAX_STEPS = 5000;

/* ---------------------------------------------------------- time zones -- */

/** How far `tz` is ahead of UTC at the instant `ms`. */
function zoneOffset(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - ms;
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The instant at which the wall clock in `tz` reads `wall` (wall time
 * expressed as if it were UTC ms). Two passes settle DST edges.
 */
function wallToInstant(wall: number, tz: string): number {
  if (tz === "UTC") return wall;
  let guess = wall - zoneOffset(wall, tz);
  guess = wall - zoneOffset(guess, tz);
  return guess;
}

function instantToWall(ms: number, tz: string): number {
  return tz === "UTC" ? ms : ms + zoneOffset(ms, tz);
}

/* -------------------------------------------------------------- parsing -- */

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface Stamp {
  allDay: boolean;
  /** Wall-clock time as UTC ms (all-day: midnight of that date). */
  wall: number;
  tz: string;
}

interface VEvent {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  start: Stamp;
  /** Length in ms (all-day: whole days). */
  duration: number;
  rrule: Record<string, string> | null;
  exdates: Set<number>;
  /** For an override: the instant of the occurrence it replaces. */
  recurrenceId: number | null;
  cancelled: boolean;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseProp(line: string): Prop | null {
  /* The value starts at the first colon outside a quoted parameter. */
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function parseStamp(prop: Prop): Stamp | null {
  const v = prop.value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || prop.params.VALUE === "DATE") {
    if (!date) return null;
    return { allDay: true, wall: Date.UTC(+date[1], +date[2] - 1, +date[3]), tz: "UTC" };
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!dt) return null;
  const wall = Date.UTC(+dt[1], +dt[2] - 1, +dt[3], +dt[4], +dt[5], +dt[6]);
  if (dt[7] === "Z") return { allDay: false, wall, tz: "UTC" };
  const tz = prop.params.TZID && validZone(prop.params.TZID) ? prop.params.TZID : "UTC";
  return { allDay: false, wall, tz };
}

const instantOf = (s: Stamp) => (s.allDay ? s.wall : wallToInstant(s.wall, s.tz));

/** P1D, PT1H30M, P2W, -PT15M. */
function parseDuration(value: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return 0;
  const ms = (+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * DAY_MS + (+(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

export function parseIcs(text: string): VEvent[] {
  const events: VEvent[] = [];
  let props: Prop[] | null = null;
  let depth = 0;

  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      props = [];
      depth = 0;
      continue;
    }
    if (!props) continue;
    /* Alarms and other components nested in the event are skipped whole. */
    if (line.startsWith("BEGIN:")) depth++;
    else if (line.startsWith("END:") && line !== "END:VEVENT") depth--;
    else if (line === "END:VEVENT") {
      const event = toVEvent(props);
      if (event) events.push(event);
      props = null;
    } else if (depth === 0) {
      const prop = parseProp(line);
      if (prop) props.push(prop);
    }
  }
  return events;
}

function toVEvent(props: Prop[]): VEvent | null {
  const one = (name: string) => props.find((p) => p.name === name);
  const dtstart = one("DTSTART");
  const start = dtstart && parseStamp(dtstart);
  if (!start) return null;

  let duration = start.allDay ? DAY_MS : 0;
  const dtend = one("DTEND");
  const end = dtend && parseStamp(dtend);
  if (end) duration = start.allDay ? end.wall - start.wall : instantOf(end) - instantOf(start);
  else if (one("DURATION")) duration = parseDuration((one("DURATION") as Prop).value);

  const rruleProp = one("RRULE");
  const rrule = rruleProp
    ? Object.fromEntries(
        rruleProp.value.split(";").map((part) => {
          const [k, v] = part.split("=");
          return [k.toUpperCase(), v ?? ""];
        }),
      )
    : null;

  const exdates = new Set<number>();
  for (const p of props.filter((x) => x.name === "EXDATE")) {
    for (const value of p.value.split(",")) {
      const stamp = parseStamp({ ...p, value });
      if (stamp) exdates.add(instantOf(stamp));
    }
  }

  const rid = one("RECURRENCE-ID");
  const ridStamp = rid && parseStamp(rid);
  const text = (name: string) => {
    const p = one(name);
    return p ? unescapeText(p.value).trim() || null : null;
  };

  return {
    uid: one("UID")?.value ?? crypto.randomUUID(),
    summary: text("SUMMARY") ?? "(no title)",
    description: text("DESCRIPTION"),
    location: text("LOCATION"),
    url: text("URL"),
    start,
    duration: Math.max(duration, 0),
    rrule,
    exdates,
    recurrenceId: ridStamp ? instantOf(ridStamp) : null,
    cancelled: one("STATUS")?.value.toUpperCase() === "CANCELLED",
  };
}

/* ------------------------------------------------------------ expansion -- */

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Wall-clock starts of every occurrence, in order, until `limitWall`. */
function occurrences(event: VEvent, limitWall: number): number[] {
  const rule = event.rrule;
  const first = event.start.wall;
  if (!rule) return [first];

  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  let until = Infinity;
  if (rule.UNTIL) {
    const stamp = parseStamp({ name: "UNTIL", params: {}, value: rule.UNTIL });
    if (stamp) {
      /* UNTIL in UTC compares against instants; convert it to this event's wall clock. */
      until = stamp.allDay
        ? stamp.wall + DAY_MS - 1
        : rule.UNTIL.endsWith("Z")
          ? instantToWall(stamp.wall, event.start.tz)
          : stamp.wall;
    }
  }
  const end = Math.min(limitWall, until);
  const d0 = new Date(first);
  const timeOfDay = first - Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate());
  const byDay = rule.BYDAY ? rule.BYDAY.split(",") : [];
  const byMonthDay = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(",").map(Number) : [];

  const out: number[] = [];
  const push = (wall: number) => {
    if (wall < first || wall > end || out.length >= count) return false;
    out.push(wall);
    return true;
  };

  for (let step = 0; step < MAX_STEPS && out.length < count; step++) {
    let candidates: number[] = [];
    let periodStart: number;
    switch (rule.FREQ) {
      case "DAILY":
        periodStart = first + step * interval * DAY_MS;
        candidates = [periodStart];
        break;
      case "WEEKLY": {
        /* Weeks start on Monday (WKST default). */
        const weekday = (d0.getUTCDay() + 6) % 7;
        const monday = first - timeOfDay - weekday * DAY_MS + step * interval * 7 * DAY_MS;
        periodStart = monday;
        const days = byDay.length ? byDay.map((d) => (WEEKDAYS.indexOf(d.slice(-2)) + 6) % 7) : [weekday];
        candidates = [...new Set(days)].sort((a, b) => a - b).map((i) => monday + i * DAY_MS + timeOfDay);
        break;
      }
      case "MONTHLY": {
        const y = d0.getUTCFullYear();
        const m = d0.getUTCMonth() + step * interval;
        periodStart = Date.UTC(y, m, 1);
        const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        if (byDay.length) {
          for (const spec of byDay) {
            const n = parseInt(spec, 10);
            const wd = WEEKDAYS.indexOf(spec.slice(-2));
            const matches: number[] = [];
            for (let day = 1; day <= daysInMonth; day++) {
              if (new Date(Date.UTC(y, m, day)).getUTCDay() === wd) matches.push(day);
            }
            const picks = Number.isNaN(n) ? matches : [n > 0 ? matches[n - 1] : matches[matches.length + n]];
            for (const day of picks) if (day) candidates.push(Date.UTC(y, m, day) + timeOfDay);
          }
        } else {
          const days = byMonthDay.length ? byMonthDay : [d0.getUTCDate()];
          for (const day of days) {
            const actual = day < 0 ? daysInMonth + day + 1 : day;
            /* The 31st in a 30-day month is skipped, as RFC 5545 says. */
            if (actual >= 1 && actual <= daysInMonth) candidates.push(Date.UTC(y, m, actual) + timeOfDay);
          }
        }
        candidates.sort((a, b) => a - b);
        break;
      }
      case "YEARLY": {
        const y = d0.getUTCFullYear() + step * interval;
        periodStart = Date.UTC(y, 0, 1);
        const candidate = Date.UTC(y, d0.getUTCMonth(), d0.getUTCDate()) + timeOfDay;
        /* 29 February outside a leap year does not exist. */
        if (new Date(candidate).getUTCMonth() === d0.getUTCMonth()) candidates = [candidate];
        break;
      }
      default:
        return [first];
    }
    if (periodStart > end) break;
    for (const c of candidates) push(c);
  }
  return out;
}

/* ---------------------------------------------------------------- public -- */

const VIDEO_HOSTS = /https?:\/\/[^\s"<>]*(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com)[^\s"<>]*/i;

const isoDate = (wall: number) => new Date(wall).toISOString().slice(0, 10);

/** Events from a parsed feed that overlap [from, to), as CalendarEvents. */
export function eventsInRange(
  parsed: VEvent[],
  calendar: { id: string; tone: number },
  fromMs: number,
  toMs: number,
): CalendarEvent[] {
  /* Occurrences replaced by an override, per UID. */
  const overridden = new Map<string, Set<number>>();
  for (const e of parsed) {
    if (e.recurrenceId === null) continue;
    if (!overridden.has(e.uid)) overridden.set(e.uid, new Set());
    overridden.get(e.uid)?.add(e.recurrenceId);
  }

  const out: CalendarEvent[] = [];
  for (const event of parsed) {
    if (event.cancelled) continue;
    const tz = event.start.allDay ? "UTC" : event.start.tz;
    /* Expand far enough in wall time to reach the end of the range anywhere on Earth. */
    const limitWall = toMs + 2 * DAY_MS;
    const skip = overridden.get(event.uid);
    const series = event.recurrenceId === null ? occurrences(event, limitWall) : [event.start.wall];

    for (const wall of series) {
      const startMs = event.start.allDay ? wall : wallToInstant(wall, tz);
      if (event.recurrenceId === null && (event.exdates.has(startMs) || skip?.has(startMs))) continue;
      const endMs = startMs + event.duration;
      /* All-day spans are dates; compare them loosely, the client places them. */
      const overlaps = event.start.allDay
        ? startMs < toMs + DAY_MS && Math.max(endMs, startMs + DAY_MS) > fromMs - DAY_MS
        : startMs < toMs && Math.max(endMs, startMs + 1) > fromMs;
      if (!overlaps) continue;

      const video = event.location?.match(VIDEO_HOSTS)?.[0] ?? event.description?.match(VIDEO_HOSTS)?.[0] ?? null;
      out.push({
        id: `${calendar.id}:${event.uid}:${startMs}`,
        calendarId: calendar.id,
        sourceId: null,
        title: event.summary,
        start: event.start.allDay ? isoDate(startMs) : new Date(startMs).toISOString(),
        end: event.start.allDay ? isoDate(Math.max(endMs, startMs + DAY_MS)) : new Date(endMs).toISOString(),
        allDay: event.start.allDay,
        location: event.location,
        description: event.description,
        videoLink: video,
        htmlLink: event.url,
        tone: calendar.tone,
        canEdit: false,
      });
    }
  }
  return out;
}

/* A feed is fetched at most every few minutes per isolate, whoever asks. */
const feedCache = new Map<string, { at: number; parsed: VEvent[] }>();
const FEED_TTL_MS = 5 * 60_000;

export async function fetchFeed(url: string): Promise<VEvent[]> {
  const cached = feedCache.get(url);
  if (cached && Date.now() - cached.at < FEED_TTL_MS) return cached.parsed;
  const response = await fetch(url.replace(/^webcals?:\/\//i, "https://"), {
    headers: {
      accept: "text/calendar, text/plain;q=0.9, */*;q=0.1",
      /* Some feed hosts refuse requests without one; a Worker sends none by default. */
      "user-agent": "copland/0.1 (+https://github.com/berker-z/copland)",
    },
  });
  if (!response.ok) throw new Error(`the feed answered ${response.status}`);
  const text = await response.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("that link is not an iCalendar feed");
  const parsed = parseIcs(text);
  feedCache.set(url, { at: Date.now(), parsed });
  return parsed;
}
