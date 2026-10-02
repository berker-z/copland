/* ============================================================================
   Sharing a board: who is on it, and adding someone by handle.
   ----------------------------------------------------------------------------
   Owners and editors open it; viewers have no share button. The members are
   listed first (owners change roles and remove anyone; you take your own
   agents off, and leave yourself). Then one picker: type a handle and pick
   from the suggestions, people on the instance first (GET /api/people,
   owners only), then your own agents not already here, then a role.

     a person   POST /api/boards/:id/members { userId, role }   owners only
     an agent   PUT  /api/agents/:id/boards/:boardId { role }   its owner,
                viewer or editor, never above your own role here

   Editors get only "bring your agents"; the inbox, which is private, offers
   only your agents too. Inviting someone not on Copland is the quiet link at
   the bottom: the email field, and the invite link it gives back. That is
   the only place an address appears.
   ========================================================================== */

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Copy, X } from "lucide-react";
import { BOARD_ROLES, type BoardDetail, type BoardRole, type CreatedInvite } from "@/domain/types";
import { send } from "@/lib/api";
import { KEYS, useAgents, useMe, usePeople } from "@/lib/queries";
import { Avatar, peopleFirst } from "@/ui/Avatar";
import { ModalFrame } from "@/ui/ModalFrame";

const input = "bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent";
const button = "px-3 py-1.5 pointer-coarse:py-2.5 border border-faint text-ink hover:border-accent hover:text-accent transition-colors disabled:opacity-50";

const RANK: Record<BoardRole, number> = { viewer: 0, editor: 1, owner: 2 };

interface Pick {
  kind: "person" | "agent";
  id: string;
  handle: string;
  avatar: string | null;
}

export function ShareModal({ detail, onClose }: { detail: BoardDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const myId = me.data?.user.id;
  const { board, members } = detail;
  const isOwner = board.role === "owner";
  /* Owners of a shared board pick people; everyone else, and the inbox, only agents. */
  const withPeople = isOwner && !board.isInbox;

  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [picked, setPicked] = useState<Pick | null>(null);
  const [role, setRole] = useState<BoardRole>("editor");
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [emailRole, setEmailRole] = useState<BoardRole>("editor");
  const [invite, setInvite] = useState<CreatedInvite | null>(null);

  const q = query.trim().toLowerCase().replace(/^@/, "");
  const people = usePeople(q, withPeople);
  const agents = useAgents();
  const memberIds = useMemo(() => new Set(members.map((m) => m.user.id)), [members]);
  const myAgentIds = useMemo(() => new Set((agents.data ?? []).map((a) => a.user.id)), [agents.data]);

  const suggestions: Pick[] = [
    ...(withPeople ? (people.data ?? []) : [])
      .filter((p) => !memberIds.has(p.id))
      .map((p) => ({ kind: "person" as const, ...p })),
    ...(agents.data ?? [])
      .filter((a) => !memberIds.has(a.user.id) && a.user.handle.includes(q))
      .map((a) => ({ kind: "agent" as const, id: a.user.id, handle: a.user.handle, avatar: a.user.avatar })),
  ];

  /** The roles the picked one can be given: an agent is at most editor, and at most you. */
  const rolesFor = (kind: Pick["kind"]): BoardRole[] =>
    kind === "person" ? [...BOARD_ROLES] : BOARD_ROLES.filter((r) => r !== "owner" && RANK[r] <= RANK[board.role]);

  const choose = (pick: Pick) => {
    const allowed = rolesFor(pick.kind);
    setPicked(pick);
    setRole(allowed.includes("editor") ? "editor" : allowed[0]);
    setQuery("");
    /* The input unmounts without a blur; it comes back closed. */
    setFocused(false);
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: KEYS.board(board.id) });
    void queryClient.invalidateQueries({ queryKey: KEYS.boards });
    void queryClient.invalidateQueries({ queryKey: KEYS.agents });
  };

  const add = useMutation({
    mutationFn: (pick: Pick) =>
      pick.kind === "person"
        ? send("POST", `/boards/${board.id}/members`, { userId: pick.id, role })
        : send("PUT", `/agents/${pick.id}/boards/${board.id}`, { role }),
    onSuccess: () => {
      setPicked(null);
      refresh();
    },
  });
  const inviteByEmail = useMutation({
    mutationFn: () =>
      send<{ added: boolean; invite?: CreatedInvite }>("POST", `/boards/${board.id}/members`, {
        email: email.trim(),
        role: emailRole,
      }),
    onSuccess: (result) => {
      setEmail("");
      setInvite(result.invite ?? null);
      refresh();
    },
  });
  /* Your own agents go through their own route, which works on the inbox too
     and keeps them at viewer or editor; everyone else through the board's. */
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: BoardRole }) =>
      myAgentIds.has(userId)
        ? send("PUT", `/agents/${userId}/boards/${board.id}`, { role })
        : send("PATCH", `/boards/${board.id}/members/${userId}`, { role }),
    onSettled: refresh,
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      myAgentIds.has(userId)
        ? send("DELETE", `/agents/${userId}/boards/${board.id}`)
        : send("DELETE", `/boards/${board.id}/members/${userId}`),
    onSuccess: (_r, userId) => {
      refresh();
      if (userId === myId) {
        onClose();
        navigate("/");
      }
    },
  });

  const error = add.error ?? changeRole.error ?? removeMember.error;

  return (
    <ModalFrame title={`${board.key} · share`} onClose={onClose} size="lg">
      {error && <p className="text-red text-xs mb-3">{error.message}</p>}

      <h4 className="text-label mb-2">{board.isInbox ? "on your inbox" : "people"}</h4>
      <ul className="mb-4">
        {peopleFirst(members).map((m) => {
          const mine = myAgentIds.has(m.user.id);
          const self = m.user.id === myId;
          /* Owners manage anyone (not themselves on the inbox); you manage your own agents. */
          const manage = (isOwner && !(board.isInbox && self)) || mine;
          const roles = BOARD_ROLES.filter((r) => m.user.kind !== "agent" || (r !== "owner" && (!mine || RANK[r] <= RANK[board.role])));
          return (
            <li key={m.user.id} className="flex items-center gap-3 py-1.5 border-b border-divider last:border-b-0">
              <Avatar user={m.user} size={18} />
              <span className="text-ink truncate min-w-0">{m.user.handle}</span>
              {self && <span className="text-faint text-xs">you</span>}
              <span className="flex-1" />
              {/* Fixed columns, so every row's role and action line up whatever they say. */}
              {manage ? (
                <select
                  className={`${input} py-0.5 w-24 shrink-0`}
                  value={m.role}
                  aria-label={`${m.user.handle}'s role`}
                  onChange={(e) => changeRole.mutate({ userId: m.user.id, role: e.target.value as BoardRole })}
                >
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-muted w-24 shrink-0 px-2 border border-transparent">{m.role}</span>
              )}
              <span className="w-14 shrink-0 text-right">
                {(manage || self) && !(board.isInbox && self) && (
                  <button onClick={() => removeMember.mutate(m.user.id)} className="tap text-muted hover:text-red text-xs">
                    {self ? "leave" : "remove"}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <h4 className="text-label mb-2">{withPeople ? "add" : "bring your agents"}</h4>
      {picked ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(picked);
          }}
        >
          <span className={`${input} flex-1 min-w-0 flex items-center gap-2`}>
            <Avatar user={picked} size={16} />
            <span className="truncate">{picked.handle}</span>
            {picked.kind === "agent" && <span className="text-faint text-xs">agent</span>}
            <span className="flex-1" />
            <button type="button" onClick={() => setPicked(null)} className="tap text-muted hover:text-accent" title="Pick someone else">
              <X size={14} />
            </button>
          </span>
          <select className={input} value={role} onChange={(e) => setRole(e.target.value as BoardRole)} aria-label="role">
            {rolesFor(picked.kind).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button className={button} type="submit" disabled={add.isPending}>
            add
          </button>
        </form>
      ) : (
        <div>
          <input
            className={`${input} w-full`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === "Enter" && suggestions[highlight]) {
                e.preventDefault();
                choose(suggestions[highlight]);
              }
            }}
            placeholder={withPeople ? "type a handle: people, or your agents" : "type your agent's handle"}
            aria-label={withPeople ? "add someone by handle" : "bring your agents"}
            autoComplete="off"
          />
          {(focused || q) && (
            <ul className="border-x border-b border-faint max-h-60 overflow-y-auto">
              {suggestions.map((s, i) => (
                <li key={s.id}>
                  <button
                    type="button"
                    /* Before the input's blur hides the list. */
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(s)}
                    onMouseEnter={() => setHighlight(i)}
                    className={`w-full flex items-center gap-3 px-2 py-1.5 pointer-coarse:py-2.5 text-left border-b border-divider last:border-b-0 ${
                      i === highlight ? "bg-raised" : ""
                    }`}
                  >
                    <Avatar user={s} size={18} />
                    <span className="text-bright truncate">{s.handle}</span>
                    {s.kind === "agent" && <span className="text-faint text-xs">your agent</span>}
                  </button>
                </li>
              ))}
              {suggestions.length === 0 && (
                <li className="px-2 py-1.5 text-muted text-sm">
                  {withPeople ? "nobody by that handle" : agents.data?.length ? "no agent of yours by that name" : "you have no agents yet (settings › agents)"}
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {withPeople && (
        <div className="mt-5">
          {!inviting ? (
            <button onClick={() => setInviting(true)} className="text-xs text-faint hover:text-accent">
              not on Copland yet? invite by email
            </button>
          ) : (
            <>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (email.trim()) inviteByEmail.mutate();
                }}
              >
                <input
                  className={`${input} flex-1 min-w-0`}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="friend@example.com"
                  type="email"
                  autoFocus
                />
                <select className={input} value={emailRole} onChange={(e) => setEmailRole(e.target.value as BoardRole)} aria-label="role">
                  {BOARD_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button className={button} type="submit" disabled={inviteByEmail.isPending}>
                  invite
                </button>
              </form>
              {inviteByEmail.error && <p className="text-red text-xs mt-2">{inviteByEmail.error.message}</p>}
              {inviteByEmail.data?.added && !invite && <p className="text-green text-xs mt-2">They already had an account, and are on the board now.</p>}
              {invite && (
                <div className="mt-3 p-2 border border-green/60 bg-green/10 text-xs">
                  <p className="text-green mb-1">
                    {invite.invite.email} has no account here yet. Send them this link; it brings them onto this board:
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="text-yellow truncate flex-1">{invite.url}</code>
                    <button onClick={() => navigator.clipboard.writeText(invite.url)} className="tap text-ink hover:text-accent p-1" title="Copy">
                      <Copy size={14} />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </ModalFrame>
  );
}
