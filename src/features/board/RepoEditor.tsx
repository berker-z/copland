/* ============================================================================
   Board settings › code: a board's code (routes/github.ts).
   ----------------------------------------------------------------------------
   Two kinds. A GitHub repo is for an instance admin to connect, picked from
   the repos the instance's GitHub App is installed on; it says when GitHub
   last delivered something for it, so you can tell it works (yellow while it
   never has). A plain git remote (COPL-95) is any owner's to set: a URL or a
   path the agents' machines can clone, with no App, webhooks or PRs. Any
   owner can disconnect either.
   ========================================================================== */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BoardDetail, RepoChoices } from "@/domain/types";
import { api, send } from "@/lib/api";
import { KEYS, useMe } from "@/lib/queries";
import { when } from "@/ui/tone";

const input = "bg-raised border border-faint px-2 py-1.5 text-ink focus:outline-none focus:border-accent";
const button = "px-3 py-1.5 pointer-coarse:py-2.5 border border-faint text-ink hover:border-accent hover:text-accent transition-colors disabled:opacity-50";

export function RepoEditor({ detail }: { detail: BoardDetail }) {
  const queryClient = useQueryClient();
  const { board, repos } = detail;
  const isAdmin = useMe().data?.user.isAdmin ?? false;
  const [armed, setArmed] = useState<string | null>(null);
  const [picked, setPicked] = useState("");
  const [remote, setRemote] = useState("");
  const choicesKey = [...KEYS.board(board.id), "repos"];
  const choices = useQuery({
    queryKey: choicesKey,
    queryFn: () => api<RepoChoices>(`/boards/${board.id}/repos/available`),
    enabled: isAdmin,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEYS.board(board.id) });

  const connect = useMutation({
    mutationFn: (body: { repo: string } | { remote: string }) => send("POST", `/boards/${board.id}/repos`, body),
    onSuccess: () => {
      setPicked("");
      setRemote("");
    },
    onSettled: refresh,
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => send("DELETE", `/boards/${board.id}/repos/${id}`),
    onSettled: refresh,
  });
  const app = choices.data?.app;
  const available = choices.data?.repos ?? [];

  return (
    <div className="text-sm">
      {repos.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1">
          {repos.map((r) => (
            <li key={r.id} className="flex items-baseline gap-2 min-w-0">
              {r.kind === "github" ? (
                <>
                  <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer" className="text-ink hover:text-accent truncate">
                    {r.repo}
                  </a>
                  <span className={`text-xs truncate ${r.lastDeliveryAt ? "text-muted" : "text-yellow"}`}>
                    {r.lastDeliveryAt ? `heard ${r.lastEvent} ${when(r.lastDeliveryAt)}` : "nothing from GitHub yet"}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-ink truncate" title={r.remote}>
                    {r.remote}
                  </span>
                  <span className="shrink-0 text-xs text-muted">plain git</span>
                </>
              )}
              <span className="flex-1" />
              <button
                onClick={() => (armed === r.id ? disconnect.mutate(r.id) : setArmed(r.id))}
                onBlur={() => setArmed(null)}
                className={`shrink-0 text-xs transition-colors ${armed === r.id ? "text-red" : "text-muted hover:text-red"}`}
              >
                {armed === r.id ? "really disconnect" : "disconnect"}
              </button>
            </li>
          ))}
        </ul>
      )}

      <h5 className="text-xs text-muted mb-1">GitHub</h5>
      {!isAdmin ? (
        <p className="text-xs text-muted">An instance admin connects GitHub repos.</p>
      ) : choices.isPending ? (
        <p className="text-xs text-muted animate-pulse">asking GitHub…</p>
      ) : choices.error ? (
        <p className="text-xs text-red">{choices.error.message}</p>
      ) : !app ? (
        <p className="text-xs text-muted">This instance has no GitHub App yet. Make one in settings › instance › github.</p>
      ) : (
        <>
          {available.length > 0 ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (picked) connect.mutate({ repo: picked });
              }}
            >
              <select className={`${input} flex-1 min-w-0`} value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="GitHub repo">
                <option value="">pick a repo</option>
                {available.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button className={button} type="submit" disabled={!picked || connect.isPending}>
                connect
              </button>
            </form>
          ) : (
            <p className="text-xs text-muted">The App sees no other repos.</p>
          )}
          <p className="text-xs text-muted mt-2">
            Missing one?{" "}
            <a href={app.installUrl} target="_blank" rel="noreferrer" className="text-accent">
              Install the App on it
            </a>
            . Branches named with a task's key (<span className="text-ink">{board.key.toLowerCase()}-12-short-title</span>) and PRs naming one
            show on the task; a merged PR closes the tasks in its branch or after a closing keyword in its body (
            <span className="text-ink">Fixes {board.key}-12</span>).
          </p>
        </>
      )}
      <h5 className="text-xs text-muted mt-4 mb-1">or plain git</h5>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (remote.trim()) connect.mutate({ remote: remote.trim() });
        }}
      >
        <input
          className={`${input} flex-1 min-w-0`}
          value={remote}
          onChange={(e) => setRemote(e.target.value)}
          placeholder="git@host:me/repo.git, https://…, or /path/on/the/agents'/machines"
          aria-label="git remote"
        />
        <button className={button} type="submit" disabled={!remote.trim() || connect.isPending}>
          connect
        </button>
      </form>
      <p className="text-xs text-muted mt-2">
        No GitHub needed: the agents' daemons clone it with their own credentials, work on branches named after the task, and finish by
        fast-forwarding main. No PRs, so nothing closes a task but its agent.
      </p>
      {(connect.error ?? disconnect.error) && <p className="text-xs text-red mt-2">{(connect.error ?? disconnect.error)?.message}</p>}
    </div>
  );
}
