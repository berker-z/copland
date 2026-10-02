/* ============================================================================
   Settings: everything that used to be hardcoded or in .env, per user.
   Pages, from pagesFor below, grouped by who they are about:
     you        profile (Profile.tsx), and access: what acts as you and how
                to connect it (Connections.tsx)
     agents     one page per agent and one to make a new one (Agents.tsx)
     dashboard  the panes (calendars, markets, the weather's place) and the
                service keys behind them (the vault)
     instance   the people on it, for admins
   ========================================================================== */

import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Copy, Trash2, X } from "lucide-react";
import { VAULT_NAMES, type VaultEntry, type VaultName } from "@/domain/settings";
import type { Agent, CreatedInvite, Me } from "@/domain/types";
import { CalendarSettings } from "@/features/calendar/CalendarSettings";
import { searchCities, type GeoResult } from "@/features/shell/weather";
import { send } from "@/lib/api";
import { KEYS, useAdminInvites, useAdminUsers, useAgents, useSettings, useVault } from "@/lib/queries";
import { useUpdateSettings } from "@/lib/settings";
import { Avatar } from "@/ui/Avatar";
import { ModalFrame } from "@/ui/ModalFrame";
import { usePhone } from "@/ui/useMediaQuery";
import { AgentSection, NewAgentSection } from "./Agents";
import { AccessSection } from "./Connections";
import { ProfileSection } from "./Profile";

import { Group, Section, button, input } from "./Section";

type ListKey = "coins" | "coingeckoCoins" | "coingeckoNfts";

/**
 * One list setting as removable chips plus an add box. The server has the
 * final word on what is valid; `normalize` only saves a round trip for the
 * obvious (case).
 */
function ChipList({
  setting,
  label,
  placeholder,
  normalize,
  maxLength,
}: {
  setting: ListKey;
  label?: string;
  placeholder: string;
  normalize: (raw: string) => string;
  maxLength: number;
}) {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const [draft, setDraft] = useState("");
  const items = settings?.[setting] ?? [];

  const add = () => {
    const value = normalize(draft.trim());
    if (!value || items.includes(value)) return setDraft("");
    update.mutate({ [setting]: [...items, value] });
    setDraft("");
  };

  return (
    <div className="mb-4 last:mb-0">
      {label && <h5 className="text-xs text-muted mb-1.5">{label}</h5>}
      <div className="flex flex-wrap gap-2 mb-2">
        {items.map((c) => (
          <span key={c} className="inline-flex items-center gap-1 border border-faint px-2 py-0.5 text-bright">
            {c}
            <button
              onClick={() => update.mutate({ [setting]: items.filter((x) => x !== c) })}
              className="tap text-muted hover:text-red"
              aria-label={`Remove ${c}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {items.length === 0 && <span className="text-faint text-sm">none</span>}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          className={`${input} flex-1 min-w-0`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
        />
        <button className={button} type="submit">
          add
        </button>
      </form>
      {update.error && <p className="text-red text-xs mt-2">{update.error.message}</p>}
    </div>
  );
}

function MarketsSection() {
  const lower = (s: string) => s.toLowerCase();
  return (
    <Section
      title="markets"
      hint="Binance spot symbols, priced in USDT, need no key. CoinGecko ids (the slug in a coin's or collection's coingecko.com URL) need a coingecko key under service keys."
    >
      <ChipList setting="coins" label="binance" placeholder="BTC" normalize={(s) => s.toUpperCase()} maxLength={12} />
      <ChipList setting="coingeckoCoins" label="coingecko coins, by market cap" placeholder="milady-cult-coin" normalize={lower} maxLength={80} />
      <ChipList setting="coingeckoNfts" label="coingecko nfts, by floor" placeholder="milady-maker" normalize={lower} maxLength={80} />
    </Section>
  );
}

/**
 * Pick the weather's place by name. Open-Meteo's geocoder turns what is
 * typed into candidates; choosing one saves its name and coordinates.
 */
function LocationSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const location = settings?.location;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Search as you type, once typing pauses; a newer search cancels the one
     in flight so results never arrive out of order. */
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      searchCities(q, controller.signal)
        .then((found) => {
          setResults(found);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Search failed");
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const choose = (place: GeoResult) => {
    update.mutate({ location: { name: place.name, latitude: place.latitude, longitude: place.longitude } });
    setQuery("");
    setResults(null);
  };

  return (
    <Section title="weather" hint="Where the statusline weather is for. Open-Meteo, no key needed.">
      <div className="flex items-baseline justify-between gap-2 mb-2 text-sm">
        {location ? (
          <span className="text-bright">
            {location.name}{" "}
            <span className="text-muted tabular-nums">
              {location.latitude.toFixed(2)}, {location.longitude.toFixed(2)}
            </span>
          </span>
        ) : (
          <span className="text-faint">no place set</span>
        )}
        {location && (
          <button onClick={() => update.mutate({ location: null })} className="tap text-xs text-muted hover:text-red">
            clear
          </button>
        )}
      </div>
      <input
        className={`${input} w-full`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search a city"
        maxLength={80}
        aria-label="Search a city"
      />
      {searching && <p className="text-xs text-muted mt-2 animate-pulse">searching…</p>}
      {results && !searching && results.length === 0 && <p className="text-xs text-faint mt-2">no match</p>}
      {results && results.length > 0 && (
        <ul className="mt-2">
          {results.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => choose(r)}
                className="w-full flex items-baseline gap-2 px-2 py-2 text-left border-b border-divider last:border-b-0 hover:bg-raised transition-colors"
              >
                <span className="text-bright">{r.name}</span>
                <span className="text-xs text-muted truncate">{r.detail}</span>
                <span className="ml-auto text-xs text-faint tabular-nums shrink-0">
                  {r.latitude.toFixed(2)}, {r.longitude.toFixed(2)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(error ?? update.error?.message) && <p className="text-red text-xs mt-2">{error ?? update.error?.message}</p>}
    </Section>
  );
}

function VaultRow({ name, entry }: { name: VaultName; entry: VaultEntry | undefined }) {
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState("");
  const save = useMutation({
    mutationFn: () => send<VaultEntry[]>("PUT", `/vault/${name}`, { secret }),
    onSuccess: (entries) => {
      queryClient.setQueryData(KEYS.vault, entries);
      setSecret("");
    },
  });
  const remove = useMutation({
    mutationFn: () => send<VaultEntry[]>("DELETE", `/vault/${name}`),
    onSuccess: (entries) => queryClient.setQueryData(KEYS.vault, entries),
  });

  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-bright">{name}</span>
        {entry && <span className="text-xs text-green">saved ••••{entry.hint}</span>}
      </div>
      <p className="text-xs text-muted mb-1.5">{VAULT_NAMES[name]}</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (secret.trim()) save.mutate();
        }}
      >
        <input
          className={`${input} flex-1`}
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={entry ? "replace key" : "paste key"}
        />
        <button className={button} type="submit" disabled={!secret.trim() || save.isPending}>
          save
        </button>
        {entry && (
          <button type="button" className={`${button} hover:!text-red hover:!border-red`} onClick={() => remove.mutate()}>
            <Trash2 size={14} />
          </button>
        )}
      </form>
      {(save.error ?? remove.error) && <p className="text-red text-xs mt-1">{(save.error ?? remove.error)?.message}</p>}
    </div>
  );
}

function VaultSection() {
  const { data: entries } = useVault();
  return (
    <Section title="service keys" hint="Keys for the services copland calls on your behalf, like CoinGecko for the markets pane. Stored encrypted on the server, never sent back to the browser, and never reachable by an agent.">
      {(Object.keys(VAULT_NAMES) as VaultName[]).map((name) => (
        <VaultRow key={name} name={name} entry={entries?.find((e) => e.name === name)} />
      ))}
    </Section>
  );
}

function InstanceSection({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const { data: users } = useAdminUsers();
  const { data: invites } = useAdminInvites();
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  const invite = useMutation({
    mutationFn: () => send<CreatedInvite>("POST", "/admin/invites", { email: email.trim() || null }),
    onSuccess: (result) => {
      setCreated(result);
      setEmail("");
      void queryClient.invalidateQueries({ queryKey: KEYS.adminInvites });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => send("DELETE", `/admin/invites/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEYS.adminInvites }),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { admin?: boolean; disabled?: boolean } }) =>
      send("PATCH", `/admin/users/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEYS.adminUsers });
      void queryClient.invalidateQueries({ queryKey: KEYS.me });
    },
  });

  const open = (invites ?? []).filter((i) => !i.usedAt && i.expiresAt > new Date().toISOString());

  return (
    <Section
      title="people"
      hint={
        <>
          Who has an account on this copland. Sign-up is <span className="text-ink">{me.signup}</span>. Admins let people
          in and can make others admins; it gives no access to anyone&apos;s boards or notes.
        </>
      }
    >
      <Group title="accounts">
        {patch.error && <p className="text-red text-xs mb-2">{patch.error.message}</p>}
        <ul className="text-sm">
          {(users ?? []).map((u) => {
            const self = u.id === me.user.id;
            return (
              <li key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 border-b border-divider last:border-b-0">
                <Avatar user={u} size={18} />
                <span className={`min-w-0 flex-1 truncate ${u.disabledAt ? "text-faint line-through" : "text-ink"}`}>
                  {u.handle} <span className="text-muted">{u.email}</span>
                </span>
                <button
                  onClick={() => patch.mutate({ id: u.id, body: { admin: !u.isAdmin } })}
                  className={`tap text-xs ${u.isAdmin ? "text-accent hover:text-red" : "text-faint hover:text-accent"}`}
                  title={u.isAdmin ? (self ? "Stop being an admin" : "Remove admin") : "Make admin"}
                >
                  {u.isAdmin ? "admin" : "make admin"}
                </button>
                {!self && (
                  <button
                    onClick={() => patch.mutate({ id: u.id, body: { disabled: !u.disabledAt } })}
                    className="tap text-xs text-muted hover:text-red"
                  >
                    {u.disabledAt ? "enable" : "disable"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </Group>

      <Group title="invites">
        {me.signup === "closed" ? (
          <p className="text-xs text-faint">Sign-up is closed, so there is nobody to invite.</p>
        ) : (
          <>
            <p className="text-xs text-muted mb-2">A link works once and expires in 14 days.</p>
            <form
              className="flex gap-2 mb-3"
              onSubmit={(e) => {
                e.preventDefault();
                invite.mutate();
              }}
            >
              <input
                className={`${input} flex-1 min-w-0`}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email (optional: lock the link to it)"
              />
              <button className={button} type="submit" disabled={invite.isPending}>
                invite
              </button>
            </form>
          </>
        )}
        {invite.error && <p className="text-red text-xs mb-2">{invite.error.message}</p>}
        {created && (
          <div className="mb-3 p-2 border border-green/60 bg-green/10 text-xs">
            <p className="text-green mb-1">Link made. It is shown only now:</p>
            <div className="flex items-center gap-2">
              <code className="text-yellow truncate flex-1">{created.url}</code>
              <button onClick={() => navigator.clipboard.writeText(created.url)} className="tap text-ink hover:text-accent p-1" title="Copy">
                <Copy size={14} />
              </button>
            </div>
          </div>
        )}
        {open.length > 0 && (
          <ul className="text-sm">
            {open.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 py-1">
                <span className="text-muted truncate">
                  {i.email ?? "anyone with the link"} · until {i.expiresAt.slice(0, 10)}
                </span>
                <button onClick={() => revoke.mutate(i.id)} className="tap text-muted hover:text-red text-xs">
                  revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </Group>
    </Section>
  );
}

/**
 * A settings page. Fixed ones by name; an agent's is "agent:<id>", so the
 * list grows and shrinks with your agents.
 */
export type SettingsPage =
  | "profile"
  | "access"
  | "new-agent"
  | `agent:${string}`
  | "calendars"
  | "markets"
  | "weather"
  | "keys"
  | "people";

interface Page {
  id: SettingsPage;
  label: ReactNode;
  group: string;
}

/**
 * Grouped by who: you (how you show up, and what acts as you), your agents
 * (each its own page), the panes on your dashboard and the keys behind them,
 * and for admins the instance itself.
 */
function pagesFor(me: Me, agents: Agent[]): Page[] {
  return [
    { id: "profile", label: "profile", group: "you" },
    { id: "access", label: "access", group: "you" },
    ...agents.map((a) => ({
      id: `agent:${a.user.id}` as const,
      label: (
        <span className="flex items-center gap-2 min-w-0">
          <Avatar user={a.user} size={14} />
          <span className="truncate">{a.name}</span>
          {a.pausedAt && <span className="text-xs text-yellow">paused</span>}
        </span>
      ),
      group: "agents",
    })),
    { id: "new-agent", label: <span className="text-muted">+ new agent</span>, group: "agents" },
    { id: "calendars", label: "calendars", group: "dashboard" },
    { id: "markets", label: "markets", group: "dashboard" },
    { id: "weather", label: "weather", group: "dashboard" },
    { id: "keys", label: "service keys", group: "dashboard" },
    ...(me.user.isAdmin ? [{ id: "people" as const, label: "people", group: "instance" }] : []),
  ];
}

function PageBody({ page, me, agents, go }: { page: SettingsPage; me: Me; agents: Agent[]; go: (p: SettingsPage | null) => void }) {
  if (page.startsWith("agent:")) {
    const agent = agents.find((a) => `agent:${a.user.id}` === page);
    return agent ? (
      <AgentSection key={agent.user.id} me={me} agent={agent} onDeleted={() => go("new-agent")} />
    ) : (
      <p className="text-xs text-muted animate-pulse">loading…</p>
    );
  }
  switch (page) {
    case "profile":
      return <ProfileSection me={me} />;
    case "access":
      return <AccessSection />;
    case "new-agent":
      return <NewAgentSection me={me} onCreated={(id) => go(`agent:${id}`)} />;
    case "calendars":
      return (
        <Section title="calendars" hint="Google accounts and ICS links. What is ticked shows in the calendar and agenda panes.">
          <CalendarSettings />
        </Section>
      );
    case "markets":
      return <MarketsSection />;
    case "weather":
      return <LocationSection />;
    case "keys":
      return <VaultSection />;
    case "people":
      return <InstanceSection me={me} />;
  }
  return null;
}

/**
 * Settings: a list of pages on the left and the open one on the right. On a
 * phone the list is a screen of its own and a page opens over it, with a
 * way back, like a phone's own settings.
 */
export function SettingsModal({ me, initial, onClose }: { me: Me; initial?: SettingsPage; onClose: () => void }) {
  const phone = usePhone();
  const { data: agents = [] } = useAgents();
  const pages = pagesFor(me, agents);
  const [picked, setPicked] = useState<SettingsPage | null>(initial ?? null);
  /* On a wide screen something is always open; on a phone nothing is until tapped. */
  const page = picked ?? (phone ? null : pages[0].id);
  const groups = [...new Set(pages.map((p) => p.group))];

  const nav = (
    <nav className="w-full sm:w-44 shrink-0 sm:border-r border-divider overflow-y-auto py-2 sm:py-3" aria-label="Settings">
      {groups.map((group) => (
        <div key={group} className="mb-3 last:mb-0">
          <div className="text-label px-5 sm:px-4 pb-1">{group}</div>
          {pages
            .filter((p) => p.group === group)
            .map((p) => (
              <button
                key={p.id}
                onClick={() => setPicked(p.id)}
                aria-current={p.id === page ? "page" : undefined}
                className={`w-full flex items-center justify-between gap-2 text-left px-5 sm:px-4 py-1.5 pointer-coarse:py-3 transition-colors ${
                  p.id === page ? "bg-raised text-accent" : "text-ink hover:bg-raised"
                }`}
              >
                {p.label}
                <ChevronRight size={14} className="sm:hidden text-faint shrink-0" />
              </button>
            ))}
        </div>
      ))}
    </nav>
  );

  return (
    <ModalFrame
      title={
        phone && page ? (
          <button onClick={() => setPicked(null)} className="flex items-center gap-1.5 hover:text-accent">
            <ChevronLeft size={16} /> settings
          </button>
        ) : (
          "settings"
        )
      }
      onClose={onClose}
      size="xl"
      bodyClassName="!p-0"
    >
      <div className="flex h-full sm:h-[min(80vh,42rem)]">
        {(!phone || !page) && nav}
        {page && (
          <div className="flex-1 min-w-0 overflow-y-auto p-5">
            <PageBody page={page} me={me} agents={agents} go={setPicked} />
          </div>
        )}
      </div>
    </ModalFrame>
  );
}
