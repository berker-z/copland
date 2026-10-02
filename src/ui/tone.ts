/* ============================================================================
   Tones: the small categorical colour scale stages and labels pick from
   (0-7, stored on the row). Each maps to a hue role, so a theme recolours
   them like everything else.
   ========================================================================== */

const TEXT = ["text-blue", "text-yellow", "text-magenta", "text-green", "text-red", "text-orange", "text-cyan", "text-teal"];
const BG = ["bg-blue", "bg-yellow", "bg-magenta", "bg-green", "bg-red", "bg-orange", "bg-cyan", "bg-teal"];

export const toneText = (tone: number) => TEXT[tone] ?? TEXT[0];
export const toneBg = (tone: number) => BG[tone] ?? BG[0];

const pad = (n: number) => String(n).padStart(2, "0");

/** Today in the browser's timezone, as YYYY-MM-DD. */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** How a due date should look on an open task: late, today, or neither. */
export function dueClass(due: string | null, closed: boolean): string {
  if (!due || closed) return "text-muted";
  const today = todayLocal();
  if (due < today) return "text-red";
  if (due === today) return "text-yellow";
  return "text-muted";
}

/** "10-14" for this year, "2027-01-03" otherwise: dates stay short on cards. */
export function shortDate(date: string): string {
  return date.slice(0, 4) === todayLocal().slice(0, 4) ? date.slice(5) : date;
}

export const isDraft = (id: string) => id.startsWith("temp-");

/** A moment as a short stamp: the time if it was today, else the day ("14:03", "02 Oct"). */
export function when(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/** A priority's colour, wherever it is written out (the list view, a task being read). */
export const PRIORITY_CLASS = { urgent: "text-red", high: "text-orange", normal: "text-muted", low: "text-faint" } as const;
