/* ============================================================================
   Dead runs put their tasks back (COPL-97).
   ----------------------------------------------------------------------------
   Claiming moves a task to an active stage. When the supervised run that
   claimed it dies, the claim goes with it, but the stage would stay: the
   task reads as under way with nobody on it, and GET /api/tasks/ready, which
   offers todo work only, never offers it again. So whatever ends a
   supervised run also moves the tasks it held, by how it died
   (domain/runs.ts returnTo):

     failed       back to the first todo stage, for the next run; the third
                  dead run in a row goes to blocked instead, with a comment
                  that @mentions the agent's owner
     stale        the same: nobody heard from it for its lease
     interrupted  back to todo, no strike: its launcher shut down or reloaded
     cancelled    to the first backlog stage: a person stopped it

   A run ends two ways. Its launcher finishes it (POST /api/runs/:id/finish,
   which the daemon calls when the runtime exits or is stopped), or nobody
   does, because the launcher or its machine went away: then the sweep, on
   the Worker's cron, ends runs past their lease as failed. The worktree a
   dead run leaves is the daemon's, and the next run on the task resumes it.

   Silence isn't always the run's (COPL-148). When Copland itself is down
   (D1 out of its daily quota, say), no run can be heard from, and the first
   sweep after it comes back ends every run that was going. The server can't
   tell those from runs whose machine died: it could write nothing while it
   was down, so all it has is the same quiet. The launcher can, so it keeps
   trying to finish a run until Copland answers, and a finish that lands on
   a run the sweep ended (runs.swept_at) replaces the sweep's "failed" with
   the launcher's ending. strikesOf reads stored endings, so a run that
   really completed stops counting as a strike from then on. The tasks the
   sweep put back stay where it put them: a run may have taken them since.

   Only a task still as the run left it moves: open, in an active stage,
   still assigned to the run's principal, with no live claim by another run.
   Anything else means someone has moved on, and their word stands. The move
   is a patchTask as the run's principal, so access, parents following,
   claims and live updates are the ordinary ones, and the history says why
   in its `via`. Interactive runs (chat sessions) put nothing back: a person
   closing a chat is not a crash, and their task is theirs to move.

   Messages need no putting back (COPL-124): a dead run's message claims
   end with it, and the message, still unread, waits for the next run.
   ========================================================================== */

import { leaseFor, returnTo, shortRunId, strikesOf, type RunDeath, type RunEnding } from "@/domain/runs";
import type { Viewer } from "@/domain/types";
import type { Env } from "./env";
import { HttpError } from "./http";
import { Changes } from "./live";
import { agentContext } from "./repo/agents";
import { findTask, listStages } from "./repo/tasks";
import { findUserById, rowToUser } from "./repo/users";
import { postComment } from "./routes/comments";
import { patchTask } from "./routes/tasks";
import { asVia } from "./tokens";

/** The tasks a run holds a claim row on, live or lapsed: what it may leave behind. */
export async function claimedBy(db: D1Database, runId: string): Promise<string[]> {
  const { results } = await db.prepare(`SELECT task_id FROM task_claims WHERE run_id = ?1`).bind(runId).all<{ task_id: string }>();
  return results.map((r) => r.task_id);
}

/** How a run's ending reads for its tasks: a finish says it; an interrupted cancel is the launcher's, not a person's. */
export function deathOf(status: RunEnding, interrupted: boolean): RunDeath | null {
  if (status === "completed") return null;
  if (status === "cancelled") return interrupted ? "interrupted" : "cancelled";
  return "failed";
}

/** How a put-back move is signed in the history ("via Copland: run 8f31 failed"), and told apart from a person's. */
const VIA = "Copland: run";

const HOW: Record<RunDeath, string> = {
  failed: "failed",
  stale: "went quiet",
  cancelled: "was stopped",
  interrupted: "was interrupted",
};

/** The principal as a viewer, or null when it can no longer act (an agent paused, an owner disabled). */
async function principal(db: D1Database, userId: string): Promise<Viewer | null> {
  const row = await findUserById(db, userId);
  if (!row || row.disabled_at) return null;
  const viewer: Viewer = { user: rowToUser(row) };
  if (row.kind === "agent") {
    const agent = await agentContext(db, row);
    if (!agent) return null;
    viewer.agent = agent;
  }
  return viewer;
}

/**
 * The supervised runs that claimed this task since a person last touched it
 * themselves, newest first: the input to strikesOf. What a run did, and the
 * moves this module made, are not a person touching it, even when the run's
 * principal is a person.
 */
async function claimingRuns(db: D1Database, taskId: string): Promise<Array<"running" | RunEnding>> {
  const { results } = await db
    .prepare(
      `SELECT r.status FROM events e JOIN runs r ON r.id = e.run_id
        WHERE e.task_id = ?1 AND e.kind = 'task.claimed' AND r.kind = 'supervised'
          AND e.created_at > coalesce((SELECT max(p.created_at) FROM events p JOIN users u ON u.id = p.actor_id
                                        WHERE p.task_id = ?1 AND u.kind = 'person' AND p.run_id IS NULL
                                          AND coalesce(p.via, '') NOT LIKE '${VIA} %'), '')
        ORDER BY e.created_at DESC`,
    )
    .bind(taskId)
    .all<{ status: "running" | RunEnding }>();
  return results.map((r) => r.status);
}

/**
 * Put back what a supervised run held, now that it has ended (its status is
 * already stored), saying how it ended when its finish gave a reason
 * ("via Copland: run 8f31 failed (exit 1 after 3.8s)"). `tasks` were read before it ended, since ending it
 * deletes its claims. Moves that are refused (the principal lost the
 * editor role meanwhile) are skipped: the task stays where it is.
 */
export async function putBack(
  env: Env,
  run: { id: string; userId: string },
  death: RunDeath,
  tasks: string[],
  changes: Changes,
  reason: string | null = null,
): Promise<void> {
  if (!tasks.length) return;
  const db = env.DB;
  const viewer = await principal(db, run.userId);
  if (!viewer) return;
  const died = `${shortRunId(run.id)} ${HOW[death]}${reason ? ` (${reason})` : ""}`;
  const via = `${VIA} ${died}`;
  for (const taskId of tasks) {
    const task = await findTask(db, taskId);
    if (!task || task.completedAt || !task.assigneeIds.includes(run.userId)) continue;
    const stages = await listStages(db, task.boardId);
    if (stages.find((s) => s.id === task.stageId)?.category !== "active") continue;
    const claimed = await db
      .prepare(
        `SELECT 1 FROM task_claims c JOIN runs r ON r.id = c.run_id
          WHERE c.task_id = ?1 AND c.run_id != ?2 AND c.claimed_until > ?3 AND r.status = 'running'`,
      )
      .bind(taskId, run.id, new Date().toISOString())
      .first();
    if (claimed) continue;

    const strikes = death === "failed" || death === "stale" ? strikesOf(await claimingRuns(db, taskId)) : 0;
    let want = returnTo(death, strikes);
    if (want === "blocked" && !stages.some((s) => s.category === "blocked")) want = "todo";
    const stage = stages.find((s) => s.category === want);
    if (!stage) continue;

    const move = new Request("https://copland.invalid/", { method: "PATCH", body: JSON.stringify({ stageId: stage.id }) });
    try {
      await asVia(via, () => patchTask(move, env, viewer, taskId, changes));
      if (want === "blocked") {
        const owner = viewer.agent?.owner.handle ?? viewer.user.handle;
        const text =
          `@${owner} run ${died}, and that makes ${strikes} runs in a row that died on ${task.key} without finishing. ` +
          `It waits here instead of starting again, and whatever it left (a branch, a worktree) is kept. Move it back to todo once it can go on.`;
        const say = new Request("https://copland.invalid/", { method: "POST", body: JSON.stringify({ text }) });
        await asVia(via, () => postComment(say, env, viewer, taskId, changes));
      }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }
}

/**
 * The cron's sweep: end every supervised run past its lease as failed, and
 * put back what it held. The end is guarded on the run still running and
 * still quiet, so a launcher that finishes it, or a keepalive that lands, at
 * the same moment wins cleanly, and only whoever ended it puts tasks back.
 */
export async function sweepStaleRuns(env: Env, ctx: ExecutionContext): Promise<void> {
  const db = env.DB;
  const lapsed = new Date(Date.now() - leaseFor("supervised")).toISOString();
  const { results } = await db
    .prepare(`SELECT id, user_id FROM runs WHERE kind = 'supervised' AND status = 'running' AND last_seen_at <= ?1 LIMIT 100`)
    .bind(lapsed)
    .all<{ id: string; user_id: string }>();
  const changes = new Changes();
  for (const r of results) {
    const tasks = await claimedBy(db, r.id);
    /* Still quiet as it ends, so a keepalive that just landed keeps it running. */
    const [ended] = await db.batch([
      db
        .prepare(`UPDATE runs SET status = 'failed', ended_at = ?2, swept_at = ?2 WHERE id = ?1 AND status = 'running' AND last_seen_at <= ?3`)
        .bind(r.id, new Date().toISOString(), lapsed),
      db
        .prepare(`DELETE FROM task_claims WHERE run_id = ?1 AND EXISTS (SELECT 1 FROM runs WHERE id = ?1 AND status != 'running')`)
        .bind(r.id),
      /* Its messages go back to unclaimed, for the next run to take. */
      db
        .prepare(`DELETE FROM message_claims WHERE run_id = ?1 AND EXISTS (SELECT 1 FROM runs WHERE id = ?1 AND status != 'running')`)
        .bind(r.id),
    ]);
    if (!ended.meta.changes) continue;
    try {
      await putBack(env, { id: r.id, userId: r.user_id }, "stale", tasks, changes);
    } catch (error) {
      console.warn(`putting back what run ${shortRunId(r.id)} held`, error);
    }
  }
  changes.publish(env, ctx, null);
}
