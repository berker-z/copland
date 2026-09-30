/* ============================================================================
   Task rules shared by the Worker and the browser.
   ----------------------------------------------------------------------------
   The browser applies these to its cache the moment you act (optimistic
   updates), and the Worker applies them again as the truth. Keeping them in
   one place is what stops the card from flickering between the two.
   ========================================================================== */

import type { StageCategory } from "./types";

/** A task in a done or cancelled stage is closed and carries completed_at. */
export function isClosing(category: StageCategory): boolean {
  return category === "done" || category === "cancelled";
}

/** YYYY-MM-DD, and a real calendar date. */
export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * A rank that sorts between two neighbours, so a drag writes one row. Null
 * means "no neighbour on that side". Floats run out of room after about fifty
 * halvings in the same gap, which a person dragging cards will not reach; if
 * they ever do, the order is still valid, just with ties broken by number.
 */
export function rankBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0;
  if (before === null) return (after as number) - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}

export const TITLE_MAX = 200;
export const BRIEF_MAX = 20_000;

/* ---------------------------------------------------------- calendar days -- */

const DAY_MS = 86_400_000;

/** YYYY-MM-DD plus n days (negative goes back). Done in UTC, so no DST drift. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}
