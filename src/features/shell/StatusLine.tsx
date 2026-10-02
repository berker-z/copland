import { useCallback, useRef, useState } from "react";
import { Link } from "react-router";
import { LayoutDashboard, LogOut, MoreHorizontal, RotateCw, Settings as SettingsIcon } from "lucide-react";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { requirementMet, topbarOn, topbarSpec } from "@/domain/widgets";
import type { User } from "@/domain/types";
import { TOPBAR_COMPONENTS } from "@/app/widgets";
import { useSettings } from "@/lib/queries";
import { useNewVersion } from "@/lib/versionState";
import { Avatar } from "@/ui/Avatar";
import { useDismiss } from "@/ui/useDismiss";
import { LogoMark } from "@/ui/LogoMark";
import { MoonPhaseIcon } from "@/ui/MoonPhaseIcon";
import { Sep, formatDate, useMoon } from "./topbar";

/**
 * Below sm the statusline has room for the mark, weather, clock and the
 * icons; the date, the moon when it is on, and "customize dashboard" move
 * in here.
 */
function PhoneMenu({ moon, onCustomize }: { moon: boolean; onCustomize: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    <div className="relative sm:hidden" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="tap flex items-center text-muted hover:text-accent transition-colors"
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <PhoneMenuPanel
          moon={moon}
          onCustomize={() => {
            setOpen(false);
            onCustomize();
          }}
        />
      )}
    </div>
  );
}

function PhoneMenuPanel({ moon: showMoon, onCustomize }: { moon: boolean; onCustomize: () => void }) {
  /* Opened for a glance, so no ticking: the date and moon as of opening. */
  const dayKey = formatDate(new Date());
  const { moon, label } = useMoon(dayKey);
  return (
    <div className="absolute top-full right-0 mt-1 w-[min(18rem,calc(100vw-2rem))] bg-surface border border-faint z-50 whitespace-normal">
      <div className="px-3.5 py-3 flex items-center gap-2.5 text-ink">
        <span className="shrink-0">{dayKey}</span>
        {showMoon && (
          <>
            <Sep />
            <MoonPhaseIcon phase={moon} size={16} />
            <span className="text-muted text-sm truncate" title={label}>
              {moon.name.replace(/ /g, "_")}
            </span>
          </>
        )}
      </div>
      <button
        onClick={onCustomize}
        className="w-full flex items-center gap-2.5 px-3.5 py-3 border-t border-divider text-muted hover:text-accent hover:bg-raised transition-colors"
      >
        <LayoutDashboard size={16} aria-hidden />
        customize dashboard
      </button>
    </div>
  );
}

/**
 * Shown once the Worker answers with a newer build than this tab runs. A
 * quiet line, never a reload of its own: someone may be mid-edit. A phone's
 * bar has no room to spare, so there it is an icon standing in for the mark.
 */
function NewVersion() {
  return (
    <button
      onClick={() => window.location.reload()}
      className="tap shrink-0 flex items-center text-accent hover:text-bright transition-colors"
      title="A new version of copland is out; reload to use it"
      aria-label="New version: reload"
    >
      <RotateCw size={16} className="sm:hidden" aria-hidden />
      <span className="hidden sm:inline">new version · reload</span>
    </button>
  );
}

interface StatusLineProps {
  user: User;
  onOpenSettings: () => void;
  /** Settings straight at the widgets page, with the dashboard's map. */
  onCustomize: () => void;
  onOpenProfile: () => void;
  onLogout: () => void;
}

const iconButton = "tap flex items-center text-muted transition-colors";

/**
 * tmux-style statusline: global state lives here instead of a header. The
 * readouts and the inbox badge come from the widget registry
 * (domain/widgets.ts), the ones the dashboard setting has on, in its order;
 * customize, settings and logout are always there.
 */
export function StatusLine({ user, onOpenSettings, onCustomize, onOpenProfile, onLogout }: StatusLineProps) {
  const { data: settings = DEFAULT_SETTINGS } = useSettings();
  const newVersion = useNewVersion();
  const on = settings.dashboard.topbar.map(topbarSpec).filter((t) => requirementMet(t, settings));
  const readouts = on.filter((t) => !t.icon);
  const icons = on.filter((t) => t.icon);

  return (
    <header className="fixed top-0 inset-x-0 z-[55] h-11 bg-bar border-b border-divider px-4 flex items-center justify-between gap-4 whitespace-nowrap">
      <div className="flex items-center gap-2 min-w-0">
        <Link
          to="/"
          className={`${newVersion ? "hidden sm:flex" : "flex"} items-center gap-2 text-accent hover:text-bright transition-colors`}
          title="Dashboard"
        >
          <LogoMark />
          <span className="hidden sm:inline">copland</span>
        </Link>
        <button onClick={onOpenProfile} className="hidden sm:inline-flex items-center gap-2 min-w-0 text-muted hover:text-accent transition-colors" title="Your profile">
          <Avatar user={user} size={18} />
          <span className="truncate">{user.handle}</span>
        </button>
        {newVersion && <NewVersion />}
      </div>

      <div className="flex items-center gap-2.5">
        {readouts.map((t, i) => {
          const Item = TOPBAR_COMPONENTS[t.id];
          /* On a phone the items in the ⋯ menu are gone, and a separator
             with nothing shown before it would dangle. */
          const shownBeforeOnPhone = readouts.slice(0, i).some((r) => !r.phoneMenu);
          return (
            <span key={t.id} className={`${t.phoneMenu ? "hidden sm:inline-flex" : "inline-flex"} items-center gap-2.5`}>
              {i > 0 && (shownBeforeOnPhone ? <Sep /> : <span className="hidden sm:inline"><Sep /></span>)}
              <Item />
            </span>
          );
        })}
        <span className="flex items-center gap-3 pl-1.5">
          {icons.map((t) => {
            const Item = TOPBAR_COMPONENTS[t.id];
            return <Item key={t.id} />;
          })}
          <button
            onClick={onCustomize}
            className={`${iconButton} hidden sm:flex hover:text-accent`}
            title="Customize the dashboard"
            aria-label="Customize the dashboard"
          >
            <LayoutDashboard size={16} aria-hidden />
          </button>
          <button onClick={onOpenSettings} className={`${iconButton} hover:text-accent`} title="Settings" aria-label="Settings">
            <SettingsIcon size={16} aria-hidden />
          </button>
          <button onClick={onLogout} className={`${iconButton} hover:text-red`} title="Log out" aria-label="Log out">
            <LogOut size={16} aria-hidden />
          </button>
          <PhoneMenu moon={topbarOn(settings.dashboard, "moon")} onCustomize={onCustomize} />
        </span>
      </div>
    </header>
  );
}
