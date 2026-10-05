/* ============================================================================
   API client. One fetch wrapper so every call shares an error contract.
   ----------------------------------------------------------------------------
   A 401 means there is no session. The first request the app makes is /me,
   and App shows the login screen when that fails; for any later call the
   session has gone away under a signed-in user, so the browser is sent to
   sign in again and comes back to the same page.
   ========================================================================== */

import { TAB_HEADER } from "@/domain/live";
import { VERSION_HEADER } from "@/domain/version";
import { TAB_ID } from "./liveState";
import { noteServerVersion } from "./versionState";

/* No parameter properties: the checks load this through node's type stripping. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export function loginUrl(): string {
  return `/auth/google?next=${encodeURIComponent(location.pathname + location.search)}`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      /* So the live message about this write is not echoed back to us. */
      [TAB_HEADER]: TAB_ID,
      ...init?.headers,
    },
  });
  /* Every response, errors included, says which build answered it. */
  noteServerVersion(response.headers.get(VERSION_HEADER));

  if (response.status === 401) {
    if (path !== "/me") window.location.assign(loginUrl());
    throw new ApiError(401, "Not signed in");
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* non-JSON error body; the status is all we have */
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

export const send = <T>(method: string, path: string, body?: unknown) =>
  api<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
