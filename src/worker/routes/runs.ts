/* ============================================================================
   Runs and claims (migrations/0015_runs_claims.sql, 0018_interactive_runs.sql,
   docs/AGENT-IDENTITIES.md).
   ----------------------------------------------------------------------------
     POST   /api/runs               { client? } → { run, secret }
     GET    /api/runs/current       { run: { id, short, kind } | null }: this credential's run
     GET    /api/runs/:id           the run, with what it has claimed
     POST   /api/runs/:id/finish    { status: completed | failed | cancelled }
     POST   /api/tasks/:id/claim    this run takes the task
     DELETE /api/tasks/:id/claim    this run lets it go

   A run is started with a principal's own token, never a session: whoever
   launches the runtime (a daemon, a script) calls POST /api/runs and hands
   the runtime the secret, so the model never has to remember a run id. That
   secret is the run's credential (tokens.ts): the same principal and scope as
   the token that started it, and every call through it is the run's sign of
   life and lands in the history with the run. Starting a run is a write, so
   a read-only token cannot, and a run's own secret cannot start another.

   One lease length (RUN_LEASE_MS, domain/runs.ts) and nothing that sweeps: a
   run gone quiet reads as stale, and its claims lapse, when someone looks.

   That is a supervised run. A chat session (Claude Code, Codex in a
   terminal) has no launcher to start one, so a claim made with a token and
   no run's secret runs under the token's interactive run, made right there
   if it has none (repo/runs.ts interactiveRun). Every request with that
   token renews it, as every request with a secret renews its run; for
   Claude Code, a hook calling the MCP's `heartbeat` makes that every tool
   use. GET /api/runs/current is what heartbeat calls: it reads nothing,
   since the renewing happens in tokens.ts touchStatements for any request.

   Claiming is how a run takes work. It needs a run, the editor role, and a
   task that is open and either unassigned (the claimer takes it) or assigned
   to the claimer; one assigned to anyone else is refused. One live claim per
   task: another run's is refused until it lapses or its run ends, and then
   it is simply replaced. A claim moves the task to the board's first active
   stage unless it is in one already, and its parents follow in the same
   batch. The claim, the assignment, the move and the log go in one batch
   whose second statement fails unless this run holds the claim, so two runs
   racing for a task cannot both win. A refusal is a 409 whose `code` says
   why: closed, assigned_elsewhere or claimed (domain/runs.ts).

   A claim ends with its run (finish, or the principal paused, deleted or
   disabled), with an explicit release, when its task closes, is deleted or
   goes to a blocked stage, and when the claimer comes off the task's
   assignees (routes/tasks.ts).
   ========================================================================== */

import { clientLabel } from "@/domain/clients";
import { RUN_ENDINGS, shortRunId, type ClaimRefusal, type RunEnding, type RunKind } from "@/domain/runs";
import type { StartedRun, Viewer } from "@/domain/types";
import { personOf } from "../access";
import type { Env } from "../env";
import { badRequest, conflict, forbidden, json, notFound, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import { boardAudience } from "../repo/boards";
import { claimUntil, finishRunStatements, findRun, interactiveRun, LIVE_CLAIM } from "../repo/runs";
import { bottomRank, eventStatement, findTask, listStages } from "../repo/tasks";
import { enterRun, mint, RUN_PREFIX } from "../tokens";
import { followStatements, requireAssignable, taskFor, written } from "./tasks";

const NO_TOKEN =
  "Claiming is for a connection with a token (an assistant, or whatever launches one); in the app, assign yourself and move the task instead.";

/**
 * GET /api/runs/current: the run this credential works in, a run's secret's
 * or the token's interactive one, or null. From the resolved credential
 * alone, no query: the MCP's heartbeat calls it on every tool use, and the
 * request's own touch (tokens.ts) is what renews the run.
 */
export async function getCurrentRun(viewer: Viewer): Promise<Response> {
  const a = viewer.access;
  const id = a?.runId ?? a?.interactiveRunId ?? null;
  const kind: RunKind = a?.runId ? "supervised" : "interactive";
  return json({ run: id ? { id, short: shortRunId(id), kind } : null });
}

/** POST /api/runs { client? }: a new run of the token's principal, and its secret, once. */
export async function postRun(request: Request, env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  const access = viewer.access;
  if (!access) throw forbidden("A run is started with an API token, not from the app");
  if (access.runId) throw forbidden("This is a run's own credential; start a new run with the token itself");
  const body = await readJson(request);
  if (body.client !== undefined && (typeof body.client !== "string" || body.client.length > 60)) {
    throw badRequest("`client` must be a string of at most 60 characters");
  }
  const client = typeof body.client === "string" && body.client.trim() ? body.client.trim() : null;
  const { secret, hash } = await mint(RUN_PREFIX);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO runs (id, user_id, token_id, token_hash, client) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(id, viewer.user.id, access.tokenId, hash, client)
    .run();
  /* An agent's runs show on its owner's settings page. */
  if (viewer.agent) changes.notify([personOf(viewer)], "agents");
  const run = await findRun(env.DB, id);
  if (!run) throw new Error("Run insert reported success but no row");
  const { userId: _userId, ...shown } = run;
  return json({ run: shown, secret } satisfies StartedRun, { status: 201 });
}

/** A run of the viewer's own, or a 404: nobody else's runs are reachable here. */
async function ownRun(db: D1Database, viewer: Viewer, id: string) {
  const run = await findRun(db, id);
  if (!run || run.userId !== viewer.user.id) throw notFound("No such run");
  return run;
}

/** GET /api/runs/:id. Like any call through the run, also a sign of life. */
export async function getRun(env: Env, viewer: Viewer, id: string): Promise<Response> {
  const { userId: _userId, ...run } = await ownRun(env.DB, viewer, id);
  return json(run);
}

/**
 * POST /api/runs/:id/finish { status }: the run is over, its claims are
 * released, and its secret stops working. Finishing one already over
 * changes nothing and answers with it as it is, so a retry is harmless.
 */
export async function postRunFinish(request: Request, env: Env, viewer: Viewer, id: string, changes: Changes) {
  const db = env.DB;
  const body = await readJson(request);
  if (!(RUN_ENDINGS as readonly unknown[]).includes(body.status)) {
    throw badRequest(`\`status\` must be one of ${RUN_ENDINGS.join(", ")}`);
  }
  await ownRun(db, viewer, id);
  const { results: boards } = await db
    .prepare(
      `SELECT DISTINCT t.board_id FROM task_claims c JOIN runs r ON r.id = c.run_id JOIN tasks t ON t.id = c.task_id
        WHERE c.run_id = ?1 AND ${LIVE_CLAIM}`,
    )
    .bind(id)
    .all<{ board_id: string }>();
  await db.batch(finishRunStatements(db, id, body.status as RunEnding));
  for (const b of boards) changes.notify(await boardAudience(db, b.board_id), "board");
  if (viewer.agent) changes.notify([personOf(viewer)], "agents");
  const { userId: _userId, ...run } = await ownRun(db, viewer, id);
  return json(run);
}

interface ClaimRow {
  run_id: string;
  user_id: string;
  claimed_until: string;
  handle: string;
  kind: RunKind | null;
  client: string | null;
  live: number;
}

async function currentClaim(db: D1Database, taskId: string): Promise<ClaimRow | null> {
  return db
    .prepare(
      `SELECT c.run_id, c.user_id, c.claimed_until, u.handle, r.kind, r.client,
              (SELECT count(*) FROM runs r WHERE r.id = c.run_id AND ${LIVE_CLAIM}) AS live
         FROM task_claims c JOIN users u ON u.id = c.user_id LEFT JOIN runs r ON r.id = c.run_id
        WHERE c.task_id = ?1`,
    )
    .bind(taskId)
    .first<ClaimRow>();
}

/** A claim refused, with the reason a program reads (domain/runs.ts CLAIM_REFUSALS). */
const refused = (message: string, code: ClaimRefusal) => conflict(message, code);

const heldBy = (c: ClaimRow) =>
  c.kind === "interactive"
    ? `@${c.handle}'s interactive session${c.client ? ` in ${clientLabel(c.client)}` : ""} (run ${shortRunId(c.run_id)}), until ${c.claimed_until}`
    : `@${c.handle}'s run ${shortRunId(c.run_id)}, until ${c.claimed_until}`;

/** POST /api/tasks/:id/claim. See the header for every rule. */
export async function postClaim(env: Env, viewer: Viewer, id: string, changes: Changes): Promise<Response> {
  const db = env.DB;
  const access = viewer.access;
  if (!access) throw forbidden(NO_TOKEN);
  /* A run's secret claims for its run; a token for its interactive run, made below if it has none yet. */
  const kind: RunKind = access.runId ? "supervised" : "interactive";
  let runId = access.runId ?? access.interactiveRunId;
  const { task, board } = await taskFor(env, viewer, id, "editor");
  const me = viewer.user.id;
  const stages = await listStages(db, board.id);
  const stage = stages.find((s) => s.id === task.stageId);
  if (task.completedAt !== null || stage?.category === "done" || stage?.category === "cancelled") {
    throw refused(`${task.key} is closed; move it back to an open stage before claiming it`, "closed");
  }
  if (task.assigneeIds.length > 0 && !task.assigneeIds.includes(me)) {
    const { results } = await db
      .prepare(`SELECT handle FROM users WHERE id IN (${task.assigneeIds.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...task.assigneeIds)
      .all<{ handle: string }>();
    throw refused(
      `${task.key} is assigned to ${results.map((r) => `@${r.handle}`).join(", ")}, not you; only an assignee, or anyone on an unassigned task, can claim it`,
      "assigned_elsewhere",
    );
  }
  const existing = await currentClaim(db, task.id);
  if (existing?.live && existing.run_id !== runId) throw refused(`${task.key} is already claimed by ${heldBy(existing)}`, "claimed");

  const assigning = task.assigneeIds.length === 0;
  if (assigning) await requireAssignable(db, viewer, board.id, [me]);
  if (!runId) {
    runId = await interactiveRun(db, me, access);
    /* What this request writes from here on carries the new run, as it would have had it existed already. */
    enterRun(runId);
  }
  /* Under way: the first active stage, unless it is in one already, or the board has none. */
  const active = stage?.category === "active" ? undefined : stages.find((s) => s.category === "active");
  const rank = active ? await bottomRank(db, active.id) : task.rank;
  const now = nowIso();
  const fresh = !existing?.live;

  const follow = active
    ? await followStatements(db, viewer, board, stages, task, { stageId: active.id }, [task.parentId])
    : { statements: [], moved: [] };
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (active) {
    Object.assign(before, { stageId: task.stageId, rank: task.rank });
    Object.assign(after, { stageId: active.id, rank });
  }
  if (assigning) {
    before.assigneeIds = [];
    after.assigneeIds = [me];
  }

  try {
    await db.batch([
      /* Take it: new, or replacing a claim that lapsed or whose run ended, or renewing our own. */
      db
        .prepare(
          `INSERT INTO task_claims (task_id, run_id, user_id, claimed_at, claimed_until) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (task_id) DO UPDATE SET
             claimed_at = CASE WHEN task_claims.run_id = excluded.run_id THEN task_claims.claimed_at ELSE excluded.claimed_at END,
             run_id = excluded.run_id, user_id = excluded.user_id, claimed_until = excluded.claimed_until
           WHERE task_claims.run_id = excluded.run_id OR task_claims.claimed_until <= ?4
              OR NOT EXISTS (SELECT 1 FROM runs WHERE id = task_claims.run_id AND status = 'running')`,
        )
        .bind(task.id, runId, me, now, claimUntil(kind)),
      /* The guard: unless this run now holds the claim, insert a row that breaks
         NOT NULL, which fails the batch and undoes all of it. That is what keeps
         two runs racing for one task from both winning. */
      db
        .prepare(
          `INSERT INTO task_claims (task_id, run_id, user_id, claimed_until)
           SELECT ?1, NULL, NULL, NULL WHERE NOT EXISTS (SELECT 1 FROM task_claims WHERE task_id = ?1 AND run_id = ?2)`,
        )
        .bind(task.id, runId),
      ...(assigning ? [db.prepare(`INSERT INTO task_assignees (task_id, user_id) VALUES (?1, ?2)`).bind(task.id, me)] : []),
      ...(active
        ? [
            db
              .prepare(`UPDATE tasks SET stage_id = ?2, rank = ?3, updated_at = ?4 WHERE id = ?1`)
              .bind(task.id, active.id, rank, now),
          ]
        : []),
      /* Renewing a claim we already hold, with nothing else changing, is not news. */
      ...(fresh || active || assigning
        ? [eventStatement(db, { boardId: board.id, taskId: task.id, actorId: me, kind: "task.claimed", before, after })]
        : []),
      ...follow.statements,
    ]);
  } catch (error) {
    const held = await currentClaim(db, task.id);
    if (held?.live && held.run_id !== runId) throw refused(`${task.key} was just claimed by ${heldBy(held)}`, "claimed");
    throw error;
  }

  changes.notify(await boardAudience(db, board.id), "board");
  return json(written(await findTask(db, task.id), follow.moved));
}

/**
 * DELETE /api/tasks/:id/claim: let it go. The claim must be the viewer's
 * own (any credential of the principal that claimed it); the task keeps its
 * stage and its assignees, only the claim ends.
 */
export async function deleteClaim(env: Env, viewer: Viewer, id: string, changes: Changes): Promise<Response> {
  const db = env.DB;
  const { task, board } = await taskFor(env, viewer, id, "editor");
  const result = await db
    .prepare(`DELETE FROM task_claims WHERE task_id = ?1 AND user_id = ?2`)
    .bind(task.id, viewer.user.id)
    .run();
  if (result.meta.changes === 0) throw notFound(`You hold no claim on ${task.key}`);
  changes.notify(await boardAudience(db, board.id), "board");
  return json(await findTask(db, task.id));
}
