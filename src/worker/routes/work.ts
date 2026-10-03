/* ============================================================================
   GET /api/tasks/mine: whose work is whose, decided once.
   ----------------------------------------------------------------------------
   The /tasks pane and the MCP's my_work both read this, so the app and an
   assistant can never disagree about what is yours (docs/AGENT-IDENTITIES.md).

     mine       tasks assigned to you, on any board you can see; and for a
                person, the tasks in their inbox assigned to nobody, which
                are theirs by being there
     delegated  for a person, tasks assigned to one of their agents and not
                to them: handed off, still worth watching

   An agent's work is only what it was given. Being on a board, its owner's
   inbox included, never makes a task its own.

   Open and finished alike (the pane folds the finished away), never deleted,
   and only on boards the viewer can see at all; the client reads the tasks
   themselves from those boards, so access is the board routes' as usual.
   ========================================================================== */

import type { MyWork, ReadyTask, Viewer } from "@/domain/types";
import { boardsFor } from "../access";
import type { Env } from "../env";
import { json } from "../http";
import { LIVE_CLAIM } from "../repo/runs";

export async function getMyWork(env: Env, viewer: Viewer): Promise<Response> {
  const boards = await boardsFor(env.DB, viewer);
  const work: MyWork = { mine: [], delegated: [] };
  if (boards.length === 0) return json(work);

  const me = viewer.user.id;
  const agent = !!viewer.agent;
  const inbox = agent ? null : (boards.find((b) => b.isInbox)?.id ?? null);
  const ids = boards.map((b) => b.id);
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.board_id,
            EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?1) AS assigned_me,
            EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id) AS assigned_any,
            EXISTS (SELECT 1 FROM task_assignees a JOIN users u ON u.id = a.user_id
                     WHERE a.task_id = t.id AND u.owner_id = ?1) AS assigned_my_agent
       FROM tasks t
      WHERE t.deleted_at IS NULL AND t.board_id IN (${ids.map((_, i) => `?${i + 2}`).join(",")})
      ORDER BY t.created_at`,
  )
    .bind(me, ...ids)
    .all<{ id: string; board_id: string; assigned_me: number; assigned_any: number; assigned_my_agent: number }>();

  for (const row of results) {
    const ref = { taskId: row.id, boardId: row.board_id };
    if (row.assigned_me || (row.board_id === inbox && !row.assigned_any)) work.mine.push(ref);
    else if (!agent && row.assigned_my_agent) work.delegated.push(ref);
  }
  return json(work);
}

/* ---------------------------------------------------------------- ready -- */

/**
 * GET /api/tasks/ready: the caller's tasks that can be started now (COPL-86).
 * Assigned to the caller, in a todo stage, not a milestone (a checkpoint, not
 * work), every task it depends on closed (for code, merged: COPL-78), and no
 * live claim on it. What the daemon pulls besides its inbox, so work an agent
 * gave itself, or work whose dependencies just closed, starts without anyone
 * saying so. Copland decides whether work may start; the daemon only asks.
 */
export async function getReady(env: Env, viewer: Viewer): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT t.id, b.key || '-' || t.number AS key, t.board_id, t.updated_at
       FROM tasks t
       JOIN boards b ON b.id = t.board_id AND b.archived_at IS NULL
       JOIN board_members m ON m.board_id = t.board_id AND m.user_id = ?1
       JOIN stages s ON s.id = t.stage_id AND s.category = 'todo'
      WHERE t.deleted_at IS NULL AND t.completed_at IS NULL
        AND coalesce(t.level, 'task') != 'milestone'
        AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?1)
        AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks u ON u.id = d.depends_on_id
                         WHERE d.task_id = t.id AND u.deleted_at IS NULL AND u.completed_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM task_claims c JOIN runs r ON r.id = c.run_id
                         WHERE c.task_id = t.id AND ${LIVE_CLAIM})
      ORDER BY t.created_at
      LIMIT 50`,
  )
    .bind(viewer.user.id)
    .all<{ id: string; key: string; board_id: string; updated_at: string }>();
  const ready: ReadyTask[] = results.map((r) => ({ id: r.id, key: r.key, boardId: r.board_id, updatedAt: r.updated_at }));
  return json({ tasks: ready });
}
