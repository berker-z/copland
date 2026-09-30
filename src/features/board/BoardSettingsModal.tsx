/* ============================================================================
   Board settings, for owners: who is on it, its stages and labels, what it is
   called, planning on or off, and archiving it. The inbox is private, so it
   has no people or archive sections. Adding an email that has no account
   here yet gives back an invite link that brings them straight to this
   board.
   ========================================================================== */

import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Copy } from "lucide-react";
import { BOARD_ROLES, type BoardDetail, type BoardRole, type CreatedInvite } from "@/domain/types";
import { send } from "@/lib/api";
import { KEYS, useMe } from "@/lib/queries";
import { Checkbox } from "@/ui/Checkbox";
import { ModalFrame } from "@/ui/ModalFrame";
import { LabelEditor, StageEditor } from "./StageEditor";

const input = "bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent";
const button = "px-3 py-1.5 border border-faint text-ink hover:border-accent hover:text-accent transition-colors disabled:opacity-50";

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
  const me = useMe();
  const { board, members } = detail;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<BoardRole>("editor");
  const [invite, setInvite] = useState<CreatedInvite | null>(null);
  const [name, setName] = useState(board.name);
  const [key, setKey] = useState(board.key);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: KEYS.board(board.id) });
    void queryClient.invalidateQueries({ queryKey: KEYS.boards });
  };

  const add = useMutation({
    mutationFn: () =>
      send<{ added: boolean; invite?: CreatedInvite }>("POST", `/boards/${board.id}/members`, { email: email.trim(), role }),
    onSuccess: (result) => {
      setEmail("");
      setInvite(result.invite ?? null);
      refresh();
    },
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: BoardRole }) =>
      send("PATCH", `/boards/${board.id}/members/${userId}`, { role }),
    onSettled: refresh,
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => send("DELETE", `/boards/${board.id}/members/${userId}`),
    onSuccess: (_r, userId) => {
      refresh();
      if (userId === me.data?.user.id) navigate("/");
    },
  });
  const patchBoard = useMutation({
    mutationFn: (patch: { name?: string; key?: string; hasPlanning?: boolean }) =>
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

  const error = add.error ?? changeRole.error ?? removeMember.error ?? patchBoard.error ?? archive.error;

  return (
    <ModalFrame title={`${board.key} · settings`} onClose={onClose} size="lg" className="max-h-[90vh]">
      {error && <p className="text-red text-xs mb-3">{error.message}</p>}

      {!board.isInbox && (
        <Section title="people">
          <ul className="mb-3">
            {members.map((m) => (
              <li key={m.user.id} className="flex items-center gap-3 py-1.5">
                <span className="text-ink truncate">{m.user.name}</span>
                <span className="text-muted text-sm truncate">{m.user.email}</span>
                <span className="flex-1" />
                <select
                  className={`${input} py-0.5`}
                  value={m.role}
                  onChange={(e) => changeRole.mutate({ userId: m.user.id, role: e.target.value as BoardRole })}
                >
                  {BOARD_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button onClick={() => removeMember.mutate(m.user.id)} className="text-muted hover:text-red text-xs">
                  {m.user.id === me.data?.user.id ? "leave" : "remove"}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim()) add.mutate();
            }}
          >
            <input className={`${input} flex-1`} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="friend@example.com" type="email" />
            <select className={input} value={role} onChange={(e) => setRole(e.target.value as BoardRole)}>
              {BOARD_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button className={button} type="submit" disabled={add.isPending}>
              add
            </button>
          </form>
          {invite && (
            <div className="mt-3 p-2 border border-green/60 bg-green/10 text-xs">
              <p className="text-green mb-1">
                {invite.invite.email} has no account here yet. Send them this link; it brings them onto this board:
              </p>
              <div className="flex items-center gap-2">
                <code className="text-yellow truncate flex-1">{invite.url}</code>
                <button onClick={() => navigator.clipboard.writeText(invite.url)} className="text-ink hover:text-accent p-1" title="Copy">
                  <Copy size={14} />
                </button>
              </div>
            </div>
          )}
        </Section>
      )}

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
        <Checkbox
          checked={board.hasPlanning}
          onChange={(next) => patchBoard.mutate({ hasPlanning: next })}
          label={<span className="text-ink">planning: levels (epic, story, task, milestone) and parent tasks</span>}
          size={15}
        />
      </Section>

      {!board.isInbox && (
        <Section title="archive">
          <button
            onClick={() => (confirmArchive ? archive.mutate() : setConfirmArchive(true))}
            onBlur={() => setConfirmArchive(false)}
            className={`px-3 py-1.5 border transition-colors ${
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
