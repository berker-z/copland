/* ============================================================================
   The boards pane: every board you are on, and a way to make one. A shared
   board shows how many people are on it. The full board screens (kanban,
   list, gantt) arrive with the tracker.
   ========================================================================== */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import type { BoardDetail } from "@/domain/types";
import { send } from "@/lib/api";
import { KEYS, useBoards } from "@/lib/queries";
import { WidgetFrame } from "@/ui/WidgetFrame";

export function BoardsPane() {
  const queryClient = useQueryClient();
  const { data: boards, isLoading, error } = useBoards();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => send<BoardDetail>("POST", "/boards", { name: name.trim() }),
    onSuccess: () => {
      setName("");
      setAdding(false);
      void queryClient.invalidateQueries({ queryKey: KEYS.boards });
    },
  });

  return (
    <WidgetFrame
      title="/boards"
      meta={boards ? `${boards.length}` : undefined}
      controls={
        <button onClick={() => setAdding((a) => !a)} className="p-1 hover:text-accent transition-colors" title="New board">
          <Plus size={14} />
        </button>
      }
    >
      {isLoading && <p className="text-muted animate-pulse">loading…</p>}
      {error && <p className="text-red text-sm">{error.message}</p>}
      {adding && (
        <form
          className="flex gap-2 mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <input
            autoFocus
            className="flex-1 bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="board name"
            maxLength={60}
          />
          <button className="px-3 border border-faint hover:border-accent hover:text-accent" type="submit" disabled={create.isPending}>
            make
          </button>
        </form>
      )}
      {create.error && <p className="text-red text-xs mb-2">{create.error.message}</p>}
      <ul>
        {boards?.map((b) => (
          <li key={b.id} className="flex items-center gap-3 py-1.5 px-1 hover:bg-raised">
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
          </li>
        ))}
      </ul>
    </WidgetFrame>
  );
}
