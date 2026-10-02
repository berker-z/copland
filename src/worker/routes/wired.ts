/* ============================================================================
   GET /api/wired: what your agents have on, for the /wired pane.
   ----------------------------------------------------------------------------
   A personal read (mine(null) in index.ts): a person's own agents, never
   anyone else's, and no agent reaches it. Only tasks on boards the person
   can see (boardsFor), assigned to one of their agents that is not deleted,
   sorted onto four poles:

     blocked  in a blocked-category stage, claimed or not: waiting on a person
     doing    a live claim by a run of one of the agents (live), or else in an
              active-category stage with no run on it (not live, drawn dimmer)
     todo     in a todo-category stage, not claimed
     done     in a done-category stage, completed within DONE_WINDOW_HOURS,
              newest first, at most DONE_LIMIT (doneCount has them all)

   Backlog and cancelled never show. It writes nothing, so it notifies
   nobody; the pane refetches on the board topic, which every task move,
   claim and run ending already sends to everyone on the board, the owner
   included. A claim that lapses sends nothing, so the pane also polls.
   ========================================================================== */

import type { Viewer, Wired, WiredTask } from "@/domain/types";
import { boardsFor } from "../access";
import type { Env } from "../env";
import { json } from "../http";
import { LIVE_CLAIM } from "../repo/runs";

export const DONE_WINDOW_HOURS = 24;
export const DONE_LIMIT = 20;

interface Row {
  id: string;
  board_id: string;
  key: string;
  title: string;
  category: string;
  completed_at: string | null;
  updated_at: string;
  agent_id: string;
  claimed_at: string | null;
  stage_position: number;
  rank: number;
}

export async function getWired(env: Env, viewer: Viewer): Promise<Response> {
  const db = env.DB;
  const me = viewer.user.id;
  const { results: agents } = await db
    .prepare(
      `SELECT u.id, u.handle, a.name, a.paused_at FROM users u JOIN agents a ON a.user_id = u.id
        WHERE u.owner_id = ?1 AND u.kind = 'agent' AND u.disabled_at IS NULL ORDER BY a.created_at`,
    )
    .bind(me)
    .all<{ id: string; handle: string; name: string; paused_at: string | null }>();

  const wired: Wired = {
    agents: agents.map((a) => ({ id: a.id, handle: a.handle, name: a.name, paused: a.paused_at !== null })),
    todo: [],
    doing: [],
    blocked: [],
    done: [],
    doneCount: 0,
    doneWindowHours: DONE_WINDOW_HOURS,
  };
  const boards = await boardsFor(db, viewer);
  if (agents.length === 0 || boards.length === 0) return json(wired);

  const since = new Date(Date.now() - DONE_WINDOW_HOURS * 3600_000).toISOString();
  const ids = boards.map((b) => b.id);
  /* One row per task and assigned agent of mine; the claim only when it is
     live and that agent's. A task with two of my agents on it comes twice,
     and the claimer's row wins below. */
  const { results } = await db
    .prepare(
      `SELECT t.id, t.board_id, b.key || '-' || t.number AS key, t.title, s.category, t.completed_at, t.updated_at,
              s.position AS stage_position, t.rank, u.id AS agent_id,
              CASE WHEN c.user_id = u.id AND ${LIVE_CLAIM} THEN c.claimed_at END AS claimed_at
         FROM tasks t
         JOIN boards b ON b.id = t.board_id
         JOIN stages s ON s.id = t.stage_id
         JOIN task_assignees ta ON ta.task_id = t.id
         JOIN users u ON u.id = ta.user_id AND u.owner_id = ?1 AND u.kind = 'agent' AND u.disabled_at IS NULL
         LEFT JOIN task_claims c ON c.task_id = t.id
         LEFT JOIN runs r ON r.id = c.run_id
        WHERE t.deleted_at IS NULL
          AND t.board_id IN (${ids.map((_, i) => `?${i + 3}`).join(",")})
          AND (s.category IN ('todo', 'active', 'blocked') OR (s.category = 'done' AND t.completed_at >= ?2))
        ORDER BY t.board_id, s.position, t.rank, t.number`,
    )
    .bind(me, since, ...ids)
    .all<Row>();

  const byTask = new Map<string, Row>();
  for (const row of results) {
    const seen = byTask.get(row.id);
    if (!seen || (!seen.claimed_at && row.claimed_at)) byTask.set(row.id, row);
  }

  const doing: WiredTask[] = [];
  const done: WiredTask[] = [];
  for (const row of byTask.values()) {
    const task = (since: string | null, live = false): WiredTask => ({
      id: row.id,
      boardId: row.board_id,
      key: row.key,
      title: row.title,
      agentId: row.agent_id,
      since,
      live,
    });
    if (row.category === "blocked") wired.blocked.push(task(row.updated_at));
    else if (row.claimed_at) doing.push(task(row.claimed_at, true));
    else if (row.category === "active") doing.push(task(null));
    else if (row.category === "todo") wired.todo.push(task(row.updated_at));
    else if (row.category === "done") done.push(task(row.completed_at));
  }
  wired.doing = doing.sort((a, b) =>
    a.live !== b.live ? (a.live ? -1 : 1) : (a.since ?? "").localeCompare(b.since ?? ""),
  );
  done.sort((a, b) => (b.since ?? "").localeCompare(a.since ?? ""));
  wired.doneCount = done.length;
  wired.done = done.slice(0, DONE_LIMIT);
  return json(wired);
}
