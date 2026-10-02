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

import type { MyWork, Viewer } from "@/domain/types";
import { boardsFor } from "../access";
import type { Env } from "../env";
import { json } from "../http";

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
