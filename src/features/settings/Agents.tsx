/* ============================================================================
   Settings › agents: one page per agent, and one to make a new one.
   ----------------------------------------------------------------------------
   An agent (docs/AGENT-IDENTITIES.md) is a name you give a job, "you/codex",
   with its own tokens and history. Everything on its page is closed until
   you open it: which boards it is on and at what role (never above yours or
   editor), who may give it work, and which of your own data it may read.
   The Worker enforces all of it; this only shows the choices that make sense.
   ========================================================================== */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HANDLE_MAX, handleProblem, normalizeHandle } from "@/domain/handle";
import type { RunStatus } from "@/domain/runs";
import { AGENT_GRANTS, type Agent, type AgentGrant, type BoardRole, type Me } from "@/domain/types";
import { send } from "@/lib/api";
import { uploadAvatar } from "@/lib/avatar";
import { refresh } from "@/lib/live";
import { KEYS, useBoards } from "@/lib/queries";
import { Checkbox } from "@/ui/Checkbox";
import { when } from "@/ui/tone";
import { ConnectSteps, Tokens } from "./Connections";
import { PictureEditor } from "./Profile";
import { Group, Section, button, input } from "./Section";

const GRANT_LABELS: Record<AgentGrant, string> = {
  "calendar:read": "read my calendar",
  "notes:read": "read my notes",
  "notes:write": "write my notes",
};

/** After a change to an agent: the list from the answer, and anything that shows it refetched. */
function useAgentChange<A>(fn: (arg: A) => Promise<unknown>, { boards = false, people = false } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEYS.agents });
      /* This tab's own writes are not echoed back by the live socket. */
      if (boards) refresh(queryClient, ["boards", "board"]);
      if (people) refresh(queryClient, ["people"]);
    },
  });
}

/** The part after the slash, typed with the owner's handle in front. */
function NameInput({ me, value, onChange }: { me: Me; value: string; onChange: (v: string) => void }) {
  return (
    <span className={`${input} flex flex-1 min-w-0 items-baseline focus-within:border-accent`}>
      <span className="text-faint">{me.user.handle}/</span>
      <input
        className="flex-1 min-w-0 bg-transparent text-ink focus:outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={HANDLE_MAX + 1}
        placeholder="codex"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        aria-label="Agent name"
      />
    </span>
  );
}

const nameProblem = (raw: string) => {
  const name = normalizeHandle(raw);
  return name ? handleProblem(name)?.replace("A handle", "A name") ?? null : null;
};

export function NewAgentSection({ me, onCreated }: { me: Me; onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => send<Agent>("POST", "/agents", { name: normalizeHandle(name), description }),
    onSuccess: (agent) => {
      void queryClient.invalidateQueries({ queryKey: KEYS.agents });
      onCreated(agent.user.id);
    },
  });
  const problem = nameProblem(name);

  return (
    <Section
      title="new agent"
      hint={
        <>
          An agent is an assistant with a name of its own: tasks are assigned to it, and history says what it did. It starts
          with nothing: no boards, none of your data, and only you can give it work. You open what it needs on its page.
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !problem) create.mutate();
        }}
      >
        <Group title="name">
          <NameInput me={me} value={name} onChange={setName} />
          {problem && <p className="text-red text-xs mt-2">{problem}</p>}
        </Group>
        <Group title="what it's for">
          <textarea
            className={`${input} w-full min-h-20 resize-y`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            placeholder="Works through the CPL backlog: picks up what is assigned to it, comments when done."
          />
          <p className="text-xs text-faint mt-1">Shown here, and told to the agent when it connects.</p>
        </Group>
        <button className={`${button} mt-4`} type="submit" disabled={!name.trim() || !!problem || create.isPending}>
          create
        </button>
        {create.error && <p className="text-red text-xs mt-2">{create.error.message}</p>}
      </form>
    </Section>
  );
}

function AboutGroup({ me, agent }: { me: Me; agent: Agent }) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  useEffect(() => setName(agent.name), [agent.name]);
  useEffect(() => setDescription(agent.description), [agent.description]);
  const save = useAgentChange(
    () => send("PATCH", `/agents/${agent.user.id}`, { name: normalizeHandle(name), description }),
    { people: true },
  );
  const changed = normalizeHandle(name) !== agent.name || description !== agent.description;
  const problem = nameProblem(name);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && !problem) save.mutate(undefined);
      }}
    >
      <Group title="name">
        <NameInput me={me} value={name} onChange={setName} />
        {problem && <p className="text-red text-xs mt-2">{problem}</p>}
      </Group>
      <Group title="what it's for">
        <textarea
          className={`${input} w-full min-h-20 resize-y`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          placeholder="What this agent is for. Told to it when it connects."
        />
      </Group>
      {changed && (
        <button className={`${button} mt-2`} type="submit" disabled={!!problem || save.isPending}>
          save
        </button>
      )}
      {save.error && <p className="text-red text-xs mt-2">{save.error.message}</p>}
    </form>
  );
}

const ROLE_RANK: Record<BoardRole, number> = { viewer: 0, editor: 1, owner: 2 };

function BoardsGroup({ agent }: { agent: Agent }) {
  const { data: boards } = useBoards();
  const put = useAgentChange(
    ({ boardId, role }: { boardId: string; role: BoardRole }) => send("PUT", `/agents/${agent.user.id}/boards/${boardId}`, { role }),
    { boards: true },
  );
  const remove = useAgentChange((boardId: string) => send("DELETE", `/agents/${agent.user.id}/boards/${boardId}`), {
    boards: true,
  });

  return (
    <Group title="boards">
      <p className="text-xs text-muted mb-2">
        It sees only these, and does at most what you can there, never more than an editor. Taking it off a board also takes
        it off that board&apos;s tasks.
      </p>
      <ul className="text-sm">
        {(boards ?? []).map((b) => {
          const on = agent.boards.find((x) => x.boardId === b.id);
          const roles = (["viewer", "editor"] as const).filter((r) => ROLE_RANK[r] <= ROLE_RANK[b.role]);
          return (
            <li key={b.id} className="flex items-center gap-3 py-1.5 border-b border-divider last:border-b-0">
              <span className={`flex-1 min-w-0 truncate ${on ? "text-ink" : "text-muted"}`}>
                {b.isInbox ? <span className="text-accent">your inbox</span> : b.name}{" "}
                <span className="text-faint">{b.key}</span>
              </span>
              <select
                className={`${input} py-0.5`}
                value={on?.role ?? ""}
                disabled={put.isPending || remove.isPending}
                onChange={(e) =>
                  e.target.value
                    ? put.mutate({ boardId: b.id, role: e.target.value as BoardRole })
                    : remove.mutate(b.id)
                }
                aria-label={`Role on ${b.name}`}
              >
                <option value="">not on it</option>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
      {(put.error ?? remove.error) && <p className="text-red text-xs mt-2">{(put.error ?? remove.error)?.message}</p>}
    </Group>
  );
}

function AccessGroups({ agent }: { agent: Agent }) {
  const patch = useAgentChange((body: Record<string, unknown>) => send("PATCH", `/agents/${agent.user.id}`, body));
  const toggle = (g: AgentGrant) =>
    patch.mutate({ grants: agent.grants.includes(g) ? agent.grants.filter((x) => x !== g) : [...agent.grants, g] });

  return (
    <>
      <Group title="takes work from">
        <div className="flex flex-col gap-1.5 text-sm">
          {(
            [
              ["owner", "only you", "nobody else can assign it a task"],
              ["members", "anyone on its boards", "people on a board it is on can assign it work too"],
            ] as const
          ).map(([value, label, small]) => (
            <label key={value} className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name={`work-${agent.user.id}`}
                checked={agent.workFrom === value}
                onChange={() => patch.mutate({ workFrom: value })}
                className="accent-accent mt-1"
              />
              <span>
                <span className="block text-ink">{label}</span>
                <span className="block text-xs text-muted">{small}</span>
              </span>
            </label>
          ))}
        </div>
      </Group>
      <Group title="your data">
        <p className="text-xs text-muted mb-2">Of your own things, it can only reach what you tick. Settings and keys never.</p>
        <div className="flex flex-col gap-1.5">
          {AGENT_GRANTS.map((g) => (
            <Checkbox key={g} checked={agent.grants.includes(g)} onChange={() => toggle(g)} label={GRANT_LABELS[g]} size={15} />
          ))}
        </div>
      </Group>
      {patch.error && <p className="text-red text-xs mt-2">{patch.error.message}</p>}
    </>
  );
}

const RUN_CLASS: Record<RunStatus, string> = {
  running: "text-ink",
  stale: "text-yellow",
  completed: "text-muted",
  failed: "text-red",
  cancelled: "text-faint",
};

/** Its latest runs: supervised ones declared by whatever starts it (POST /api/runs), interactive ones made by a chat session's first claim; stale once they go quiet. */
function RunsGroup({ agent }: { agent: Agent }) {
  return (
    <Group title="runs">
      {agent.runs.length === 0 ? (
        <p className="text-xs text-muted">
          None yet. A run is one working session: started by whatever launches it (supervised), or made when a chat session claims a task (interactive). Its changes show in history with the run.
        </p>
      ) : (
        <ul className="text-sm">
          {agent.runs.map((r) => (
            <li key={r.id} className="flex flex-wrap gap-x-2 py-0.5">
              <span className="text-faint">{r.short}</span>
              <span className={RUN_CLASS[r.status]}>{r.status}</span>
              <span className="text-faint">{r.kind}</span>
              {r.client && <span className="text-muted">{r.client}</span>}
              {r.claims.length > 0 && <span className="text-muted">on {r.claims.join(", ")}</span>}
              <span className="flex-1" />
              <span className="text-faint">
                {r.endedAt ? `ended ${when(r.endedAt)}` : `heard ${when(r.lastSeenAt)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}

function DangerGroup({ agent, onDeleted }: { agent: Agent; onDeleted: () => void }) {
  const queryClient = useQueryClient();
  const [armed, setArmed] = useState(false);
  const pause = useAgentChange(() => send("PATCH", `/agents/${agent.user.id}`, { paused: !agent.pausedAt }));
  const remove = useMutation({
    mutationFn: () => send("DELETE", `/agents/${agent.user.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEYS.agents });
      refresh(queryClient, ["boards", "board"]);
      onDeleted();
    },
  });

  return (
    <Group title="pause or delete">
      <p className="text-xs text-muted mb-2">
        Paused, its tokens stop working until you resume it, and its runs end. Deleted, it is gone for good: tokens, boards and assignments.
        Its comments and history stay, marked deleted, and its name is free again.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className={button} onClick={() => pause.mutate(undefined)} disabled={pause.isPending}>
          {agent.pausedAt ? "resume" : "pause"}
        </button>
        <button
          className={`${button} ${armed ? "!text-red !border-red" : "hover:!text-red hover:!border-red"}`}
          onClick={() => (armed ? remove.mutate() : setArmed(true))}
          onBlur={() => setArmed(false)}
          disabled={remove.isPending}
        >
          {armed ? `sure? delete ${agent.name}` : "delete"}
        </button>
      </div>
      {(pause.error ?? remove.error) && <p className="text-red text-xs mt-2">{(pause.error ?? remove.error)?.message}</p>}
    </Group>
  );
}

export function AgentSection({ me, agent, onDeleted }: { me: Me; agent: Agent; onDeleted: () => void }) {
  const upload = useAgentChange((file: File) => uploadAvatar(file, `/agents/${agent.user.id}/avatar`), { people: true });
  const removePicture = useAgentChange(() => send("DELETE", `/agents/${agent.user.id}/avatar`), { people: true });

  return (
    <Section
      title={agent.user.handle}
      hint={
        agent.pausedAt ? (
          <span className="text-yellow">Paused since {agent.pausedAt.slice(0, 10)}: nothing it holds works until you resume it.</span>
        ) : (
          <>Your agent. It acts under its own name, with what you open below and never more than you.</>
        )
      }
    >
      <Group title="picture">
        <PictureEditor
          user={agent.user}
          onFile={(file) => upload.mutate(file)}
          onRemove={() => removePicture.mutate(undefined)}
          busy={upload.isPending || removePicture.isPending}
          error={upload.error ?? removePicture.error}
        />
      </Group>
      <AboutGroup me={me} agent={agent} />
      <BoardsGroup agent={agent} />
      <AccessGroups agent={agent} />
      <ConnectSteps as={agent.user.handle} />
      <Tokens tokens={agent.tokens} isPending={false} agentId={agent.user.id} />
      <RunsGroup agent={agent} />
      <DangerGroup agent={agent} onDeleted={onDeleted} />
    </Section>
  );
}
