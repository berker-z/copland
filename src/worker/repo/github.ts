/* ============================================================================
   GitHub on boards: the reads (migrations/0019, domain/github.ts).
   ----------------------------------------------------------------------------
   A board's connected repos, and each task's code (branches and PRs naming
   it). The webhook that writes them is routes/github.ts.
   ========================================================================== */

import { driftState, type CiState, type CodeLink, type Drift, type PullState } from "@/domain/github";
import type { BoardRepo } from "@/domain/types";

interface RepoRow {
  id: string;
  kind: BoardRepo["kind"];
  repo: string;
  remote: string | null;
  connected_by_handle: string | null;
  created_at: string;
  last_delivery_at: string | null;
  last_event: string | null;
}

const rowToRepo = (r: RepoRow): BoardRepo => ({
  id: r.id,
  kind: r.kind,
  repo: r.repo,
  remote: r.kind === "github" ? `https://github.com/${r.repo}.git` : (r.remote ?? ""),
  connectedBy: r.connected_by_handle,
  createdAt: r.created_at,
  lastDeliveryAt: r.last_delivery_at,
  lastEvent: r.last_event,
});

const REPO_SELECT = `
  SELECT r.id, r.kind, r.repo, r.remote, u.handle AS connected_by_handle, r.created_at, r.last_delivery_at, r.last_event
    FROM board_repos r LEFT JOIN users u ON u.id = r.connected_by`;

export async function listRepos(db: D1Database, boardId: string): Promise<BoardRepo[]> {
  const { results } = await db.prepare(`${REPO_SELECT} WHERE r.board_id = ?1 ORDER BY r.repo`).bind(boardId).all<RepoRow>();
  return results.map(rowToRepo);
}

export async function findRepo(db: D1Database, id: string): Promise<BoardRepo | null> {
  const row = await db.prepare(`${REPO_SELECT} WHERE r.id = ?1`).bind(id).first<RepoRow>();
  return row ? rowToRepo(row) : null;
}

interface CodeRow {
  task_id: string;
  kind: CodeLink["kind"];
  repo: string;
  name: string;
  title: string | null;
  url: string;
  state: PullState;
  ci: CiState | null;
  drift: string | null;
  updated_at: string;
}

/** Open first (PRs before branches), then the most recently changed. */
const ORDER = `CASE WHEN c.state IN ('open', 'draft') THEN 0 ELSE 1 END, CASE c.kind WHEN 'pull' THEN 0 ELSE 1 END, c.updated_at DESC`;

/** Code grouped by task (`where` over c, its one parameter ?1), like attachments. */
export async function codeFor(db: D1Database, where: string, value: string): Promise<Map<string, CodeLink[]>> {
  const { results } = await db
    .prepare(
      `SELECT c.task_id, c.kind, r.repo, c.name, c.title, c.url, c.state, c.ci, c.drift, c.updated_at
         FROM task_code c JOIN board_repos r ON r.id = c.repo_id
        WHERE ${where} ORDER BY ${ORDER}`,
    )
    .bind(value)
    .all<CodeRow>();
  const out = new Map<string, CodeLink[]>();
  for (const r of results) {
    const list = out.get(r.task_id) ?? [];
    list.push({
      kind: r.kind,
      repo: r.repo,
      name: r.name,
      title: r.title,
      url: r.url,
      state: r.state,
      ci: r.ci,
      drift: r.drift ? driftState(JSON.parse(r.drift) as Drift) : null,
      updatedAt: r.updated_at,
    });
    out.set(r.task_id, list);
  }
  return out;
}
