/* ============================================================================
   GitHub on boards (COPL-73, decided in COPL-76; docs/GITHUB.md).
   ----------------------------------------------------------------------------
   The instance has at most one GitHub App (githubApp.ts), which an admin
   makes from settings › instance › github and installs on the repos it
   should see. An instance admin who owns a board connects any of those repos
   to it. Only admins: the App sees whatever its owner installed it on,
   private repos included, so a board owner who isn't an admin could
   otherwise attach someone else's repo to their board and read its PRs.

   The App's webhook (POST /api/github) is one of the `open` routes in
   index.ts: it has no viewer, and nothing it does happens until GitHub's
   signature over the body checks out against the App's webhook secret. A
   delivery lands on every board its repo is connected to, on the tasks of
   that board whose keys the code names (domain/github.ts):

     push          a branch named with a key: on the task, open; deleted, closed
     pull_request  a PR naming keys in its branch, title or closing keywords
     check_suite,  CI on a head commit, for whichever branch or PR has it
     status

   A PR merged into the repo's default branch that closes a task (by its
   branch or a closing keyword) moves it to the board's done stage, through patchTask as the person who
   connected the repo, so it is their role that is checked, the parents
   follow and claims end as for any move, and the history says "via GitHub".
   Everything else only annotates.
   ========================================================================== */

import { ciFrom, parseRepo, pullRefs, keysIn, verifySignature, type CodeRef, type PullState } from "@/domain/github";
import type { AppManifestForm, BoardRepo, RepoChoices, Viewer } from "@/domain/types";
import { requireAdmin, requireBoard } from "../access";
import { cookie, readCookie, redirect } from "../auth";
import type { Env } from "../env";
import { badRequest, conflict, HttpError, json, notFound, nowIso, randomToken, readJson } from "../http";
import type { Changes } from "../live";
import { finishManifest, githubApp, installedRepos, manifest, webhookSecret } from "../githubApp";
import { boardAudience } from "../repo/boards";
import { findRepo, listRepos } from "../repo/github";
import { adminIds } from "./admin";
import { eventStatement, listStages } from "../repo/tasks";
import { findUserById, rowToUser } from "../repo/users";
import { asVia } from "../tokens";
import { browserUser } from "../viewer";
import { patchTask } from "./tasks";

/** Most a delivery may weigh. GitHub caps payloads at 25 MB; ours never need that. */
const MAX_BODY = 5 * 1024 * 1024;

/* ---------------------------------------------------------- the App ---- */

const STATE_COOKIE = "copland_github";

/** GET /api/admin/github: the App, or null. */
export async function getAdminGithub(env: Env, viewer: Viewer): Promise<Response> {
  requireAdmin(viewer);
  return json({ app: await githubApp(env.DB) });
}

/**
 * POST /api/admin/github/manifest: what the browser posts to GitHub to make
 * the App, and a state cookie the callback checks, so a code only counts
 * when this browser asked for it.
 */
export async function postManifest(viewer: Viewer, url: URL): Promise<Response> {
  requireAdmin(viewer);
  const state = randomToken();
  const form: AppManifestForm = {
    action: `https://github.com/settings/apps/new?state=${state}`,
    manifest: JSON.stringify(manifest(url.origin)),
  };
  const response = json(form);
  response.headers.append("set-cookie", cookie(STATE_COOKIE, state, { path: "/auth/github", maxAge: 3600, secure: url.protocol === "https:" }));
  return response;
}

/**
 * GET /auth/github/callback?code&state: GitHub made the App. Trade the code
 * for it, keep it, and go install it. A person in a browser reads this, so
 * failures land on the app with a reason, not as JSON.
 */
export async function finishGithubApp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const clear = cookie(STATE_COOKIE, "", { path: "/auth/github", maxAge: 0, secure: url.protocol === "https:" });
  const user = await browserUser(request, env);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!user?.is_admin) return redirect("/?github=admins-only", [clear]);
  if (!code || !state || state !== readCookie(request, STATE_COOKIE)) return redirect("/?github=failed", [clear]);
  const { installUrl } = await finishManifest(env, code, user.id);
  return redirect(installUrl, [clear]);
}

/** DELETE /api/admin/github: forget the App. Its repos stay on their boards and hear nothing until there is an App again. */
export async function deleteAdminGithub(env: Env, viewer: Viewer, changes: Changes): Promise<Response> {
  requireAdmin(viewer);
  await env.DB.prepare(`DELETE FROM github_app WHERE id = 1`).run();
  changes.notify(await adminIds(env), "admin");
  return json({ ok: true });
}

/* ------------------------------------------------------- connecting ---- */

/** GET /api/boards/:id/repos/available: the App's repos an admin owning this board can connect. */
export async function getAvailableRepos(env: Env, viewer: Viewer, boardId: string): Promise<Response> {
  requireAdmin(viewer);
  await requireBoard(env.DB, viewer, boardId, "owner");
  const app = await githubApp(env.DB);
  const connected = new Set((await listRepos(env.DB, boardId)).map((r) => r.repo));
  const repos = app ? (await installedRepos(env)).filter((r) => !connected.has(r)) : [];
  const out: RepoChoices = { app, repos };
  return json(out);
}

/** POST /api/boards/:id/repos { repo }: an admin who owns the board, and a repo the App is installed on. */
export async function postRepo(request: Request, env: Env, viewer: Viewer, boardId: string, changes: Changes): Promise<Response> {
  requireAdmin(viewer);
  await requireBoard(env.DB, viewer, boardId, "owner");
  const repo = parseRepo((await readJson(request)).repo);
  if (!repo) throw badRequest("`repo` must be a GitHub repo as owner/name");
  if (!(await githubApp(env.DB))) throw conflict("This instance has no GitHub App yet: an admin makes one in settings › instance › github");
  if (!(await installedRepos(env)).includes(repo)) throw badRequest(`The GitHub App isn't installed on ${repo}`);
  const taken = await env.DB.prepare(`SELECT 1 FROM board_repos WHERE board_id = ?1 AND repo = ?2`).bind(boardId, repo).first();
  if (taken) throw conflict(`${repo} is already connected to this board`);

  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO board_repos (id, board_id, repo, connected_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(
      id,
      boardId,
      repo,
      viewer.user.id,
      nowIso(),
    ),
    eventStatement(env.DB, { boardId, taskId: null, actorId: viewer.user.id, kind: "board.repo", after: { repo } }),
  ]);
  changes.notify(await boardAudience(env.DB, boardId), "board");
  const out: BoardRepo = (await findRepo(env.DB, id))!;
  return json(out, { status: 201 });
}

/** DELETE /api/boards/:id/repos/:repoId: owners, admin or not; taking access away needs no more. The tasks' code from it goes with it. */
export async function deleteRepo(env: Env, viewer: Viewer, boardId: string, repoId: string, changes: Changes): Promise<Response> {
  await requireBoard(env.DB, viewer, boardId, "owner");
  const row = await env.DB.prepare(`SELECT repo FROM board_repos WHERE id = ?1 AND board_id = ?2`)
    .bind(repoId, boardId)
    .first<{ repo: string }>();
  if (!row) throw notFound("No such repo on this board");
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM task_code WHERE repo_id = ?1`).bind(repoId),
    env.DB.prepare(`DELETE FROM board_repos WHERE id = ?1`).bind(repoId),
    eventStatement(env.DB, { boardId, taskId: null, actorId: viewer.user.id, kind: "board.repo", before: { repo: row.repo } }),
  ]);
  changes.notify(await boardAudience(env.DB, boardId), "board");
  return json({ ok: true });
}

/* ---------------------------------------------------------- webhook ---- */

/** A board the delivery's repo is connected to. */
interface HookRow {
  id: string;
  board_id: string;
  board_key: string;
  repo: string;
  connected_by: string;
}

/* Only what we read of GitHub's payloads. */
interface Payload {
  repository?: { full_name?: string; default_branch?: string };
  ref?: string;
  after?: string;
  deleted?: boolean;
  action?: string;
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: "open" | "closed";
    draft?: boolean;
    merged?: boolean;
    head: { ref: string; sha: string };
    base?: { ref: string };
  };
  check_suite?: { head_sha: string; conclusion: string | null };
  sha?: string;
  state?: string;
}

/** POST /api/github: a delivery from the App's webhook. No viewer; the signature is the only way in. */
export async function postWebhook(request: Request, env: Env, changes: Changes): Promise<Response> {
  const secret = await webhookSecret(env);
  if (!secret) throw notFound("This instance has no GitHub App");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw new HttpError(413, "Delivery too large");
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, "Delivery too large");
  if (!(await verifySignature(secret, raw, request.headers.get("x-hub-signature-256")))) {
    throw new HttpError(401, "Bad or missing X-Hub-Signature-256");
  }
  let payload: Payload;
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    throw badRequest("The delivery is not JSON");
  }

  const event = request.headers.get("x-github-event") ?? "unknown";
  const repo = payload.repository?.full_name?.toLowerCase();
  /* ping, installation and the like name no repo, or one no board has: nothing to do. */
  if (!repo) return json({ ok: true, event, touched: false });
  const { results: hooks } = await env.DB.prepare(
    `SELECT r.id, r.board_id, b.key AS board_key, r.repo, r.connected_by
       FROM board_repos r JOIN boards b ON b.id = r.board_id WHERE r.repo = ?1 AND b.archived_at IS NULL`,
  )
    .bind(repo)
    .all<HookRow>();
  if (!hooks.length) return json({ ok: true, event, touched: false });

  const now = nowIso();
  await env.DB.prepare(`UPDATE board_repos SET last_delivery_at = ?2, last_event = ?3 WHERE repo = ?1`).bind(repo, now, event).run();

  let touched = false;
  for (const hook of hooks) {
    if (event === "push") touched = (await onPush(env, hook, payload, now)) || touched;
    else if (event === "pull_request") touched = (await onPull(env, hook, payload, now, changes)) || touched;
    else if (event === "check_suite" && payload.action === "completed" && payload.check_suite) {
      touched = (await onCi(env, hook, payload.check_suite.head_sha, payload.check_suite.conclusion, now)) || touched;
    } else if (event === "status" && payload.sha) touched = (await onCi(env, hook, payload.sha, payload.state ?? null, now)) || touched;
    /* The repo's row in board settings shows the last delivery, so the owner can see it arrives. */
    changes.notify(await boardAudience(env.DB, hook.board_id), "board");
  }
  return json({ ok: true, event, touched });
}

/** The live tasks on the hook's board with these numbers, as number → id. */
async function tasksNumbered(env: Env, hook: HookRow, numbers: number[]): Promise<Map<number, string>> {
  if (!numbers.length) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT id, number FROM tasks WHERE board_id = ?1 AND deleted_at IS NULL AND number IN (${numbers.map((_, i) => `?${i + 2}`).join(", ")})`,
  )
    .bind(hook.board_id, ...numbers)
    .all<{ id: string; number: number }>();
  return new Map(results.map((r) => [r.number, r.id]));
}

/**
 * One task's branch or PR, inserted or brought up to date. CI belongs to a
 * commit, so a new head forgets it until the new commit's checks report.
 */
function upsertCode(
  env: Env,
  link: { taskId: string; repoId: string; kind: "branch" | "pull"; name: string; title: string | null; url: string; state: PullState; ref: CodeRef; headSha: string | null },
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO task_code (id, task_id, repo_id, kind, name, title, url, state, ref, head_sha, ci, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11)
     ON CONFLICT (task_id, repo_id, kind, name) DO UPDATE SET
       title = excluded.title, url = excluded.url, state = excluded.state, ref = excluded.ref,
       ci = CASE WHEN excluded.head_sha IS NULL OR task_code.head_sha IS excluded.head_sha THEN task_code.ci ELSE NULL END,
       head_sha = coalesce(excluded.head_sha, task_code.head_sha),
       updated_at = excluded.updated_at`,
  ).bind(crypto.randomUUID(), link.taskId, link.repoId, link.kind, link.name, link.title, link.url, link.state, link.ref, link.headSha, now);
}

async function onPush(env: Env, hook: HookRow, payload: Payload, now: string): Promise<boolean> {
  const branch = payload.ref?.startsWith("refs/heads/") ? payload.ref.slice("refs/heads/".length) : null;
  if (!branch) return false;
  const tasks = await tasksNumbered(env, hook, keysIn(hook.board_key, branch));
  if (!tasks.size) return false;
  const url = `https://github.com/${hook.repo}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
  const sha = payload.deleted ? null : (payload.after ?? null);
  await env.DB.batch(
    [...tasks.values()].map((taskId) =>
      upsertCode(
        env,
        { taskId, repoId: hook.id, kind: "branch", name: branch, title: null, url, state: payload.deleted ? "closed" : "open", ref: "closes", headSha: sha },
        now,
      ),
    ),
  );
  return true;
}

async function onPull(env: Env, hook: HookRow, payload: Payload, now: string, changes: Changes): Promise<boolean> {
  const pr = payload.pull_request;
  if (!pr) return false;
  const refs = pullRefs(hook.board_key, { branch: pr.head.ref, title: pr.title, body: pr.body ?? "" });
  const tasks = await tasksNumbered(env, hook, [...refs.keys()]);
  const state: PullState = pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
  const name = String(pr.number);
  const linked = [...tasks].map(([number, taskId]) => ({ taskId, ref: refs.get(number)! }));

  /* A PR edited to stop naming a task comes off it. */
  const keep = linked.map((l) => l.taskId);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM task_code WHERE repo_id = ?1 AND kind = 'pull' AND name = ?2${keep.length ? ` AND task_id NOT IN (${keep.map((_, i) => `?${i + 3}`).join(", ")})` : ""}`,
    ).bind(hook.id, name, ...keep),
    ...linked.map((l) =>
      upsertCode(
        env,
        { taskId: l.taskId, repoId: hook.id, kind: "pull", name, title: pr.title.slice(0, 300), url: pr.html_url, state, ref: l.ref, headSha: pr.head.sha },
        now,
      ),
    ),
  ]);

  /* Only work that reached the repo's default branch is done: a merge into another branch links, and closes nothing. */
  if (payload.action === "closed" && pr.merged && pr.base?.ref === payload.repository?.default_branch) {
    await closeMerged(env, hook, linked.filter((l) => l.ref === "closes").map((l) => l.taskId), changes);
  }
  return linked.length > 0;
}

/**
 * Move the tasks a merged PR closes to the board's first done stage, as the
 * person who connected the repo. A task already closed stays where it is; one
 * they can no longer edit (they left the board, or became a viewer) is only
 * annotated.
 */
async function closeMerged(env: Env, hook: HookRow, taskIds: string[], changes: Changes): Promise<void> {
  if (!taskIds.length) return;
  const done = (await listStages(env.DB, hook.board_id)).find((s) => s.category === "done");
  const person = await findUserById(env.DB, hook.connected_by);
  if (!done || !person || person.disabled_at) return;
  const viewer: Viewer = { user: rowToUser(person) };
  for (const taskId of taskIds) {
    const closed = await env.DB.prepare(`SELECT completed_at FROM tasks WHERE id = ?1`).bind(taskId).first<{ completed_at: string | null }>();
    if (!closed || closed.completed_at) continue;
    const move = new Request("https://copland.invalid/", { method: "PATCH", body: JSON.stringify({ stageId: done.id }) });
    try {
      await asVia("GitHub", () => patchTask(move, env, viewer, taskId, changes));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }
}

async function onCi(env: Env, hook: HookRow, sha: string, raw: string | null, now: string): Promise<boolean> {
  const ci = ciFrom(raw);
  if (!ci) return false;
  /* One state per commit, not per check: the latest report wins, except that
     a failure stays until a new commit, so one green check can't hide another's red. */
  const result = await env.DB.prepare(
    `UPDATE task_code SET ci = CASE WHEN ci = 'failure' THEN ci ELSE ?3 END, updated_at = ?4 WHERE repo_id = ?1 AND head_sha = ?2`,
  )
    .bind(hook.id, sha, ci, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
