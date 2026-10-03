/* ============================================================================
   Board settings › github: the repos connected to a board (routes/github.ts).
   ----------------------------------------------------------------------------
   Connecting is for an instance admin: they pick from the repos the
   instance's GitHub App is installed on. Any owner can disconnect. Each repo
   says when GitHub last delivered something for it, so you can tell it
   works; one never heard from says so in yellow.
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
  const choicesKey = [...KEYS.board(board.id), "repos"];
  const choices = useQuery({
    queryKey: choicesKey,
    queryFn: () => api<RepoChoices>(`/boards/${board.id}/repos/available`),
    enabled: isAdmin,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEYS.board(board.id) });

  const connect = useMutation({
    mutationFn: (repo: string) => send("POST", `/boards/${board.id}/repos`, { repo }),
    onSuccess: () => setPicked(""),
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
              <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer" className="text-ink hover:text-accent truncate">
                {r.repo}
              </a>
              <span className={`text-xs truncate ${r.lastDeliveryAt ? "text-muted" : "text-yellow"}`}>
                {r.lastDeliveryAt ? `heard ${r.lastEvent} ${when(r.lastDeliveryAt)}` : "nothing from GitHub yet"}
              </span>
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

      {!isAdmin ? (
        <p className="text-xs text-muted">An instance admin connects repos.</p>
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
                if (picked) connect.mutate(picked);
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
      {(connect.error ?? disconnect.error) && <p className="text-xs text-red mt-2">{(connect.error ?? disconnect.error)?.message}</p>}
    </div>
  );
}
