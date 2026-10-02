/* ============================================================================
   /device: letting a box in (COPL-47, worker/routes/device.ts).
   ----------------------------------------------------------------------------
   The box shows a code and this address. Signed in (App's gate sends you
   through sign-in and back here, code and all), you see what is asking,
   match the code against the box's screen, tick which of your agents it may
   run, and approve or deny. Approving makes ordinary tokens, listed and
   revocable in settings: a read-only one for you, a read-and-write one per
   ticked agent. The box collects them itself; nothing is shown or copied
   here. Without ?code= there is a box to type it into.
   ========================================================================== */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorSmartphone, TriangleAlert } from "lucide-react";
import { useSearchParams } from "react-router";
import { normalizeUserCode, type DeviceRequestInfo } from "@/domain/device";
import { api, ApiError, send } from "@/lib/api";
import { KEYS, useAgents } from "@/lib/queries";
import { Checkbox } from "@/ui/Checkbox";
import { button, input } from "@/features/settings/Section";

const approveButton = button.replace("border-faint text-ink", "border-accent text-accent");
const denyButton = button.replace("hover:border-accent hover:text-accent", "hover:border-red hover:text-red");

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-xl mx-auto px-0 py-2 sm:px-4 sm:py-8">
      <div className="bg-surface border border-faint">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-divider text-blue text-xs tracking-[0.16em] uppercase">
          <MonitorSmartphone size={13} />
          connect_a_box
          <span className="flex-1 border-t border-faint/50" aria-hidden />
        </div>
        <div className="p-4 sm:p-6 text-ink text-sm">{children}</div>
      </div>
    </div>
  );
}

/** The code the person types, when the link did not carry one (or carried a bad one). */
function CodeEntry({ initial, problem }: { initial: string; problem: string | null }) {
  const [, setParams] = useSearchParams();
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(problem);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = normalizeUserCode(text);
    if (!code) return setError("A code is eight letters and digits, like ABCD-EFGH.");
    setParams({ code });
  };
  return (
    <Frame>
      <p className="mb-4 leading-relaxed">Type the code your box shows.</p>
      <form onSubmit={submit} className="flex gap-2">
        <input
          className={`${input} flex-1 min-w-0 uppercase tracking-[0.2em]`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="ABCD-EFGH"
          aria-label="Code from the box"
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className={button}>
          continue
        </button>
      </form>
      {error && <p className="mt-3 text-xs text-red">{error}</p>}
    </Frame>
  );
}

function Finished({ status }: { status: "approved" | "denied" | "expired" }) {
  const text = {
    approved: <span className="text-green">Done. Go back to the box.</span>,
    denied: <span className="text-muted">Denied. The box was told no and got nothing.</span>,
    expired: <span className="text-muted">This code has expired. Start again on the box for a new one.</span>,
  }[status];
  return (
    <Frame>
      <p className="leading-relaxed">{text}</p>
      {status === "approved" && (
        <p className="mt-3 text-xs text-muted leading-relaxed">
          Its tokens are in settings › access (yours) and settings › agents (each agent's), named after the box, and
          can be revoked there.
        </p>
      )}
    </Frame>
  );
}

function Approve({ code, request }: { code: string; request: DeviceRequestInfo }) {
  const queryClient = useQueryClient();
  const agents = useAgents();
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  /* Everything ticked but the paused ones, once the list is in. */
  useEffect(() => {
    if (agents.data && ticked === null) setTicked(new Set(agents.data.filter((a) => !a.pausedAt).map((a) => a.user.id)));
  }, [agents.data, ticked]);

  const answer = useMutation({
    mutationFn: (approve: boolean) =>
      approve
        ? send<DeviceRequestInfo>("POST", "/device/approve", { userCode: code, agentIds: [...(ticked ?? [])] })
        : send<DeviceRequestInfo>("POST", "/device/deny", { userCode: code }),
    onSuccess: (data) => {
      queryClient.setQueryData(["device", code], data);
      void queryClient.invalidateQueries({ queryKey: KEYS.tokens });
      void queryClient.invalidateQueries({ queryKey: KEYS.agents });
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: ["device", code] }),
  });

  const toggle = (id: string, on: boolean) => {
    const next = new Set(ticked ?? []);
    if (on) next.add(id);
    else next.delete(id);
    setTicked(next);
  };

  return (
    <Frame>
      <p className="text-bright leading-relaxed">
        {request.client} on <span className="text-blue">{request.host}</span> wants to connect to your copland.
      </p>

      <div className="my-5 text-center">
        <div className="text-label mb-1">its code</div>
        <div className="text-2xl text-bright tracking-[0.3em]">{code}</div>
        <div className="text-xs text-muted mt-1">This must be the code on the box's screen.</div>
      </div>

      <div className="mb-5 p-3 border border-yellow/60 bg-yellow/10 text-yellow text-xs leading-relaxed flex gap-2">
        <TriangleAlert size={14} className="shrink-0 mt-0.5" />
        <span>Only approve a code shown by your own box. Anyone who has this code and you approve gets these tokens.</span>
      </div>

      <h4 className="text-label mb-2">agents it may run</h4>
      {agents.isPending ? (
        <p className="text-xs text-muted mb-4">Loading your agents…</p>
      ) : agents.error ? (
        <p className="text-xs text-red mb-4">Could not load your agents: {agents.error.message}</p>
      ) : agents.data.length === 0 ? (
        <p className="text-xs text-muted mb-4 leading-relaxed">
          You have no agents yet, so the box will only show your work. Make one in settings › agents, then connect the box
          again to let it run it.
        </p>
      ) : (
        <ul className="mb-4">
          {agents.data.map((a) => (
            <li key={a.user.id} className="py-1.5 border-b border-divider last:border-b-0">
              <Checkbox
                checked={ticked?.has(a.user.id) ?? false}
                onChange={(on) => toggle(a.user.id, on)}
                className="text-left items-start"
                label={
                  <>
                    @{a.user.handle}
                    {a.pausedAt && <span className="text-muted"> · paused: its token works once you resume it</span>}
                  </>
                }
              />
            </li>
          ))}
        </ul>
      )}

      <div className="text-xs text-muted leading-relaxed mb-5 space-y-1.5">
        <p>Approving creates:</p>
        <p>
          <span className="text-blue">a read-only token for you</span>, so the box can show your agents' work;
        </p>
        <p>
          <span className="text-yellow">a read and write token for each agent you tick</span>, so the box can start their
          runs.
        </p>
        <p>All revocable in settings › access and settings › agents.</p>
      </div>

      {answer.error && <p className="mb-3 text-xs text-red">{answer.error.message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={denyButton} disabled={answer.isPending} onClick={() => answer.mutate(false)}>
          deny
        </button>
        <button
          type="button"
          className={approveButton}
          disabled={answer.isPending || agents.isPending || ticked === null}
          onClick={() => answer.mutate(true)}
        >
          approve
        </button>
      </div>
    </Frame>
  );
}

export function DeviceScreen() {
  const [params] = useSearchParams();
  const raw = params.get("code") ?? "";
  const code = normalizeUserCode(raw);
  const request = useQuery({
    queryKey: ["device", code],
    queryFn: () => api<DeviceRequestInfo>(`/device/${code}`),
    enabled: code !== null,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (!code) return <CodeEntry key={raw} initial={raw} problem={raw ? "That is not a code like ABCD-EFGH." : null} />;
  if (request.isPending) return <Frame>Looking up {code}…</Frame>;
  if (request.error) {
    const problem = request.error instanceof ApiError && request.error.status === 404 ? request.error.message : `Could not look it up: ${request.error.message}`;
    return <CodeEntry key={code} initial={code} problem={problem} />;
  }
  if (request.data.status !== "pending") return <Finished status={request.data.status} />;
  return <Approve code={code} request={request.data} />;
}
