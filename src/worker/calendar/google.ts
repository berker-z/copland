/* ============================================================================
   Google Calendar, from the Worker.
   ----------------------------------------------------------------------------
   The browser never holds a Google token. The Worker keeps each account's
   refresh token (sealed in calendar_accounts), trades it for an access token
   when it needs one, and caches that for its lifetime in the isolate. In
   nord-dash all of this ran in the page, with the client secret in the
   bundle and refresh tokens readable from Firestore.

   A refresh that Google refuses (invalid_grant: revoked, or expired because
   the consent screen was still in Testing) marks the account broken, so the
   settings screen can say "reconnect" instead of the calendar going quiet.
   ========================================================================== */

import type { CalendarEvent, EventInput } from "@/domain/calendar";
import type { Env } from "../env";
import { HttpError, nowIso } from "../http";
import { unseal } from "../vault";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";

/** The scopes the calendar connection asks for, on top of openid/email. */
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

export interface AccountRow {
  id: string;
  user_id: string;
  email: string;
  iv: string;
  ciphertext: string;
  broken_at: string | null;
}

export class AccountBroken extends Error {}

export const accountContext = (userId: string, accountId: string) => `${userId}:calendar:${accountId}`;

const tokens = new Map<string, { token: string; expires: number }>();

/** A live access token for the account, refreshing when the cached one is near expiry. */
export async function accessToken(env: Env, account: AccountRow): Promise<string> {
  const cached = tokens.get(account.id);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;

  const refreshToken = await unseal(env, accountContext(account.user_id, account.id), account);
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !body.access_token) {
    if (body.error === "invalid_grant") {
      await env.DB.prepare(`UPDATE calendar_accounts SET broken_at = ?2 WHERE id = ?1`).bind(account.id, nowIso()).run();
      tokens.delete(account.id);
      throw new AccountBroken(account.email);
    }
    throw new Error(`token refresh: ${body.error ?? `HTTP ${response.status}`}`);
  }
  tokens.set(account.id, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 });
  if (account.broken_at) {
    await env.DB.prepare(`UPDATE calendar_accounts SET broken_at = NULL WHERE id = ?1`).bind(account.id).run();
  }
  return body.access_token;
}

async function google<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok) {
    /* Google's message is safe to show (it never echoes the token) and is
       more useful than a status code. */
    throw new HttpError(response.status === 404 ? 404 : 502, `Google Calendar: ${body?.error?.message ?? response.status}`);
  }
  return body as T;
}

/* ------------------------------------------------------------ calendars -- */

export interface GoogleCalendar {
  id: string;
  summary: string;
  summaryOverride?: string;
  accessRole: "owner" | "writer" | "reader" | "freeBusyReader";
  primary?: boolean;
  hidden?: boolean;
}

export async function listCalendars(token: string): Promise<GoogleCalendar[]> {
  const out: GoogleCalendar[] = [];
  let pageToken: string | undefined;
  do {
    const page = await google<{ items?: GoogleCalendar[]; nextPageToken?: string }>(
      token,
      `/users/me/calendarList?${new URLSearchParams({ maxResults: "250", ...(pageToken ? { pageToken } : {}) })}`,
    );
    out.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/* --------------------------------------------------------------- events -- */

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] };
}

const VIDEO_HOSTS = /https?:\/\/[^\s"<>]*(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com)[^\s"<>]*/i;

/**
 * Google descriptions are HTML fragments. The Worker has no DOM, so this is
 * a small flattener: line breaks and list items become newlines, tags go,
 * the common entities come back. Nothing from a description is ever
 * rendered as HTML by the app.
 */
export function htmlToText(html: string): string {
  if (!/[<&]/.test(html)) return html.trim();
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/(li|p|div|ol|ul|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toEvent(item: GoogleEvent, calendar: { id: string; tone: number; writable: boolean }): CalendarEvent {
  const allDay = !item.start.dateTime;
  const description = item.description ? htmlToText(item.description) : null;
  const videoLink =
    item.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
    item.hangoutLink ??
    item.location?.match(VIDEO_HOSTS)?.[0] ??
    item.description?.match(VIDEO_HOSTS)?.[0] ??
    null;
  return {
    id: `${calendar.id}:${item.id}`,
    calendarId: calendar.id,
    sourceId: item.id,
    title: item.summary?.trim() || "(no title)",
    start: (allDay ? item.start.date : item.start.dateTime) as string,
    end: (allDay ? item.end.date : item.end.dateTime) ?? ((allDay ? item.start.date : item.start.dateTime) as string),
    allDay,
    location: item.location ?? null,
    description: description || null,
    videoLink,
    htmlLink: item.htmlLink ?? null,
    tone: calendar.tone,
    canEdit: calendar.writable,
  };
}

export async function listEvents(
  token: string,
  calendar: { id: string; externalId: string; tone: number; writable: boolean },
  timeMin: string,
  timeMax: string,
): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "2500",
      ...(pageToken ? { pageToken } : {}),
    });
    const page = await google<{ items?: GoogleEvent[]; nextPageToken?: string }>(
      token,
      `/calendars/${encodeURIComponent(calendar.externalId)}/events?${params}`,
    );
    for (const item of page.items ?? []) if (item.status !== "cancelled") out.push(toEvent(item, calendar));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

function toGoogleBody(input: EventInput, timeZone: string) {
  const when = (value: string) => (input.allDay ? { date: value } : { dateTime: value, timeZone });
  return {
    summary: input.title,
    description: input.description ?? undefined,
    location: input.location ?? undefined,
    start: when(input.start),
    end: when(input.end),
    ...(input.addMeet
      ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } }
      : {}),
  };
}

export async function createEvent(
  token: string,
  calendar: { id: string; externalId: string; tone: number; writable: boolean },
  input: EventInput,
  timeZone: string,
): Promise<CalendarEvent> {
  const item = await google<GoogleEvent>(
    token,
    `/calendars/${encodeURIComponent(calendar.externalId)}/events?conferenceDataVersion=1`,
    { method: "POST", body: JSON.stringify(toGoogleBody(input, timeZone)) },
  );
  return toEvent(item, calendar);
}

/** PATCH rather than PUT: fields we do not model (attendees, reminders) survive an edit. */
export async function updateEvent(
  token: string,
  calendar: { id: string; externalId: string; tone: number; writable: boolean },
  eventId: string,
  input: EventInput,
  timeZone: string,
): Promise<CalendarEvent> {
  const item = await google<GoogleEvent>(
    token,
    `/calendars/${encodeURIComponent(calendar.externalId)}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1`,
    { method: "PATCH", body: JSON.stringify(toGoogleBody(input, timeZone)) },
  );
  return toEvent(item, calendar);
}

export async function deleteEvent(token: string, externalId: string, eventId: string): Promise<void> {
  await google<void>(token, `/calendars/${encodeURIComponent(externalId)}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
  });
}
