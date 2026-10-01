/* ============================================================================
   Settings → calendars. Connect Google accounts (a redirect through Google's
   consent, /auth/calendar), choose which of their calendars show and in
   what colour, and add ICS links for anything else.
   ========================================================================== */

import { useState, type ReactNode } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import type { CalendarInfo } from "@/domain/calendar";
import { useCalendarSetup, useCalendarSetupEdits } from "@/lib/calendar";
import { Checkbox } from "@/ui/Checkbox";
import { toneBg } from "@/ui/tone";

const input = "bg-raised border border-faint px-2 py-1.5 text-ink placeholder:text-faint focus:outline-none focus:border-accent";
const button = "px-3 py-1.5 pointer-coarse:py-2.5 border border-faint text-ink hover:border-accent hover:text-accent transition-colors disabled:opacity-50";

function CalendarRow({ calendar, trailing }: { calendar: CalendarInfo; trailing?: ReactNode }) {
  const edits = useCalendarSetupEdits();
  return (
    <li className="flex items-center gap-2 py-1">
      <Checkbox
        checked={calendar.visible}
        onChange={(visible) => edits.patch.mutate({ id: calendar.id, visible })}
        label={<span className={calendar.visible ? "text-ink" : "text-muted"}>{calendar.name}</span>}
        size={15}
      />
      {!calendar.writable && <span className="text-xs text-faint">read only</span>}
      <span className="flex-1" />
      <span className="inline-flex gap-1">
        {Array.from({ length: 8 }, (_, t) => (
          <button
            key={t}
            onClick={() => t !== calendar.tone && edits.patch.mutate({ id: calendar.id, tone: t })}
            className={`w-3 h-3 ${toneBg(t)} ${t === calendar.tone ? "outline outline-1 outline-offset-1 outline-bright" : "opacity-40 hover:opacity-100"}`}
            aria-label={`colour ${t + 1}`}
          />
        ))}
      </span>
      {trailing}
    </li>
  );
}

export function CalendarSettings() {
  const { data } = useCalendarSetup();
  const edits = useCalendarSetupEdits();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const error = edits.patch.error ?? edits.sync.error ?? edits.disconnect.error ?? edits.addFeed.error ?? edits.removeFeed.error;
  const feeds = data?.calendars.filter((c) => c.kind === "ics") ?? [];

  return (
    <>
      {error && <p className="text-red text-xs mb-2">{error.message}</p>}

      {data?.accounts.map((account) => (
        <div key={account.id} className="mb-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-bright truncate">{account.email}</span>
            {account.broken && (
              <a href="/auth/calendar" className="text-xs text-red hover:underline">
                disconnected, reconnect
              </a>
            )}
            <span className="flex-1" />
            <button onClick={() => edits.sync.mutate(account.id)} className="tap p-1 text-muted hover:text-accent" title="Refresh the calendar list">
              <RefreshCw size={13} className={edits.sync.isPending ? "animate-spin" : ""} />
            </button>
            <button onClick={() => edits.disconnect.mutate(account.id)} className="tap text-xs text-muted hover:text-red">
              disconnect
            </button>
          </div>
          <ul className="pl-1">
            {data.calendars
              .filter((c) => c.accountId === account.id)
              .map((c) => (
                <CalendarRow key={c.id} calendar={c} />
              ))}
          </ul>
        </div>
      ))}

      <a href="/auth/calendar" className={`${button} inline-block mb-4`}>
        {data?.accounts.length ? "connect another Google account" : "connect Google Calendar"}
      </a>

      {feeds.length > 0 && (
        <ul className="mb-3">
          {feeds.map((c) => (
            <CalendarRow
              key={c.id}
              calendar={c}
              trailing={
                <button onClick={() => edits.removeFeed.mutate(c.id)} className="tap p-1 text-muted hover:text-red" aria-label={`Remove ${c.name}`}>
                  <Trash2 size={13} />
                </button>
              }
            />
          ))}
        </ul>
      )}
      <p className="text-xs text-muted mb-1.5">
        Or add any calendar by its secret ICS link (iCloud, Outlook, Fastmail, a Google calendar's "secret address"). Read only.
      </p>
      <form
        className="flex flex-col sm:flex-row gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !url.trim()) return;
          edits.addFeed.mutate(
            { name: name.trim(), url: url.trim() },
            {
              onSuccess: () => {
                setName("");
                setUrl("");
              },
            },
          );
        }}
      >
        <input className={`${input} sm:w-32`} value={name} onChange={(e) => setName(e.target.value)} placeholder="name" maxLength={60} />
        <input className={`${input} flex-1`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… or webcal://…" />
        <button className={button} type="submit" disabled={edits.addFeed.isPending}>
          {edits.addFeed.isPending ? "checking…" : "add"}
        </button>
      </form>
    </>
  );
}
