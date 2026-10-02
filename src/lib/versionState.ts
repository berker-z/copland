/* ============================================================================
   Whether a newer build is out than the one this tab is running.
   ----------------------------------------------------------------------------
   The API client sees every /api response and reports the Worker's version
   here; the statusline subscribes and offers a reload. It never reloads by
   itself: someone may be mid-edit.
   ========================================================================== */

import { useSyncExternalStore } from "react";
import { VERSION } from "@/domain/version";

let stale = false;
const listeners = new Set<() => void>();

/** Called with the version header of each /api response. */
export function noteServerVersion(server: string | null): void {
  /* No header (an error page from elsewhere) says nothing either way. */
  if (stale || !server || server === VERSION) return;
  stale = true;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True once the Worker has answered with a different build than this tab's. */
export const useNewVersion = () => useSyncExternalStore(subscribe, () => stale);
