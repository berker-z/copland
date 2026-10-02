/* ============================================================================
   Board settings, for owners (the gear): its stages and labels, what it is
   called, and archiving it. The inbox is private, so it
   has no archive section. Who is on the board, and adding people or agents,
   is the share dialog (ShareModal.tsx).
   ========================================================================== */

import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { BoardDetail } from "@/domain/types";
import { send } from "@/lib/api";
import { KEYS } from "@/lib/queries";
import { ModalFrame } from "@/ui/ModalFrame";
import { LabelEditor, StageEditor } from "./StageEditor";

const input = "bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent";
const button = "px-3 py-1.5 pointer-coarse:py-2.5 border border-faint text-ink hover:border-accent hover:text-accent transition-colors disabled:opacity-50";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="py-4 first:pt-0 border-b border-divider last:border-b-0">
      <h4 className="text-label mb-3">{title}</h4>
      {children}
    </section>
  );
}

export function BoardSettingsModal({ detail, onClose }: { detail: BoardDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { board } = detail;
  const [name, setName] = useState(board.name);
  const [key, setKey] = useState(board.key);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: KEYS.board(board.id) });
    void queryClient.invalidateQueries({ queryKey: KEYS.boards });
  };

  const patchBoard = useMutation({
    mutationFn: (patch: { name?: string; key?: string }) =>
      send("PATCH", `/boards/${board.id}`, patch),
    onSettled: refresh,
  });
  /* The board screen is addressed by key, so a new key needs a new URL, once
     the boards list knows it. */
  const changeKey = useMutation({
    mutationFn: (next: string) => send("PATCH", `/boards/${board.id}`, { key: next }),
    onSuccess: async (_r, next) => {
      await queryClient.invalidateQueries({ queryKey: KEYS.boards });
      void queryClient.invalidateQueries({ queryKey: KEYS.board(board.id) });
      navigate(`/b/${next}`, { replace: true });
    },
  });
  const archive = useMutation({
    mutationFn: () => send("DELETE", `/boards/${board.id}`),
    onSuccess: () => {
      refresh();
      navigate("/");
    },
  });

  const error = patchBoard.error ?? archive.error;

  return (
    <ModalFrame title={`${board.key} · settings`} onClose={onClose} size="lg">
      {error && <p className="text-red text-xs mb-3">{error.message}</p>}

      <Section title="stages">
        <StageEditor detail={detail} />
      </Section>

      <Section title="labels">
        <LabelEditor detail={detail} />
      </Section>

      <Section title="board">
        <form
          className="flex gap-2 mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && name.trim() !== board.name) patchBoard.mutate({ name: name.trim() });
          }}
        >
          <input className={`${input} flex-1`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          <button className={button} type="submit">
            rename
          </button>
        </form>
        <form
          className="flex flex-wrap items-center gap-2 mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            const next = key.trim().toUpperCase();
            if (next && next !== board.key) changeKey.mutate(next);
          }}
        >
          <input
            className={`${input} w-28 uppercase`}
            value={key}
            onChange={(e) => setKey(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 6))}
            aria-label="board key"
          />
          <button className={button} type="submit" disabled={changeKey.isPending}>
            change key
          </button>
          <span className="text-xs text-muted basis-full">
            The prefix of task numbers: {(key.trim() || board.key).toUpperCase()}-1. 2-6 letters or digits.
          </span>
          {changeKey.error && <span className="text-xs text-red basis-full">{changeKey.error.message}</span>}
        </form>
      </Section>

      {!board.isInbox && (
        <Section title="archive">
          <button
            onClick={() => (confirmArchive ? archive.mutate() : setConfirmArchive(true))}
            onBlur={() => setConfirmArchive(false)}
            className={`px-3 py-1.5 pointer-coarse:py-2.5 border transition-colors ${
              confirmArchive ? "border-red text-red" : "border-faint text-muted hover:border-red hover:text-red"
            }`}
          >
            {confirmArchive ? "really archive for everyone" : "archive board"}
          </button>
        </Section>
      )}
    </ModalFrame>
  );
}
