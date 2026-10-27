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

   Backlog and cancelled never show. Each agent comes with where it runs
   (COPL-183, for the box): the hosts its daemon reported, the latest
   first, which are live now, and whether it is live on two at once
   (agentHosts in hosts.ts); a live task says the host its run started on.
   It writes nothing, so it notifies
   nobody; the pane refetches on the board topic, which every task move,
   claim and run ending already sends to everyone on the board, the owner
   included. A claim that lapses sends nothing, so the pane also polls.

   GET /api/wired?tasks=a,b (COPL-211) is the same read for only the tasks
   named, at most MAX_TASKS: the box asks it for the tasks a live event
   names and re-sorts them onto its last whole read itself, by the stage
   and rank each task carries, so one task edit costs a few rows instead
   of the whole read.
   ========================================================================== */

import type { Viewer, Wired, WiredPart, WiredTask } from "@/domain/types";
import { boardsFor } from "../access";
import type { Env } from "../env";
import { badRequest, json } from "../http";
import { LIVE_CLAIM } from "../repo/runs";
import { agentHosts } from "./hosts";

export const DONE_WINDOW_HOURS = 24;
export const DONE_LIMIT = 20;

/** A task and one of my agents on it, and its live claim when that agent's run holds one. */
interface Row {
  id: string;
  board_id: string;
  number: number;
  title: string;
  stage_id: string;
  completed_at: string | null;
  updated_at: string;
  rank: number;
  agent_id: string;
  claimed_at: string | null;
  /** The live claim's run's host, when its launcher named one. */
  host: string | null;
}

interface Stage {
  category: string;
  position: number;
}

/** What sort() needs besides the rows: each board's key, and the stages the rows are in. */
interface Places {
  keys: Map<string, string>;
  stages: Map<string, Stage>;
}

/** Most tasks GET /api/wired?tasks= names at once; the box reads the whole of it past that. */
export const MAX_TASKS = 50;

const OPEN_POLES = ["todo", "active", "blocked"];

export async function getWired(env: Env, viewer: Viewer, url?: URL): Promise<Response> {
  const asked = url?.searchParams.get("tasks");
  if (asked !== null && asked !== undefined) return json(await wiredPart(env, viewer, asked));
  const db = env.DB;
  const me = viewer.user.id;
  const { results: agents } = await db
    .prepare(
      `SELECT u.id, u.handle, a.name, a.paused_at FROM users u JOIN agents a ON a.user_id = u.id
        WHERE u.owner_id = ?1 AND u.kind = 'agent' AND u.disabled_at IS NULL ORDER BY a.created_at`,
    )
    .bind(me)
    .all<{ id: string; handle: string; name: string; paused_at: string | null }>();

  const hosts = agents.length > 0 ? await agentHosts(env, me, agents.map((a) => a.id)) : new Map<string, never>();
  const wired: Wired = {
    agents: agents.map((a) => ({
      id: a.id,
      handle: a.handle,
      name: a.name,
      paused: a.paused_at !== null,
      hosts: (hosts.get(a.id)?.hosts ?? []).map((h) => ({ hostname: h.hostname, live: h.live })),
      liveOnTwoHosts: hosts.get(a.id)?.liveOnTwoHosts ?? false,
    })),
    todo: [],
    doing: [],
    blocked: [],
    done: [],
    doneCount: 0,
    doneWindowHours: DONE_WINDOW_HOURS,
    doneLimit: DONE_LIMIT,
  };
  if (agents.length === 0) return json(wired);
  const boards = await boardsFor(db, viewer);
  if (boards.length === 0) return json(wired);

  const ids = boards.map((b) => b.id);
  /* The boards' stages once, rather than a stage and a board row for every
     task (COPL-211): the open ones say which tasks to read. */
  const { results: stageRows } = await db
    .prepare(`SELECT id, category, position FROM stages WHERE board_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
    .bind(...ids)
    .all<Stage & { id: string }>();
  const stages = new Map(stageRows.map((s) => [s.id, { category: s.category, position: s.position }]));
  const open = stageRows.filter((s) => OPEN_POLES.includes(s.category)).map((s) => s.id);
  const keys = new Map(boards.map((b) => [b.id, b.key]));

  /* The tasks it can draw first, each half through its own index so
     nothing reads a board's history or its backlog: those in an open
     stage (tasks_board), and those finished inside the window
     (tasks_completed). */
  const on = `board_id IN (${ids.map((_, i) => `?${i + 3}`).join(",")}) AND deleted_at IS NULL`;
  const inOpen = open.length > 0 ? `stage_id IN (${open.map((_, i) => `?${i + 3 + ids.length}`).join(",")})` : "0";
  const w = `SELECT id FROM tasks WHERE ${on} AND ${inOpen}
             UNION ALL
             SELECT id FROM tasks WHERE ${on} AND completed_at >= ?2`;
  const sorted = sort(await rows(db, me, w, [...ids, ...open]), { keys, stages });
  Object.assign(wired, sorted.poles);
  wired.doneCount = sorted.doneCount;
  return json(wired);
}

/**
 * GET /api/wired?tasks=a,b: the same poles, for just those tasks (COPL-211),
 * so the box re-sorts what a live event named onto its last whole read
 * instead of reading it all again. A task it leaves out is on no pole now.
 * No agents, no hosts, no doneCount: what changes those is read whole.
 */
async function wiredPart(env: Env, viewer: Viewer, asked: string): Promise<WiredPart> {
  const tasks = [...new Set(asked.split(",").map((id) => id.trim()).filter(Boolean))];
  if (tasks.length === 0) throw badRequest("tasks names no task");
  if (tasks.length > MAX_TASKS) throw badRequest(`tasks names at most ${MAX_TASKS} tasks`);
  const part: WiredPart = { tasks, todo: [], doing: [], blocked: [], done: [], doneLimit: DONE_LIMIT };
  const db = env.DB;
  const boards = await boardsFor(db, viewer);
  if (boards.length === 0) return part;
  const ids = boards.map((b) => b.id);
  const w = `SELECT id FROM tasks WHERE id IN (${tasks.map((_, i) => `?${i + 3 + ids.length}`).join(",")})
               AND board_id IN (${ids.map((_, i) => `?${i + 3}`).join(",")}) AND deleted_at IS NULL`;
  const found = await rows(db, viewer.user.id, w, [...ids, ...tasks]);
  /* A few tasks: their own stages, not the boards' every one. */
  const stageIds = [...new Set(found.map((r) => r.stage_id))];
  const { results: stageRows } = stageIds.length
    ? await db
        .prepare(`SELECT id, category, position FROM stages WHERE id IN (${stageIds.map((_, i) => `?${i + 1}`).join(",")})`)
        .bind(...stageIds)
        .all<Stage & { id: string }>()
    : { results: [] };
  const stages = new Map(stageRows.map((s) => [s.id, { category: s.category, position: s.position }]));
  Object.assign(part, sort(found, { keys: new Map(boards.map((b) => [b.id, b.key])), stages }).poles);
  return part;
}

/** One row per task in `w` and assigned agent of `me`'s; the claim only when it is live and that agent's. */
async function rows(db: D1Database, me: string, w: string, args: string[]): Promise<Row[]> {
  const since = new Date(Date.now() - DONE_WINDOW_HOURS * 3600_000).toISOString();
  /* A task with two of my agents on it comes twice, and the claimer's row
     wins in sort(). The CROSS JOINs keep the order, and read a task's own
     row only once one of my agents is on it: left to itself, SQLite starts
     from my agents' assignments, which is every task they ever had. */
  const { results } = await db
    .prepare(
      `WITH w(id) AS (${w})
       SELECT t.id, t.board_id, t.number, t.title, t.stage_id, t.completed_at, t.updated_at, t.rank, u.id AS agent_id,
              CASE WHEN c.user_id = u.id AND ${LIVE_CLAIM} THEN c.claimed_at END AS claimed_at,
              CASE WHEN c.user_id = u.id AND ${LIVE_CLAIM} THEN r.host END AS host
         FROM w
         CROSS JOIN task_assignees ta ON ta.task_id = w.id
         CROSS JOIN users u ON u.id = ta.user_id AND u.owner_id = ?1 AND u.kind = 'agent' AND u.disabled_at IS NULL
         CROSS JOIN tasks t ON t.id = w.id
         LEFT JOIN task_claims c ON c.task_id = t.id
         LEFT JOIN runs r ON r.id = c.run_id
        WHERE t.completed_at IS NULL OR t.completed_at >= ?2`,
    )
    .bind(me, since, ...args)
    .all<Row>();
  return results;
}

type Poles = Pick<Wired, "todo" | "doing" | "blocked" | "done">;

/**
 * Rows onto their poles, in the order each keeps (see the header): todo and
 * blocked by board, stage, rank and number; done capped at DONE_LIMIT.
 * Backlog and cancelled go nowhere.
 */
function sort(results: Row[], { keys, stages }: Places): { poles: Poles; doneCount: number } {
  const byTask = new Map<string, Row>();
  for (const row of results) {
    const seen = byTask.get(row.id);
    if (!seen || (!seen.claimed_at && row.claimed_at)) byTask.set(row.id, row);
  }
  const placed = [...byTask.values()].flatMap((row) => {
    const stage = stages.get(row.stage_id);
    return stage ? [{ row, stage }] : [];
  });
  placed.sort(
    (a, b) =>
      a.row.board_id.localeCompare(b.row.board_id) ||
      a.stage.position - b.stage.position ||
      a.row.rank - b.row.rank ||
      a.row.number - b.row.number,
  );

  const poles: Poles = { todo: [], doing: [], blocked: [], done: [] };
  const done: WiredTask[] = [];
  for (const { row, stage } of placed) {
    const task = (since: string | null, live = false): WiredTask => ({
      id: row.id,
      boardId: row.board_id,
      key: `${keys.get(row.board_id)}-${row.number}`,
      title: row.title,
      agentId: row.agent_id,
      since,
      live,
      host: live ? row.host : null,
      stage: stage.position,
      rank: row.rank,
    });
    if (stage.category === "blocked") poles.blocked.push(task(row.updated_at));
    else if (row.claimed_at && OPEN_POLES.includes(stage.category)) poles.doing.push(task(row.claimed_at, true));
    else if (stage.category === "active") poles.doing.push(task(null));
    else if (stage.category === "todo") poles.todo.push(task(row.updated_at));
    else if (stage.category === "done" && row.completed_at) done.push(task(row.completed_at));
  }
  poles.doing.sort((a, b) => (a.live !== b.live ? (a.live ? -1 : 1) : (a.since ?? "").localeCompare(b.since ?? "")));
  done.sort((a, b) => (b.since ?? "").localeCompare(a.since ?? ""));
  poles.done = done.slice(0, DONE_LIMIT);
  return { poles, doneCount: done.length };
}
