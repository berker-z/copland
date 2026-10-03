/* ============================================================================
   Overlap: the files each task's work has changed (migrations/0024_task_files.sql,
   COPL-99, COPL-102), and which open tasks share them (COPL-104).
   ----------------------------------------------------------------------------
   The daemon reports what a task's worktree changed against where the work
   started, while a run is on it and once at the end, with
   PUT /api/tasks/:id/files (worker/routes/files.ts). Copland keeps the
   latest list per task so open tasks that change the same files can be
   shown side by side. It is information, not a lock: two tasks on one file
   often merge cleanly, and two on different files can still break each
   other.

   This file is what can be checked without a database: what a report may
   say, how it is capped, who may send one, and which tasks share files.
   repo/tasks.ts reads the lists of a board's open tasks; a task's summary
   and GET /api/tasks/:id/overlap (worker/routes/files.ts) show the result.
   ========================================================================== */

/** How many paths a task keeps. A report with more keeps the first this many, sorted, and says it was truncated. */
export const TASK_FILES_CAP = 500;

/** How many paths a report may send at all; more is refused, since nothing past the cap is kept anyway. */
export const TASK_FILES_ACCEPTED = 10_000;

/** The longest path kept, in characters. */
export const TASK_FILE_MAX = 512;

/** What a task has reported, as stored. */
export interface TaskFiles {
  /** The commit the work started from. */
  base: string;
  /** Repo-relative paths, sorted, at most TASK_FILES_CAP. */
  files: string[];
  /** The work changed more files than were kept. */
  truncated: boolean;
  reportedAt: string;
}

export type FileReport = Omit<TaskFiles, "reportedAt">;

const COMMIT = /^[0-9a-f]{7,64}$/;

/**
 * Why a path is refused, or null when it is a plain repo-relative path:
 * not empty, not too long, not absolute (no leading "/", no drive letter),
 * forward slashes only, no control characters, and no empty, "." or ".."
 * segment, so every path names one file in the repo and only one way.
 */
export function pathProblem(path: string): string | null {
  if (path.length === 0) return "is empty";
  if (path.length > TASK_FILE_MAX) return `is longer than ${TASK_FILE_MAX} characters`;
  if (/[\u0000-\u001f\u007f]/.test(path)) return "has a control character";
  if (path.includes("\\")) return "has a backslash; use forward slashes";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "is absolute; send it relative to the repo's root";
  for (const segment of path.split("/")) {
    if (segment === "") return "has an empty segment";
    if (segment === "." || segment === "..") return `has a "${segment}" segment`;
  }
  return null;
}

/**
 * A report's body as it will be kept, or why it is refused: `base` a commit
 * (hex, lowercased), `files` an array of paths (see pathProblem), deduplicated
 * and sorted, and capped at TASK_FILES_CAP. `truncated` is optional: true when
 * the sender already left files out to keep the request small.
 */
export function parseFileReport(body: Record<string, unknown>): FileReport | string {
  if (typeof body.base !== "string" || !COMMIT.test(body.base.toLowerCase())) {
    return "`base` must be the commit the work started from (7 to 64 hex characters)";
  }
  if (!Array.isArray(body.files)) return "`files` must be an array of repo-relative paths";
  if (body.files.length > TASK_FILES_ACCEPTED) {
    return `\`files\` has ${body.files.length} paths; send at most ${TASK_FILES_ACCEPTED} (only ${TASK_FILES_CAP} are kept), with \`truncated\`: true`;
  }
  if (body.truncated !== undefined && typeof body.truncated !== "boolean") return "`truncated` must be a boolean";
  for (const path of body.files) {
    if (typeof path !== "string") return "`files` must be an array of repo-relative paths";
    const problem = pathProblem(path);
    if (problem) return `The path ${JSON.stringify(path.slice(0, 80))} ${problem}`;
  }
  const files = [...new Set(body.files as string[])].sort();
  return {
    base: body.base.toLowerCase(),
    files: files.slice(0, TASK_FILES_CAP),
    truncated: body.truncated === true || files.length > TASK_FILES_CAP,
  };
}

/**
 * Whether a credential may report a task's files: only a supervised run
 * (the daemon holds its secret) that holds the task's live claim. Anything
 * else is refused, with the status to answer: 403 for a credential that is
 * not a run's (a token, a session, an interactive run: an agent does not
 * report its own list), 409 when the run does not hold the task right now.
 */
export function reportRefusal(
  runId: string | null,
  claim: { runId: string; live: boolean } | null,
): { status: 403 | 409; message: string } | null {
  if (!runId) {
    return { status: 403, message: "Files are reported by the run holding the task's claim, with its run's secret (the daemon does this)" };
  }
  if (!claim || !claim.live || claim.runId !== runId) {
    return { status: 409, message: "This run doesn't hold the task's claim; claim it before reporting its files" };
  }
  return null;
}

/** Whether a report says anything new: if not, only when it was heard from moves. */
export function sameReport(a: FileReport, b: FileReport): boolean {
  return a.base === b.base && a.truncated === b.truncated && a.files.length === b.files.length && a.files.every((f, i) => f === b.files[i]);
}

/* ---------------------------------------------------------- overlap --- */

/** Another task a task shares files with, and which. */
export interface Overlap {
  taskId: string;
  /** The paths both lists have, sorted. */
  shared: string[];
}

/**
 * Which tasks share files, from the latest lists of the open tasks on one
 * board (the daemon works in a board's first repo, so one board is one repo).
 * Each task with any overlap maps to the others it shares files with, most
 * shared first, then in the order given; a task sharing nothing is absent.
 * Only what was kept counts: a truncated list can hide more.
 */
export function overlaps(tasks: ReadonlyArray<{ id: string; files: readonly string[] }>): Map<string, Overlap[]> {
  /* Who changed each file, so the work is the total number of paths, not the pairs. */
  const byFile = new Map<string, number[]>();
  tasks.forEach((task, i) => {
    for (const file of new Set(task.files)) {
      const who = byFile.get(file);
      if (who) who.push(i);
      else byFile.set(file, [i]);
    }
  });
  const shared = new Map<number, Map<number, string[]>>();
  for (const [file, who] of byFile) {
    if (who.length < 2) continue;
    for (const a of who) {
      const mine = shared.get(a) ?? new Map<number, string[]>();
      shared.set(a, mine);
      for (const b of who) if (b !== a) (mine.get(b) ?? mine.set(b, []).get(b)!).push(file);
    }
  }
  const out = new Map<string, Overlap[]>();
  for (const [a, others] of shared) {
    const list = [...others]
      .sort(([i, x], [j, y]) => y.length - x.length || i - j)
      .map(([b, files]) => ({ taskId: tasks[b].id, shared: files.sort() }));
    out.set(tasks[a].id, list);
  }
  return out;
}
