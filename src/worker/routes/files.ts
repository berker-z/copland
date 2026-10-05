/* ============================================================================
   Overlap: a task's changed files, as its run reports them, and which open
   tasks share them (migrations/0024_task_files.sql, src/domain/overlap.ts,
   COPL-102, COPL-104).
   ----------------------------------------------------------------------------
     PUT /api/tasks/:id/files     { base, files, truncated? } → { base, count, truncated, reportedAt }
     GET /api/tasks/:id/overlap   → { files: { reported_at, base, files, truncated } | null,
                                      overlaps: [{ key, title, assignees, claimed_by, shared, reported_at }] }

   The daemon calls it with the run's secret while a run holds the task, and
   once at the end. Only that run may: a token, a session or an interactive
   run gets a 403, and a run that doesn't hold the task's live claim a 409
   (code not_claimed). The claim is checked again in the write itself, so a
   claim that lapses in between writes nothing. The editor role comes from
   requireBoard, and runApi refuses a read-only token before any of this.

   A report replaces the task's last one. One that says nothing new only
   moves reported_at and tells nobody; a changed one tells the board's
   audience to refetch.

   Reading overlap needs only the viewer role. It compares the task with the
   other open tasks on its board (the daemon works in a board's first repo),
   and is information, not a lock.
   ========================================================================== */

import { overlaps, parseFileReport, reportRefusal, sameReport, type TaskOverlapRead } from "@/domain/overlap";
import type { Viewer } from "@/domain/types";
import type { Env } from "../env";
import { badRequest, conflict, forbidden, json, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import { boardAudience } from "../repo/boards";
import { LIVE_CLAIM } from "../repo/runs";
import { openTaskFiles } from "../repo/tasks";
import { taskFor } from "./tasks";

const notClaimed = (message: string) => conflict(message, "not_claimed");

/** PUT /api/tasks/:id/files. See the header. */
export async function putTaskFiles(request: Request, env: Env, viewer: Viewer, id: string, changes: Changes): Promise<Response> {
  const db = env.DB;
  const runId = viewer.access?.runId ?? null;
  /* Not a run's credential at all: refused before anything is read. */
  const early = reportRefusal(runId, null);
  if (early?.status === 403) throw forbidden(early.message);
  const { task, board } = await taskFor(env, viewer, id, "editor");
  const body = await readJson(request);
  const report = parseFileReport(body);
  if (typeof report === "string") throw badRequest(report);

  const claim = await db
    .prepare(
      `SELECT c.run_id, EXISTS (SELECT 1 FROM runs r WHERE r.id = c.run_id AND ${LIVE_CLAIM}) AS live
         FROM task_claims c WHERE c.task_id = ?1`,
    )
    .bind(task.id)
    .first<{ run_id: string; live: number }>();
  const refusal = reportRefusal(runId, claim && { runId: claim.run_id, live: claim.live === 1 });
  if (refusal) throw notClaimed(`${task.key}: ${refusal.message}`);

  const before = await db
    .prepare(`SELECT base, files, truncated FROM task_files WHERE task_id = ?1`)
    .bind(task.id)
    .first<{ base: string; files: string; truncated: number }>();
  const unchanged =
    before !== null &&
    sameReport(report, { base: before.base, files: JSON.parse(before.files) as string[], truncated: before.truncated === 1 });

  const reportedAt = nowIso();
  /* Written only while this run still holds a live claim on the task. */
  const written = await db
    .prepare(
      `INSERT INTO task_files (task_id, run_id, base, files, truncated, reported_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE EXISTS (SELECT 1 FROM task_claims c JOIN runs r ON r.id = c.run_id
                       WHERE c.task_id = ?1 AND c.run_id = ?2 AND ${LIVE_CLAIM})
       ON CONFLICT (task_id) DO UPDATE SET
         run_id = excluded.run_id, base = excluded.base, files = excluded.files,
         truncated = excluded.truncated, reported_at = excluded.reported_at`,
    )
    .bind(task.id, runId, report.base, JSON.stringify(report.files), report.truncated ? 1 : 0, reportedAt)
    .run();
  if (!written.meta.changes) throw notClaimed(`${task.key}: this run's claim just lapsed; claim it again before reporting its files`);

  if (!unchanged) changes.board(await boardAudience(db, board.id), { board: board.id });
  return json({ base: report.base, count: report.files.length, truncated: report.truncated, reportedAt });
}

/**
 * GET /api/tasks/:id/overlap, viewer and up: the task's latest report and the
 * other open tasks on its board that share files with it, most shared first.
 * files is null before the first report, and again a week after the task
 * closes (housekeeping.ts); a closed task overlaps nothing.
 */
export async function getTaskOverlap(env: Env, viewer: Viewer, id: string): Promise<Response> {
  const { task } = await taskFor(env, viewer, id, "viewer");
  const [mine, open] = await Promise.all([
    env.DB.prepare(`SELECT base, files, truncated, reported_at FROM task_files WHERE task_id = ?1`)
      .bind(task.id)
      .first<{ base: string; files: string; truncated: number; reported_at: string }>(),
    openTaskFiles(env.DB, task.boardId),
  ]);
  const byId = new Map(open.map((t) => [t.id, t]));
  const others = byId.has(task.id) ? (overlaps(open).get(task.id) ?? []) : [];
  const body: TaskOverlapRead = {
    files: mine && {
      reported_at: mine.reported_at,
      base: mine.base,
      files: JSON.parse(mine.files) as string[],
      truncated: mine.truncated === 1,
    },
    overlaps: others.map((o) => {
      const t = byId.get(o.taskId)!;
      return {
        key: t.key,
        title: t.title,
        assignees: t.assignees.map((h) => `@${h}`),
        claimed_by: t.claimedBy && `@${t.claimedBy}`,
        shared: o.shared,
        reported_at: t.reportedAt,
      };
    }),
  };
  return json(body);
}
