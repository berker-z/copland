/* ============================================================================
   Drift (COPL-75, COPL-93; docs/GITHUB.md): measured per PR, reported to
   GitHub as the copland/drift commit status.
   ----------------------------------------------------------------------------
   Parallel agents each start from the default branch as it was. If it moves
   in the files a task changes while the task is under way, the task's code
   may rest on how those files used to be: it compiles, its tests pass, and
   it's quietly wrong. So for a PR naming a task, Copland compares, with the
   App:

     base     where the work started: the parent of the PR's first commit
     main     the default branch's head now
     files    what main changed since base, what the PR changes, the overlap

   and posts copland/drift on the PR's head (domain/github.ts driftStatus):
   pending while the branch is behind main, or while the overlap hasn't been
   re-checked against this very main (revalidate, routes/github.ts); green
   otherwise. Branch protection requires it, so no runtime can merge past it.
   An overlap of DRIFT_REVIEW files or more also makes the task review first,
   as the person who connected the repo, "via GitHub": its author doesn't
   merge it.

   Measured when the PR opens or moves, when the default branch moves (every
   open PR on that repo), and when someone revalidates. Runs after the
   webhook has answered (waitUntil), with its own live-update batch.
   ========================================================================== */

import { DRIFT_REVIEW, driftState, driftStatus, overlapOf, type Drift } from "@/domain/github";
import { taskPath } from "@/domain/tasks";
import type { Viewer } from "@/domain/types";
import type { Env } from "./env";
import { badRequest, conflict, HttpError, json, readJson } from "./http";
import { branchHead, compare, postStatus, pullBase, repoDefaultBranch, repoToken } from "./githubApp";
import { Changes } from "./live";
import { boardAudience } from "./repo/boards";
import { findUserById, rowToUser } from "./repo/users";
import { asVia } from "./tokens";
import { postComment } from "./routes/comments";
import { patchTask, taskFor } from "./routes/tasks";

export const DRIFT_CONTEXT = "copland/drift";

interface PullRow {
  id: string;
  task_id: string;
  task_key: string;
  board_id: string;
  connected_by: string;
  base_sha: string | null;
  revalidated_main: string | null;
  review_first: number;
}

/** A PR's rows: one per task it names, on every board its repo is connected to. */
async function pullRows(db: D1Database, repo: string, number: number): Promise<PullRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.task_id, b.key || '-' || t.number AS task_key, t.board_id, r.connected_by,
              c.base_sha, c.revalidated_main, t.review_first
         FROM task_code c
         JOIN board_repos r ON r.id = c.repo_id
         JOIN tasks t ON t.id = c.task_id AND t.deleted_at IS NULL
         JOIN boards b ON b.id = t.board_id
        WHERE r.repo = ?1 AND c.kind = 'pull' AND c.name = ?2`,
    )
    .bind(repo, String(number))
    .all<PullRow>();
  return results;
}

export interface PullRef {
  repo: string;
  number: number;
  /** The PR's head commit. */
  head: string;
  /** The branch it merges into: the default branch, for a task's PR. */
  into: string;
}

/**
 * Measure a PR's drift, keep it on its rows, post copland/drift, and make its
 * tasks review first when the overlap is large. Null when Copland can't say:
 * no task names the PR, or the App isn't installed on the repo.
 */
export async function measureDrift(env: Env, ctx: ExecutionContext, pr: PullRef, origin: string): Promise<Drift | null> {
  const rows = await pullRows(env.DB, pr.repo, pr.number);
  if (!rows.length) return null;
  const token = await repoToken(env, pr.repo);
  if (!token) return null;

  const main = await branchHead(token, pr.repo, pr.into);
  const base = rows.find((r) => r.base_sha)?.base_sha ?? (await pullBase(token, pr.repo, pr.number));
  const head = await compare(token, pr.repo, main, pr.head);
  const mainFiles = base === main ? [] : (await compare(token, pr.repo, base, main)).files;
  const drift: Drift = {
    main,
    base,
    behind: head.behind,
    mainFiles,
    taskFiles: head.files,
    overlap: overlapOf(mainFiles, head.files),
    revalidated: rows.some((r) => r.revalidated_main === main),
  };

  const json = JSON.stringify(drift);
  await env.DB.batch(
    rows.map((r) => env.DB.prepare(`UPDATE task_code SET base_sha = coalesce(base_sha, ?2), drift = ?3 WHERE id = ?1`).bind(r.id, base, json)),
  );
  const status = driftStatus(drift);
  try {
    await postStatus(token, pr.repo, pr.head, { context: DRIFT_CONTEXT, ...status, url: `${origin}${taskPath(rows[0].task_key)}` });
  } catch (error) {
    /* Most likely the App has no statuses: write yet (an App made before COPL-93): the drift is still kept and shown. */
    console.warn(`posting ${DRIFT_CONTEXT} on ${pr.repo}#${pr.number}: ${error instanceof Error ? error.message : error}`);
  }

  const changes = new Changes();
  if (drift.overlap.length >= DRIFT_REVIEW) await escalate(env, rows, changes);
  for (const board of new Set(rows.map((r) => r.board_id))) changes.notify(await boardAudience(env.DB, board), "board");
  changes.publish(env, ctx, null);
  return drift;
}

/** Make the PR's tasks review first, as whoever connected the repo, "via GitHub". */
async function escalate(env: Env, rows: PullRow[], changes: Changes): Promise<void> {
  for (const row of rows.filter((r) => !r.review_first)) {
    const person = await findUserById(env.DB, row.connected_by);
    if (!person || person.disabled_at) continue;
    const viewer: Viewer = { user: rowToUser(person) };
    const flag = new Request("https://copland.invalid/", { method: "PATCH", body: JSON.stringify({ reviewFirst: true }) });
    try {
      await asVia("GitHub", () => patchTask(flag, env, viewer, row.task_id, changes));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }
}

/** Every open PR on the repo that names a task, as stored: what to measure again when the default branch moves. */
export async function openPulls(db: D1Database, repo: string, into: string): Promise<PullRef[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT c.name, c.head_sha FROM task_code c JOIN board_repos r ON r.id = c.repo_id
        WHERE r.repo = ?1 AND c.kind = 'pull' AND c.state IN ('open', 'draft') AND c.head_sha IS NOT NULL`,
    )
    .bind(repo)
    .all<{ name: string; head_sha: string }>();
  return results.map((r) => ({ repo, number: Number(r.name), head: r.head_sha, into }));
}

/* ------------------------------------------------- for the agent at work -- */

/** One open PR of a task, measured now. */
export interface TaskDrift {
  pr: number;
  repo: string;
  url: string;
  state: ReturnType<typeof driftStateOf>;
  /** What copland/drift says. */
  status: string;
  drift: Drift;
}

const driftStateOf = (d: Drift) => driftState(d);

/** The task's open PRs, as stored: what drift and revalidate look at. */
async function taskPulls(db: D1Database, taskId: string) {
  const { results } = await db
    .prepare(
      `SELECT c.name, c.url, c.head_sha, r.repo FROM task_code c JOIN board_repos r ON r.id = c.repo_id
        WHERE c.task_id = ?1 AND c.kind = 'pull' AND c.state IN ('open', 'draft') AND c.head_sha IS NOT NULL`,
    )
    .bind(taskId)
    .all<{ name: string; url: string; head_sha: string; repo: string }>();
  return results;
}

/** The default branch the PR merges into, as the App sees it. */
async function defaultBranch(env: Env, repo: string): Promise<string> {
  const token = await repoToken(env, repo);
  if (!token) throw new HttpError(409, `The GitHub App isn't installed on ${repo}, so Copland can't measure drift there`);
  return repoDefaultBranch(token, repo);
}

/** GET /api/tasks/:id/drift: each of the task's open PRs, measured now (and copland/drift posted again). */
export async function getTaskDrift(env: Env, ctx: ExecutionContext, viewer: Viewer, id: string, origin: string): Promise<Response> {
  const { task } = await taskFor(env, viewer, id, "viewer");
  const out: TaskDrift[] = [];
  for (const p of await taskPulls(env.DB, task.id)) {
    const drift = await measureDrift(env, ctx, { repo: p.repo, number: Number(p.name), head: p.head_sha, into: await defaultBranch(env, p.repo) }, origin);
    if (drift) out.push({ pr: Number(p.name), repo: p.repo, url: p.url, state: driftStateOf(drift), status: driftStatus(drift).description, drift });
  }
  return json({ pulls: out });
}

/**
 * POST /api/tasks/:id/revalidate { main, note }: someone re-checked the task's
 * PR against the default branch at `main` (the commit drift showed them), and
 * says how. Refused when the default branch has moved on since: what they
 * checked is no longer what would be merged into. The note goes on the task
 * as a comment by them, and the status is posted again.
 */
export async function postRevalidate(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  viewer: Viewer,
  id: string,
  origin: string,
  changes: Changes,
): Promise<Response> {
  const { task } = await taskFor(env, viewer, id, "editor");
  const body = await readJson(request);
  const main = typeof body.main === "string" ? body.main.trim().toLowerCase() : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!/^[0-9a-f]{7,40}$/.test(main)) throw badRequest("`main` must be the default branch's commit you re-checked against, as drift gave it");
  if (note.length < 10) throw badRequest("`note` must say what you re-checked: which of main's changes, and why your change still holds");
  const pulls = await taskPulls(env.DB, task.id);
  if (!pulls.length) throw conflict(`${task.key} has no open PR to revalidate`);

  const out: TaskDrift[] = [];
  for (const p of pulls) {
    const ref = { repo: p.repo, number: Number(p.name), head: p.head_sha, into: await defaultBranch(env, p.repo) };
    const now = await measureDrift(env, ctx, ref, origin);
    if (!now) continue;
    if (!now.main.startsWith(main)) {
      throw conflict(`main has moved on to ${now.main.slice(0, 7)} since ${main.slice(0, 7)}: look at drift again, re-check what changed, then revalidate against the new commit`, "main_moved");
    }
    if (now.behind > 0) throw conflict(`#${p.name} is behind main: bring the branch up to date first, then re-check`, "behind");
    await env.DB.prepare(
      `UPDATE task_code SET revalidated_main = ?3
        WHERE kind = 'pull' AND name = ?1 AND repo_id IN (SELECT id FROM board_repos WHERE repo = ?2 AND kind = 'github')`,
    )
      .bind(p.name, p.repo, now.main)
      .run();
    const after = await measureDrift(env, ctx, ref, origin);
    if (after) out.push({ pr: ref.number, repo: p.repo, url: p.url, state: driftStateOf(after), status: driftStatus(after).description, drift: after });
  }
  const text = `Re-checked against main at \`${main.slice(0, 7)}\` (drift):\n\n${note}`;
  await postComment(new Request("https://copland.invalid/", { method: "POST", body: JSON.stringify({ text }) }), env, viewer, task.id, changes);
  changes.notify(await boardAudience(env.DB, task.boardId), "board");
  return json({ pulls: out });
}
