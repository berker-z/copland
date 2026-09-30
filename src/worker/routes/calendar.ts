/* ============================================================================
   Calendar routes. Personal: every query is scoped to the viewer's user_id,
   and every write notifies only the viewer's own tabs.

     GET    /api/calendar                    accounts and calendars
     POST   /api/calendar/accounts/:id/sync  re-read an account's calendar list
     DELETE /api/calendar/accounts/:id       disconnect (and revoke at Google)
     POST   /api/calendar/ics                add an ICS feed { name, url }
     PATCH  /api/calendar/calendars/:id      { name?, tone?, visible? }
     DELETE /api/calendar/calendars/:id      remove an ICS feed
     GET    /api/calendar/events?from&to     every visible calendar, merged
     POST   /api/calendar/events             create on a Google calendar
     PUT    /api/calendar/events/:calendarId/:eventId
     DELETE /api/calendar/events/:calendarId/:eventId

   Connecting a Google account is a browser redirect, so it lives in
   auth.ts (/auth/calendar); saveGoogleAccount below is what it calls.
   ========================================================================== */

import type {
  CalendarAccount,
  CalendarEvent,
  CalendarEvents,
  CalendarInfo,
  CalendarSetup,
  EventInput,
} from "@/domain/calendar";
import { isDate } from "@/domain/tasks";
import type { Viewer } from "@/domain/types";
import type { Env } from "../env";
import { badRequest, forbidden, json, notFound, readJson } from "../http";
import type { Changes } from "../live";
import {
  accessToken,
  AccountBroken,
  accountContext,
  createEvent,
  deleteEvent,
  listCalendars,
  listEvents,
  updateEvent,
  type AccountRow,
} from "../calendar/google";
import { eventsInRange, fetchFeed } from "../calendar/ics";
import { seal, unseal } from "../vault";

interface CalendarRow {
  id: string;
  user_id: string;
  kind: "google" | "ics";
  account_id: string | null;
  external_id: string | null;
  iv: string | null;
  ciphertext: string | null;
  name: string;
  tone: number;
  visible: number;
  writable: number;
  is_primary: number;
}

const toInfo = (row: CalendarRow): CalendarInfo => ({
  id: row.id,
  kind: row.kind,
  accountId: row.account_id,
  name: row.name,
  tone: row.tone,
  visible: row.visible === 1,
  writable: row.writable === 1,
  isPrimary: row.is_primary === 1,
});

async function setup(env: Env, userId: string): Promise<CalendarSetup> {
  const [accounts, calendars] = await Promise.all([
    env.DB.prepare(`SELECT id, email, broken_at FROM calendar_accounts WHERE user_id = ?1 ORDER BY created_at`)
      .bind(userId)
      .all<{ id: string; email: string; broken_at: string | null }>(),
    env.DB.prepare(`SELECT * FROM calendars WHERE user_id = ?1 ORDER BY kind, is_primary DESC, lower(name)`)
      .bind(userId)
      .all<CalendarRow>(),
  ]);
  return {
    accounts: accounts.results.map((a): CalendarAccount => ({ id: a.id, email: a.email, broken: a.broken_at !== null })),
    calendars: calendars.results.map(toInfo),
  };
}

async function accountFor(env: Env, userId: string, id: string): Promise<AccountRow> {
  const row = await env.DB.prepare(`SELECT * FROM calendar_accounts WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<AccountRow>();
  if (!row) throw notFound("No such calendar account");
  return row;
}

async function calendarFor(env: Env, userId: string, id: string): Promise<CalendarRow> {
  const row = await env.DB.prepare(`SELECT * FROM calendars WHERE id = ?1 AND user_id = ?2`).bind(id, userId).first<CalendarRow>();
  if (!row) throw notFound("No such calendar");
  return row;
}

/**
 * Bring an account's calendar rows in line with Google's list: new ones are
 * added (visible if Google shows them, primary first in the palette), gone
 * ones removed, names and write access refreshed. Our visibility and colour
 * choices are kept.
 */
async function syncCalendars(env: Env, account: AccountRow): Promise<void> {
  const remote = (await listCalendars(await accessToken(env, account))).filter((c) => c.accessRole !== "freeBusyReader");
  const { results: local } = await env.DB.prepare(`SELECT id, external_id FROM calendars WHERE account_id = ?1`)
    .bind(account.id)
    .all<{ id: string; external_id: string }>();
  const known = new Map(local.map((l) => [l.external_id, l.id]));
  const { results: toneRows } = await env.DB.prepare(`SELECT count(*) AS n FROM calendars WHERE user_id = ?1`)
    .bind(account.user_id)
    .all<{ n: number }>();
  let nextTone = toneRows[0]?.n ?? 0;

  const statements: D1PreparedStatement[] = [];
  for (const cal of remote) {
    const name = cal.summaryOverride ?? cal.summary;
    const writable = cal.accessRole === "owner" || cal.accessRole === "writer" ? 1 : 0;
    const id = known.get(cal.id);
    if (id) {
      statements.push(
        env.DB.prepare(`UPDATE calendars SET name = ?2, writable = ?3, is_primary = ?4 WHERE id = ?1`).bind(
          id,
          name,
          writable,
          cal.primary ? 1 : 0,
        ),
      );
      known.delete(cal.id);
    } else {
      statements.push(
        env.DB.prepare(
          `INSERT INTO calendars (id, user_id, kind, account_id, external_id, name, tone, visible, writable, is_primary)
           VALUES (?1, ?2, 'google', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        ).bind(
          crypto.randomUUID(),
          account.user_id,
          account.id,
          cal.id,
          name,
          nextTone++ % 8,
          cal.hidden ? 0 : 1,
          writable,
          cal.primary ? 1 : 0,
        ),
      );
    }
  }
  for (const goneId of known.values()) statements.push(env.DB.prepare(`DELETE FROM calendars WHERE id = ?1`).bind(goneId));
  if (statements.length) await env.DB.batch(statements);
}

/** Called by auth.ts after Google's consent comes back with a refresh token. */
export async function saveGoogleAccount(env: Env, userId: string, email: string, refreshToken: string): Promise<void> {
  const existing = await env.DB.prepare(`SELECT id FROM calendar_accounts WHERE user_id = ?1 AND email = ?2`)
    .bind(userId, email)
    .first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const sealed = await seal(env, accountContext(userId, id), refreshToken);
  await env.DB.prepare(
    `INSERT INTO calendar_accounts (id, user_id, email, iv, ciphertext) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (user_id, email) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext, broken_at = NULL`,
  )
    .bind(id, userId, email, sealed.iv, sealed.ciphertext)
    .run();
  await syncCalendars(env, await accountFor(env, userId, id));
}

/* ---------------------------------------------------------------- setup -- */

export async function getCalendarSetup(env: Env, viewer: Viewer) {
  return json(await setup(env, viewer.user.id));
}

export async function postAccountSync(env: Env, viewer: Viewer, id: string, changes: Changes) {
  await syncCalendars(env, await accountFor(env, viewer.user.id, id));
  changes.notify([viewer.user.id], "calendar");
  return json(await setup(env, viewer.user.id));
}

export async function deleteAccount(env: Env, viewer: Viewer, id: string, changes: Changes) {
  const account = await accountFor(env, viewer.user.id, id);
  /* Best effort: tell Google to forget the grant too. The row goes either way. */
  try {
    const token = await unseal(env, accountContext(account.user_id, account.id), account);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
  } catch (error) {
    console.warn("calendar revoke failed", error);
  }
  await env.DB.prepare(`DELETE FROM calendar_accounts WHERE id = ?1`).bind(id).run();
  changes.notify([viewer.user.id], "calendar");
  return json(await setup(env, viewer.user.id));
}

export async function postIcsFeed(request: Request, env: Env, viewer: Viewer, changes: Changes) {
  const body = await readJson(request);
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 60) {
    throw badRequest("`name` must be 1-60 characters");
  }
  if (typeof body.url !== "string") throw badRequest("`url` must be a link");
  let url: URL;
  try {
    url = new URL(body.url.trim().replace(/^webcals?:\/\//i, "https://"));
  } catch {
    throw badRequest("`url` must be a link");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("`url` must be an http(s) or webcal link");
  /* Try it now, so a wrong link fails here and not silently on the dashboard. */
  try {
    await fetchFeed(url.toString());
  } catch (error) {
    throw badRequest(`Could not read that feed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const id = crypto.randomUUID();
  const sealed = await seal(env, accountContext(viewer.user.id, id), url.toString());
  const { results } = await env.DB.prepare(`SELECT count(*) AS n FROM calendars WHERE user_id = ?1`)
    .bind(viewer.user.id)
    .all<{ n: number }>();
  await env.DB.prepare(
    `INSERT INTO calendars (id, user_id, kind, iv, ciphertext, name, tone) VALUES (?1, ?2, 'ics', ?3, ?4, ?5, ?6)`,
  )
    .bind(id, viewer.user.id, sealed.iv, sealed.ciphertext, body.name.trim(), (results[0]?.n ?? 0) % 8)
    .run();
  changes.notify([viewer.user.id], "calendar");
  return json(await setup(env, viewer.user.id), { status: 201 });
}

export async function patchCalendar(request: Request, env: Env, viewer: Viewer, id: string, changes: Changes) {
  await calendarFor(env, viewer.user.id, id);
  const body = await readJson(request);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 60) throw badRequest("`name` must be 1-60 characters");
    sets.push(`name = ?${values.length + 2}`);
    values.push(body.name.trim());
  }
  if (body.tone !== undefined) {
    if (typeof body.tone !== "number" || !Number.isInteger(body.tone) || body.tone < 0 || body.tone > 7) {
      throw badRequest("`tone` must be 0-7");
    }
    sets.push(`tone = ?${values.length + 2}`);
    values.push(body.tone);
  }
  if (body.visible !== undefined) {
    if (typeof body.visible !== "boolean") throw badRequest("`visible` must be a boolean");
    sets.push(`visible = ?${values.length + 2}`);
    values.push(body.visible ? 1 : 0);
  }
  if (sets.length === 0) throw badRequest("Nothing to update");
  await env.DB.prepare(`UPDATE calendars SET ${sets.join(", ")} WHERE id = ?1`).bind(id, ...values).run();
  changes.notify([viewer.user.id], "calendar");
  return json(await setup(env, viewer.user.id));
}

export async function deleteCalendar(env: Env, viewer: Viewer, id: string, changes: Changes) {
  const row = await calendarFor(env, viewer.user.id, id);
  if (row.kind !== "ics") throw badRequest("Google calendars go with their account; hide this one instead");
  await env.DB.prepare(`DELETE FROM calendars WHERE id = ?1`).bind(id).run();
  changes.notify([viewer.user.id], "calendar");
  return json(await setup(env, viewer.user.id));
}

/* --------------------------------------------------------------- events -- */

/** from/to are ISO instants; the client sends the local edges of what it shows. */
function parseRange(url: URL): { from: string; to: string } {
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) throw badRequest("`from` and `to` must be ISO times, from before to");
  if (b - a > 62 * 86_400_000) throw badRequest("Ask for at most two months at a time");
  return { from: new Date(a).toISOString(), to: new Date(b).toISOString() };
}

export async function getEvents(env: Env, viewer: Viewer, url: URL) {
  const { from, to } = parseRange(url);
  const userId = viewer.user.id;
  const { results: calendars } = await env.DB.prepare(`SELECT * FROM calendars WHERE user_id = ?1 AND visible = 1`)
    .bind(userId)
    .all<CalendarRow>();
  const { results: accounts } = await env.DB.prepare(`SELECT * FROM calendar_accounts WHERE user_id = ?1`)
    .bind(userId)
    .all<AccountRow>();
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const result: CalendarEvents = { events: [], errors: [] };
  /* Every source at once; one failing (a revoked account, a dead feed) costs
     only its own events and is reported next to the rest. */
  await Promise.all(
    calendars.map(async (cal) => {
      try {
        let events: CalendarEvent[];
        if (cal.kind === "google") {
          const account = accountById.get(cal.account_id as string);
          if (!account) return;
          events = await listEvents(
            await accessToken(env, account),
            { id: cal.id, externalId: cal.external_id as string, tone: cal.tone, writable: cal.writable === 1 },
            from,
            to,
          );
        } else {
          const feedUrl = await unseal(env, accountContext(userId, cal.id), { iv: cal.iv as string, ciphertext: cal.ciphertext as string });
          events = eventsInRange(await fetchFeed(feedUrl), { id: cal.id, tone: cal.tone }, Date.parse(from), Date.parse(to));
        }
        result.events.push(...events);
      } catch (error) {
        const message =
          error instanceof AccountBroken
            ? "Google stopped accepting this connection; reconnect it in settings"
            : error instanceof Error
              ? error.message
              : "failed";
        result.errors.push({ calendarId: cal.id, name: cal.name, message });
      }
    }),
  );
  result.events.sort((a, b) => a.start.localeCompare(b.start));
  return json(result);
}

/** The writable Google calendar an edit is aimed at, with a live token. */
async function writableCalendar(env: Env, viewer: Viewer, calendarId: unknown) {
  if (typeof calendarId !== "string") throw badRequest("`calendarId` is required");
  const cal = await calendarFor(env, viewer.user.id, calendarId);
  if (cal.kind !== "google" || cal.writable !== 1) throw forbidden("Events on this calendar cannot be changed from here");
  const account = await accountFor(env, viewer.user.id, cal.account_id as string);
  return {
    token: await accessToken(env, account),
    target: { id: cal.id, externalId: cal.external_id as string, tone: cal.tone, writable: true },
  };
}

function parseEventInput(body: Record<string, unknown>): EventInput & { timeZone: string } {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > 300) throw badRequest("`title` must be 1-300 characters");
  const allDay = body.allDay === true;
  const start = body.start;
  const end = body.end;
  if (allDay) {
    if (!isDate(start) || !isDate(end) || end <= start) throw badRequest("All-day events need dates, end after start (end is exclusive)");
  } else if (
    typeof start !== "string" ||
    typeof end !== "string" ||
    Number.isNaN(Date.parse(start)) ||
    Number.isNaN(Date.parse(end)) ||
    Date.parse(end) < Date.parse(start)
  ) {
    throw badRequest("Timed events need ISO start and end, end not before start");
  }
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  let timeZone = typeof body.timeZone === "string" ? body.timeZone : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    timeZone = "UTC";
  }
  return {
    calendarId: body.calendarId as string,
    title,
    allDay,
    start: start as string,
    end: end as string,
    location: text(body.location, 500),
    description: text(body.description, 8000),
    addMeet: body.addMeet === true,
    timeZone,
  };
}

export async function postEvent(request: Request, env: Env, viewer: Viewer, changes: Changes) {
  const input = parseEventInput(await readJson(request));
  const { token, target } = await writableCalendar(env, viewer, input.calendarId);
  const event = await createEvent(token, target, input, input.timeZone);
  changes.notify([viewer.user.id], "calendar");
  return json(event, { status: 201 });
}

export async function putEvent(request: Request, env: Env, viewer: Viewer, calendarId: string, eventId: string, changes: Changes) {
  const input = parseEventInput({ ...(await readJson(request)), calendarId });
  const { token, target } = await writableCalendar(env, viewer, calendarId);
  const event = await updateEvent(token, target, eventId, input, input.timeZone);
  changes.notify([viewer.user.id], "calendar");
  return json(event);
}

export async function removeEvent(env: Env, viewer: Viewer, calendarId: string, eventId: string, changes: Changes) {
  const { token, target } = await writableCalendar(env, viewer, calendarId);
  await deleteEvent(token, target.externalId, eventId);
  changes.notify([viewer.user.id], "calendar");
  return json({ ok: true });
}
