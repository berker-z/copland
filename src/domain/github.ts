/* ============================================================================
   GitHub on boards (COPL-73, decided in COPL-76; docs/GITHUB.md).
   ----------------------------------------------------------------------------
   A board owner connects a repo; the repo's webhook tells us about branches,
   PRs and CI, and we put them on the tasks whose keys they name. Inbound
   only: Copland never writes to GitHub.

   This file is what both sides share and what can be checked without a
   database: the repo name, how code names a task, and what a PR's state is.
   Keys resolve only on the board the repo is connected to, so a public repo
   mentioning COPL-4 touches nothing unless COPL's owner connected it.
   ========================================================================== */

/** "owner/name" as GitHub allows it: letters, digits, '-', and for the name also '.' and '_'. */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** What the owner typed (a full name or a github.com URL) → "owner/name", lowercased, or null. */
export function parseRepo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!REPO.test(name) || name.endsWith("/.") || name.endsWith("/..")) return null;
  return name.toLowerCase();
}

/**
 * How a piece of code names a task. A branch ("copl-73-github") or a closing
 * keyword in a PR's body ("fixes COPL-73") is a claim that this code is that
 * task's work: merging it closes the task. A key in a PR's title only links.
 */
export type CodeRef = "closes" | "mentions";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Task numbers of `boardKey` named in `text` (case-insensitive), as whole keys: COPL-7 is not COPL-70. */
export function keysIn(boardKey: string, text: string): number[] {
  const re = new RegExp(`(?<![A-Za-z0-9])${escape(boardKey)}-(\\d{1,9})(?![0-9])`, "gi");
  return [...new Set([...text.matchAll(re)].map((m) => Number(m[1])))];
}

/** GitHub's closing keywords (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved). */
const CLOSING = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";

/** Task numbers a PR body closes: "Fixes COPL-73", "closes: copl-73". */
export function closedIn(boardKey: string, body: string): number[] {
  const re = new RegExp(`\\b${CLOSING}:?\\s+${escape(boardKey)}-(\\d{1,9})(?![0-9])`, "gi");
  return [...new Set([...body.matchAll(re)].map((m) => Number(m[1])))];
}

/**
 * Every task a PR names, and how. The strongest reference wins: a task named
 * by the branch and the title closes.
 */
export function pullRefs(boardKey: string, pr: { branch: string; title: string; body: string }): Map<number, CodeRef> {
  const refs = new Map<number, CodeRef>();
  for (const n of keysIn(boardKey, pr.title)) refs.set(n, "mentions");
  for (const n of [...keysIn(boardKey, pr.branch), ...closedIn(boardKey, pr.body)]) refs.set(n, "closes");
  return refs;
}

export type PullState = "open" | "draft" | "merged" | "closed";
export type CiState = "success" | "failure" | "pending";

/** GitHub's check_suite conclusion or commit status state → ours; null for one that says nothing (neutral, skipped). */
export function ciFrom(raw: string | null | undefined): CiState | null {
  switch (raw) {
    case "success":
      return "success";
    case "failure":
    case "error":
    case "timed_out":
    case "cancelled":
    case "action_required":
    case "startup_failure":
      return "failure";
    case "pending":
    case "queued":
    case "in_progress":
      return "pending";
    default:
      return null;
  }
}

/** GitHub's X-Hub-Signature-256 ("sha256=<hex>") over the raw body, checked in constant time. */
export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  const hex = header?.startsWith("sha256=") ? header.slice(7) : "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const signature = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, enc.encode(body));
}

/** A task's code, as the app and the MCP show it (one row of task_code). */
export interface CodeLink {
  kind: "branch" | "pull";
  /** "owner/name" */
  repo: string;
  /** The branch name, or the PR's number as text. */
  name: string;
  /** The PR's title; null for a branch. */
  title: string | null;
  url: string;
  /** A branch is open until it is deleted ("closed"). */
  state: PullState;
  ci: CiState | null;
  /** A PR's drift, as last measured (COPL-75); null for a branch, or a PR not measured yet. */
  drift: DriftState | null;
  updatedAt: string;
}

/* ------------------------------------------------------------- drift ---- */

/**
 * Drift (COPL-75): what changed on the default branch while a PR's task was
 * being worked on, against what the task changed. Its code may rest on how
 * those files were when it started, so where they overlap the agent has to
 * look again before it merges.
 */
export interface Drift {
  /** The default branch's head this was measured against. */
  main: string;
  /** Where the task's work started: the parent of the PR's first commit. */
  base: string;
  /** Commits on the default branch the PR's head doesn't have yet. */
  behind: number;
  /** Files the default branch changed since `base`. */
  mainFiles: string[];
  /** Files the PR changes. */
  taskFiles: string[];
  /** In both: where the task's assumptions may be stale. */
  overlap: string[];
  /** Someone re-checked the PR against this `main` (revalidate). */
  revalidated: boolean;
}

export type DriftState = "clean" | "behind" | "recheck" | "revalidated";

/** How many overlapping files make the task review first: a person merges it, not its author. */
export const DRIFT_REVIEW = 3;

export function overlapOf(mainFiles: string[], taskFiles: string[]): string[] {
  const main = new Set(mainFiles);
  return taskFiles.filter((f) => main.has(f)).sort();
}

/**
 * The state, in the order that matters: a branch behind the default branch
 * first takes it in (that is also when its overlap becomes real code to look
 * at); then any overlap needs a re-check for this very `main`.
 */
export function driftState(d: Pick<Drift, "behind" | "overlap" | "revalidated">): DriftState {
  if (d.behind > 0) return "behind";
  if (d.overlap.length === 0) return "clean";
  return d.revalidated ? "revalidated" : "recheck";
}

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The copland/drift commit status for a PR: what GitHub shows, and what branch protection requires. */
export function driftStatus(d: Drift): { state: "success" | "pending"; description: string } {
  switch (driftState(d)) {
    case "behind":
      return { state: "pending", description: `${plural(d.behind, "commit")} behind ${short(d.main)}: bring the branch up to date` };
    case "clean":
      return {
        state: "success",
        description:
          d.mainFiles.length === 0
            ? "main hasn't moved since this work started"
            : `main changed ${plural(d.mainFiles.length, "file")} since this work started, none of this PR's`,
      };
    case "revalidated":
      return { state: "success", description: `re-checked against ${short(d.main)}: ${plural(d.overlap.length, "file")} main changed too` };
    case "recheck":
      return {
        state: "pending",
        description: `main changed ${plural(d.overlap.length, "file")} this PR changes since it started: re-check, then revalidate`,
      };
  }
}

/* ------------------------------------------------------- plain git ---- */

/**
 * A git remote for a board without GitHub (COPL-95): what to clone, and the
 * name to show. Takes what git takes: https and ssh URLs, scp-style
 * `user@host:path`, `file://` and absolute paths (on the agents' machines).
 * The name is the remote without its scheme, user and ".git". Copland never
 * clones it; only the daemons do, so nothing here reaches the network.
 */
export function parseRemote(raw: unknown): { remote: string; name: string } | null {
  if (typeof raw !== "string") return null;
  const remote = raw.trim();
  if (!remote || remote.length > 300 || /[\s\u0000-\u001f]/.test(remote)) return null;
  const tidy = (host: string, path: string) =>
    `${host.toLowerCase()}/${path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "")}`.replace(/\/+$/, "");
  let m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(remote);
  if (m) return { remote, name: tidy(m[1], m[2]) };
  m = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(remote);
  if (m) return { remote, name: tidy(m[1], m[2]) };
  m = /^file:\/\/(\/.+)$/i.exec(remote);
  if (m) return { remote, name: m[1].replace(/\/+$/, "").replace(/\.git$/i, "") };
  if (remote.startsWith("/") && !remote.split("/").includes("..")) {
    return { remote, name: remote.replace(/\/+$/, "").replace(/\.git$/i, "") };
  }
  return null;
}
