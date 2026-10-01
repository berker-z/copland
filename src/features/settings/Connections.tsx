/* ============================================================================
   Settings › assistants and settings › access: using copland from an AI
   assistant or a script.
   ----------------------------------------------------------------------------
   Assistants is the how-to: the MCP URL to paste into Claude and how to
   connect each kind of client. Access is what is connected: the user's own
   tokens and the apps they approved, with when each was last used. Whatever connects acts as this
   user with exactly their board roles (worker/tokens.ts), and a task's
   history names it ("via Claude Code").

   Three ways in, easiest first:
     claude.ai / Claude desktop   OAuth: paste the URL, sign in, allow
     Claude Code                  the same OAuth from the terminal
     anything else                a personal token as a Bearer header
   ========================================================================== */

import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { agentLabel } from "@/domain/agents";
import type { ApiToken, ApiTokenScope, CreatedToken } from "@/domain/types";
import { send } from "@/lib/api";
import { KEYS, useTokens } from "@/lib/queries";

import { Group, Section, button, input } from "./Section";

/** A value to paste somewhere, with a copy button. Wraps rather than scrolls on a phone. */
function CopyLine({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard blocked (plain http, permissions): the text is selectable anyway. */
    }
  };
  return (
    <div className="flex items-start gap-2 bg-raised border border-faint px-2 py-1.5 text-xs">
      <code aria-label={label} className="text-yellow flex-1 min-w-0 break-all">
        {value}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        className={`tap shrink-0 p-0.5 transition-colors ${copied ? "text-green" : "text-muted hover:text-accent"}`}
        title={`Copy ${label}`}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <h5 className="text-xs text-bright mb-1">{title}</h5>
      <div className="text-xs text-muted space-y-1.5">{children}</div>
    </div>
  );
}

const EXPIRY: { value: string; label: string; days: number | null }[] = [
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "1 year", days: 365 },
  { value: "never", label: "no expiry", days: null },
];

function TokenRow({ token, onRevoke, pending }: { token: ApiToken; onRevoke: () => void; pending: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const agent = token.agent ? agentLabel(token.agent) : null;
  return (
    <li className="flex items-center gap-2 py-2 border-b border-divider last:border-b-0">
      <span className="flex-1 min-w-0">
        <span className="block truncate text-ink">
          {token.name}
          {agent && agent !== token.name && <span className="text-muted"> · {agent}</span>}
        </span>
        <span className="block text-xs text-muted">
          <span className={token.scope === "read" ? "text-blue" : "text-yellow"}>
            {token.scope === "read" ? "read only" : "read + write"}
          </span>
          {" · "}
          {token.lastUsedAt ? `used ${token.lastUsedAt.slice(0, 10)}` : "never used"}
          {token.kind === "personal" && ` · ${token.expiresAt ? `until ${token.expiresAt.slice(0, 10)}` : "no expiry"}`}
        </span>
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={() => (confirming ? onRevoke() : setConfirming(true))}
        onBlur={() => setConfirming(false)}
        className={`shrink-0 text-xs transition-colors ${confirming ? "text-red" : "text-muted hover:text-red"}`}
      >
        {confirming ? "sure? revoke" : token.kind === "oauth" ? "disconnect" : "revoke"}
      </button>
    </li>
  );
}

function Tokens() {
  const queryClient = useQueryClient();
  const { data: tokens, isPending } = useTokens();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiTokenScope>("write");
  const [expiry, setExpiry] = useState("90");
  const [created, setCreated] = useState<CreatedToken | null>(null);

  const create = useMutation({
    mutationFn: () =>
      send<CreatedToken>("POST", "/tokens", {
        name: name.trim(),
        scope,
        days: EXPIRY.find((e) => e.value === expiry)?.days ?? 90,
      }),
    onSuccess: (result) => {
      setCreated(result);
      setName("");
      void queryClient.invalidateQueries({ queryKey: KEYS.tokens });
    },
  });
  /* A revoke that did not happen must not look like one that did: the token
     would still work while its owner thinks it is dead. So the list comes
     from the server's answer, and a failure says so. */
  const revoke = useMutation({
    mutationFn: (id: string) => send<ApiToken[]>("DELETE", `/tokens/${id}`),
    onSuccess: (list) => queryClient.setQueryData(KEYS.tokens, list),
  });

  const apps = (tokens ?? []).filter((t) => t.kind === "oauth");
  const personal = (tokens ?? []).filter((t) => t.kind === "personal");
  const rows = (list: ApiToken[]) =>
    list.map((t) => (
      <TokenRow key={t.id} token={t} pending={revoke.isPending} onRevoke={() => revoke.mutate(t.id)} />
    ));

  return (
    <>
      {revoke.error && <p className="text-red text-xs mb-2">{revoke.error.message}</p>}
      <Group title="connected apps">
        {isPending ? (
          <p className="text-xs text-muted animate-pulse">loading…</p>
        ) : apps.length === 0 ? (
          <p className="text-xs text-faint">None. Apps appear here when you connect one from assistants.</p>
        ) : (
          <ul className="text-sm">{rows(apps)}</ul>
        )}
      </Group>

      <Group title="personal tokens">
        {!isPending && personal.length === 0 && <p className="text-xs text-faint mb-3">None yet.</p>}
        {personal.length > 0 && <ul className="text-sm mb-3">{rows(personal)}</ul>}
        {created && (
          <div className="mb-3 p-2 border border-green/60 bg-green/10 text-xs">
            <p className="text-green mb-1.5">
              Token “{created.token.name}” made. Copy it now: it is shown only this once.
            </p>
            <CopyLine value={created.secret} label="token" />
            <button type="button" onClick={() => setCreated(null)} className="tap mt-1.5 text-muted hover:text-accent">
              [ done ]
            </button>
          </div>
        )}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <input
            className={`${input} flex-1 min-w-[10rem]`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="new token name"
            maxLength={60}
            aria-label="Token name"
          />
          <select className={input} value={scope} onChange={(e) => setScope(e.target.value as ApiTokenScope)} aria-label="Access">
            <option value="write">read + write</option>
            <option value="read">read only</option>
          </select>
          <select className={input} value={expiry} onChange={(e) => setExpiry(e.target.value)} aria-label="Expiry">
            {EXPIRY.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
          <button className={button} type="submit" disabled={!name.trim() || create.isPending}>
            create
          </button>
        </form>
        {create.error && <p className="text-red text-xs mt-2">{create.error.message}</p>}
      </Group>
    </>
  );
}

export function AssistantsSection() {
  const mcpUrl = `${window.location.origin}/mcp`;
  return (
    <Section
      title="assistants"
      hint={
        <>
          Use copland from Claude or another AI assistant: “what's due this week?”, “move LNCH-4 to done”. Whatever
          connects acts as you, with your role on each board, and its changes show in a task's history as “via
          Claude”. What is connected is under access.
        </>
      }
    >
      <Step title="claude.ai and the Claude app">
        <p>Settings › Connectors › add a custom connector, paste this URL, connect, and allow access.</p>
        <CopyLine value={mcpUrl} label="MCP URL" />
      </Step>
      <Step title="Claude Code">
        <p>Run once, then type /mcp in Claude Code to sign in:</p>
        <CopyLine value={`claude mcp add --transport http copland ${mcpUrl}`} label="command" />
      </Step>
      <Step title="other clients and scripts">
        <p>
          Make a token under access and send it as <code className="text-ink">Authorization: Bearer &lt;token&gt;</code>,
          to the MCP URL or to <code className="text-ink">/api</code> itself. A read-only token can look but not change.
        </p>
      </Step>
    </Section>
  );
}

export function AccessSection() {
  return (
    <Section
      title="access"
      hint="Everything that can act as you without a browser. Each one has your board roles and nothing more; revoke it and it stops working at once."
    >
      <Tokens />
    </Section>
  );
}
