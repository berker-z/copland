/* ============================================================================
   A task's code, from a connected GitHub repo (domain/github.ts): the
   modal's list of branches and PRs, and the card's one-PR badge.
   ----------------------------------------------------------------------------
   States read like GitHub's: open green, draft muted, merged magenta, closed
   red. CI on the head commit follows as a word in its hue. Links open on
   GitHub in a new tab; a click on the card's badge doesn't open the task.
   ========================================================================== */

import { GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { CiState, CodeLink, DriftState, PullState } from "@/domain/github";

const STATE_CLASS: Record<PullState, string> = {
  open: "text-green",
  draft: "text-muted",
  merged: "text-magenta",
  closed: "text-red",
};

const CI_TEXT: Record<CiState, [string, string]> = {
  success: ["ci passed", "text-green"],
  failure: ["ci failed", "text-red"],
  pending: ["ci running", "text-yellow"],
};

/* Drift on an open PR (COPL-75): only what asks for something is shown. */
const DRIFT_TEXT: Partial<Record<DriftState, [string, string]>> = {
  behind: ["behind main", "text-muted"],
  recheck: ["main moved: re-check", "text-yellow"],
  revalidated: ["re-checked", "text-green"],
};

function CodeIcon({ link, size }: { link: CodeLink; size: number }) {
  if (link.kind === "branch") return <GitBranch size={size} />;
  if (link.state === "merged") return <GitMerge size={size} />;
  if (link.state === "closed") return <GitPullRequestClosed size={size} />;
  if (link.state === "draft") return <GitPullRequestDraft size={size} />;
  return <GitPullRequest size={size} />;
}

/** The modal's "code" row: every branch and PR naming the task, open ones first. */
export function CodeList({ links }: { links: CodeLink[] }) {
  const repos = new Set(links.map((l) => l.repo));
  return (
    <ul className="flex flex-col gap-1">
      {links.map((link) => (
        <li key={`${link.repo}:${link.kind}:${link.name}`} className="flex items-baseline gap-1.5 min-w-0">
          <span className={`${STATE_CLASS[link.state]} shrink-0 self-center`} title={link.kind === "branch" ? (link.state === "closed" ? "branch deleted" : "branch") : link.state}>
            <CodeIcon link={link} size={13} />
          </span>
          <a href={link.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-ink hover:text-accent">
            {link.kind === "pull" ? (
              <>
                <span className="text-muted">#{link.name}</span> {link.title}
              </>
            ) : (
              <span className={link.state === "closed" ? "line-through decoration-faint text-muted" : ""}>{link.name}</span>
            )}
          </a>
          {link.ci && <span className={`shrink-0 text-xs ${CI_TEXT[link.ci][1]}`}>{CI_TEXT[link.ci][0]}</span>}
          {link.drift && DRIFT_TEXT[link.drift] && (link.state === "open" || link.state === "draft") && (
            <span className={`shrink-0 text-xs ${DRIFT_TEXT[link.drift]![1]}`}>{DRIFT_TEXT[link.drift]![0]}</span>
          )}
          {repos.size > 1 && <span className="shrink-0 text-xs text-faint">{link.repo}</span>}
        </li>
      ))}
    </ul>
  );
}

/** The PR a card shows: the first open one, else the latest merged; none when there is no PR. */
export function cardPull(links: CodeLink[]): CodeLink | undefined {
  return links.find((l) => l.kind === "pull" && (l.state === "open" || l.state === "draft")) ?? links.find((l) => l.kind === "pull" && l.state === "merged");
}

/** On a card's meta line: the PR's icon and number in its state's hue, then a CI dot. */
export function CodeBadge({ link }: { link: CodeLink }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      className={`inline-flex items-center gap-0.5 hover:text-accent ${STATE_CLASS[link.state]}`}
      title={`#${link.name} ${link.title ?? ""} (${link.state}${link.ci ? `, ${CI_TEXT[link.ci][0]}` : ""})`}
    >
      <CodeIcon link={link} size={11} />
      {link.name}
      {link.ci && <span className={CI_TEXT[link.ci][1]}>•</span>}
    </a>
  );
}
