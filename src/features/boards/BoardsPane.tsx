/* ============================================================================
   The boards pane: every board you are on, and a way to make one. A shared
   board shows how many people are on it. A row opens the board (/b/KEY).

   Boards are what copland is for, so making one is always in sight: a
   "+ new board" row under the list, and with nothing but your inbox, a line
   saying what a board is for. Only people make boards (requirePerson in the
   Worker), so an agent's session never sees the row.
   ========================================================================== */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { Plus, Users } from "lucide-react";
import type { BoardDetail } from "@/domain/types";
import { send } from "@/lib/api";
import { KEYS, useBoards, useMe } from "@/lib/queries";
import { WidgetFrame } from "@/ui/WidgetFrame";

function NewBoard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => send<BoardDetail>("POST", "/boards", { name: name.trim() }),
    onSuccess: async (detail) => {
      setName("");
      setAdding(false);
      /* The board screen finds boards by key in this list, so it must have
         the new one before we go there. */
      await queryClient.invalidateQueries({ queryKey: KEYS.boards });
      navigate(`/b/${detail.board.key}`);
    },
  });

  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="w-full flex items-center gap-3 py-1.5 pointer-coarse:py-3 px-1 text-muted hover:text-accent hover:bg-raised transition-colors"
      >
        <span className="w-14 shrink-0 flex">
          <Plus size={14} aria-hidden />
        </span>
        new board
      </button>
    );
  }
  return (
    <>
      <form
        className="flex gap-2 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <input
          autoFocus
          className="flex-1 min-w-0 bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setAdding(false);
          }}
          placeholder="board name"
          aria-label="New board name"
          maxLength={60}
        />
        <button
          className="px-3 pointer-coarse:py-2.5 border border-faint hover:border-accent hover:text-accent disabled:opacity-50"
          type="submit"
          disabled={!name.trim() || create.isPending}
        >
          make
        </button>
        <button type="button" className="tap px-1 text-muted hover:text-ink" onClick={() => setAdding(false)}>
          cancel
        </button>
      </form>
      {create.error && <p className="text-red text-xs mt-1">{create.error.message}</p>}
    </>
  );
}

export function BoardsPane() {
  const { data: me } = useMe();
  const { data: boards, isLoading, error } = useBoards();
  const canMake = me?.user.kind === "person";
  const onlyInbox = boards !== undefined && boards.every((b) => b.isInbox);

  return (
    <WidgetFrame title="/boards" meta={boards ? `${boards.length}` : undefined}>
      {isLoading && <p className="text-muted animate-pulse">loading…</p>}
      {error && <p className="text-red text-sm">{error.message}</p>}
      <ul>
        {boards?.map((b) => (
          <li key={b.id}>
            <Link to={`/b/${b.key}`} className="flex items-center gap-3 py-1.5 px-1 hover:bg-raised">
              <span className="text-muted w-14 shrink-0">{b.key}</span>
              <span className={b.isInbox ? "text-accent" : "text-bright"}>{b.name}</span>
              <span className="flex-1" />
              {b.memberCount > 1 && (
                <span className="flex items-center gap-1 text-xs text-muted" title={`${b.memberCount} members`}>
                  <Users size={12} />
                  {b.memberCount}
                </span>
              )}
              <span className="text-xs text-muted tabular-nums w-8 text-right" title="open tasks">
                {b.openTaskCount}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {canMake && boards && onlyInbox && (
        <p className="text-sm text-muted px-1 pt-2 pb-1 leading-relaxed">
          A board is a project: its own stages, tasks and people. Make one, then share it or put your agents on it.
        </p>
      )}
      {canMake && boards && (
        <div className={boards.length > 0 ? "border-t border-divider mt-1 pt-1" : ""}>
          <NewBoard />
        </div>
      )}
    </WidgetFrame>
  );
}
