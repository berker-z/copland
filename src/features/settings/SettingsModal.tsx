/* ============================================================================
   Settings: everything that used to be hardcoded or in .env, per user.
   Sections: markets (coins), weather location, API keys (the vault), and,
   for admins, the instance (invites and users).
   ========================================================================== */

import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Trash2, X } from "lucide-react";
import { VAULT_NAMES, type VaultEntry, type VaultName } from "@/domain/settings";
import type { CreatedInvite, Me } from "@/domain/types";
import { send } from "@/lib/api";
import { KEYS, useAdminInvites, useAdminUsers, useSettings, useVault } from "@/lib/queries";
import { useUpdateSettings } from "@/lib/settings";
import { ModalFrame } from "@/ui/ModalFrame";

const input =
  "bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent";
const button = "px-3 py-1.5 border border-faint text-ink hover:border-accent hover:text-accent transition-colors disabled:opacity-50";

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="py-4 first:pt-0 border-b border-divider last:border-b-0">
      <h4 className="text-label mb-1">{title}</h4>
      {hint && <p className="text-xs text-muted mb-3">{hint}</p>}
      {children}
    </section>
  );
}

function CoinsSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const [draft, setDraft] = useState("");
  const coins = settings?.coins ?? [];

  const add = () => {
    const symbol = draft.trim().toUpperCase();
    if (!symbol || coins.includes(symbol)) return setDraft("");
    update.mutate({ coins: [...coins, symbol] });
    setDraft("");
  };

  return (
    <Section title="markets" hint="Binance spot symbols, priced in USDT. No key needed.">
      <div className="flex flex-wrap gap-2 mb-3">
        {coins.map((c) => (
          <span key={c} className="inline-flex items-center gap-1 border border-faint px-2 py-0.5 text-bright">
            {c}
            <button
              onClick={() => update.mutate({ coins: coins.filter((x) => x !== c) })}
              className="text-muted hover:text-red"
              aria-label={`Remove ${c}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {coins.length === 0 && <span className="text-faint text-sm">no coins</span>}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className={`${input} flex-1`} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="BTC" maxLength={12} />
        <button className={button} type="submit">
          add
        </button>
      </form>
      {update.error && <p className="text-red text-xs mt-2">{update.error.message}</p>}
    </Section>
  );
}

function LocationSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const location = settings?.location;
  const [name, setName] = useState(location?.name ?? "");
  const [coords, setCoords] = useState(location ? `${location.latitude}, ${location.longitude}` : "");
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const [lat, lon] = coords.split(",").map((s) => Number(s.trim()));
    if (!name.trim() || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return setError("A name and 'latitude, longitude' are both needed.");
    }
    setError(null);
    update.mutate({ location: { name: name.trim(), latitude: lat, longitude: lon } });
  };

  return (
    <Section title="weather" hint="Where the statusline weather is for. Open-Meteo, no key needed.">
      <div className="flex flex-col sm:flex-row gap-2">
        <input className={`${input} sm:w-36`} value={name} onChange={(e) => setName(e.target.value)} placeholder="istanbul" />
        <input className={`${input} flex-1`} value={coords} onChange={(e) => setCoords(e.target.value)} placeholder="41.0082, 28.9784" />
        <button className={button} onClick={save}>
          save
        </button>
      </div>
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
    <Section title="api keys" hint="Stored encrypted on the server and never sent back to the browser.">
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

  const open = (invites ?? []).filter((i) => !i.usedAt && i.expiresAt > new Date().toISOString());

  return (
    <Section title="instance" hint={`Sign-up is ${me.signup}. Invite links work once and expire in 14 days.`}>
      {me.signup !== "closed" && (
        <form
          className="flex gap-2 mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <input className={`${input} flex-1`} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email (optional: lock the link to it)" />
          <button className={button} type="submit" disabled={invite.isPending}>
            invite
          </button>
        </form>
      )}
      {invite.error && <p className="text-red text-xs mb-2">{invite.error.message}</p>}
      {created && (
        <div className="mb-3 p-2 border border-green/60 bg-green/10 text-xs">
          <p className="text-green mb-1">Link made. It is shown only now:</p>
          <div className="flex items-center gap-2">
            <code className="text-yellow truncate flex-1">{created.url}</code>
            <button onClick={() => navigator.clipboard.writeText(created.url)} className="text-ink hover:text-accent p-1" title="Copy">
              <Copy size={14} />
            </button>
          </div>
        </div>
      )}
      {open.length > 0 && (
        <ul className="mb-3 text-sm">
          {open.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-2 py-1">
              <span className="text-muted truncate">
                {i.email ?? "anyone with the link"} · until {i.expiresAt.slice(0, 10)}
              </span>
              <button onClick={() => revoke.mutate(i.id)} className="text-muted hover:text-red text-xs">
                revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <h5 className="text-label mt-2 mb-1">users</h5>
      <ul className="text-sm">
        {(users ?? []).map((u) => (
          <li key={u.id} className="flex items-center justify-between gap-2 py-1">
            <span className={u.disabledAt ? "text-faint line-through" : "text-ink"}>
              {u.name} <span className="text-muted">{u.email}</span>
            </span>
            {u.isAdmin && <span className="text-xs text-accent">admin</span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function SettingsModal({ me, onClose }: { me: Me; onClose: () => void }) {
  return (
    <ModalFrame title="settings" onClose={onClose} size="lg">
      <CoinsSection />
      <LocationSection />
      <VaultSection />
      {me.user.isAdmin && <InstanceSection me={me} />}
    </ModalFrame>
  );
}
