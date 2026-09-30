/* ============================================================================
   API client. One fetch wrapper so every call shares an error contract.
   ----------------------------------------------------------------------------
   A 401 means there is no session. The first request the app makes is /me,
   and App shows the login screen when that fails; for any later call the
   session has gone away under a signed-in user, so the browser is sent to
   sign in again and comes back to the same page.
   ========================================================================== */

import { TAB_HEADER } from "@/domain/live";
import { TAB_ID } from "./liveState";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
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
