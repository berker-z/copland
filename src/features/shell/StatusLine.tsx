import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Cloud, CloudRain, MoreHorizontal, Sun } from "lucide-react";
import { getMoonPhase } from "@/domain/moon";
import type { Settings } from "@/domain/settings";
import { THEMES } from "@/domain/themes";
import type { User } from "@/domain/types";
import { useSettings } from "@/lib/queries";
import { useUpdateSettings } from "@/lib/settings";
import { Avatar } from "@/ui/Avatar";
import { useDismiss } from "@/ui/useDismiss";
import { InboxMenu } from "./InboxMenu";
import { LogoMark } from "@/ui/LogoMark";
import { MoonPhaseIcon } from "@/ui/MoonPhaseIcon";
import { useWeather } from "./weather";

const Sep = () => (
  <span className="text-faint select-none" aria-hidden>
    │
  </span>
);

const pad = (n: number) => String(n).padStart(2, "0");
const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Today's moon. The phase only moves meaningfully per day. */
function useMoon(dayKey: string) {
  return useMemo(() => {
    const moon = getMoonPhase(new Date(`${dayKey}T12:00:00`));
    const label = `${moon.name} · ${Math.round(moon.illumination * 100)}% lit · day ${Math.floor(moon.age) + 1}`;
    return { moon, label };
  }, [dayKey]);
}

/**
 * The ticking parts live in their own component so the second-by-second
 * re-render stops here. In nord-dash the clock was App state, which
 * re-rendered every pane every second.
 */
function Clock() {
  const now = useNow();
  const dayKey = formatDate(now);
  const { moon, label } = useMoon(dayKey);

  return (
    <>
      <span className="hidden sm:flex items-center gap-1.5 text-ink cursor-default" title={label} aria-label={label}>
        <MoonPhaseIcon phase={moon} size={16} />
        <span className="hidden lg:inline text-muted">{moon.name.replace(/ /g, "_")}</span>
      </span>
      <span className="hidden md:inline-flex items-center gap-2.5">
        <Sep />
        <span className="text-ink">{dayKey}</span>
      </span>
      <span className="hidden sm:inline">
        <Sep />
      </span>
      <span className="text-ink tabular-nums">{now.toLocaleTimeString("en-GB", { hour12: false })}</span>
    </>
  );
}

/* nord-dash's three buckets of WMO codes: clear to overcast, fog, and
   anything falling. */
function WeatherIcon({ code }: { code: number }) {
  if (code <= 3) return <Sun className="text-yellow" size={16} />;
  if (code <= 48) return <Cloud className="text-cyan" size={16} />;
  return <CloudRain className="text-blue" size={16} />;
}

function WeatherReadout({ place }: { place: NonNullable<Settings["location"]> }) {
  const { data: weather, isError } = useWeather(place);
  return (
    <span className="flex items-center gap-1.5 text-ink" title={isError ? "Weather unavailable" : undefined}>
      {weather ? (
        <>
          <WeatherIcon code={weather.weatherCode} />
          {weather.temperature}°C
        </>
      ) : (
        <span className={isError ? "text-faint" : "text-muted animate-pulse"}>--°C</span>
      )}
    </span>
  );
}

function useTheme() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const theme = settings?.theme ?? document.documentElement.dataset.theme ?? "nord";
  return { theme, setTheme: (id: string) => update.mutate({ theme: id }) };
}

/** The theme rows, shared by the theme menu and the phone menu. */
function ThemeOptions({ onPicked }: { onPicked: () => void }) {
  const { theme, setTheme } = useTheme();
  return (
    <div role="listbox" aria-label="Color theme">
      {THEMES.map((t) => (
        <button
          key={t.id}
          data-theme={t.id}
          role="option"
          aria-selected={t.id === theme}
          onClick={() => {
            setTheme(t.id);
            onPicked();
          }}
          className="w-full flex items-center gap-3 px-3.5 py-2 pointer-coarse:py-3 text-left bg-surface text-ink hover:bg-raised transition-colors"
        >
          {/* data-theme on the row makes these tokens preview that theme */}
          <span className="w-2.5 h-2.5 bg-accent flex-shrink-0" aria-hidden />
          <span className={t.id === theme ? "text-accent" : ""}>{t.label.replace(/ /g, "_")}</span>
          {t.id === theme && <span className="ml-auto text-accent">●</span>}
        </button>
      ))}
    </div>
  );
}

function ThemeMenu() {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const active = THEMES.find((t) => t.id === theme);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-muted hover:text-accent transition-colors"
        title="Switch color theme"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        theme:{(active?.label ?? theme).replace(/ /g, "_")}
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-2 min-w-[12rem] bg-surface border border-faint py-1 z-50">
          <ThemeOptions onPicked={close} />
        </div>
      )}
    </div>
  );
}

/**
 * Below sm the statusline has room for the mark, weather, clock and
 * settings; the rest (date, moon, theme, logout) moves in here.
 */
function PhoneMenu({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    <div className="relative sm:hidden" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="tap text-muted hover:text-accent transition-colors"
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && <PhoneMenuPanel onLogout={onLogout} />}
    </div>
  );
}

function PhoneMenuPanel({ onLogout }: { onLogout: () => void }) {
  /* Opened for a glance, so no ticking: the date and moon as of opening. */
  const dayKey = formatDate(new Date());
  const { moon, label } = useMoon(dayKey);
  return (
    <div className="absolute top-full right-0 mt-1 w-[min(18rem,calc(100vw-2rem))] max-h-[calc(100dvh-4rem)] overflow-auto bg-surface border border-faint z-50 whitespace-normal">
      <div className="px-3.5 py-3 border-b border-divider flex items-center gap-2.5 text-ink">
        <span className="shrink-0">{dayKey}</span>
        <Sep />
        <MoonPhaseIcon phase={moon} size={16} />
        <span className="text-muted text-sm truncate" title={label}>
          {moon.name.replace(/ /g, "_")}
        </span>
      </div>
      <div className="text-label px-3.5 pt-3 pb-1">theme</div>
      <div className="pb-1">
        <ThemeOptions onPicked={() => {}} />
      </div>
      <button
        onClick={onLogout}
        className="w-full text-left px-3.5 py-3 border-t border-divider text-muted hover:text-red hover:bg-raised transition-colors"
      >
        logout
      </button>
    </div>
  );
}

interface StatusLineProps {
  user: User;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
  onLogout: () => void;
}

/** tmux-style statusline: global state lives here instead of a header. */
export function StatusLine({ user, onOpenSettings, onOpenProfile, onLogout }: StatusLineProps) {
  const { data: settings } = useSettings();
  return (
    <header className="fixed top-0 inset-x-0 z-[55] h-11 bg-bar border-b border-divider px-4 flex items-center justify-between gap-4 whitespace-nowrap">
      <div className="flex items-center gap-2 min-w-0">
        <Link to="/" className="flex items-center gap-2 text-accent hover:text-bright transition-colors" title="Dashboard">
          <LogoMark />
          <span className="hidden sm:inline">copland</span>
        </Link>
        <button onClick={onOpenProfile} className="hidden sm:inline-flex items-center gap-2 min-w-0 text-muted hover:text-accent transition-colors" title="Your profile">
          <Avatar user={user} size={18} />
          <span className="truncate">{user.handle}</span>
        </button>
      </div>

      <div className="flex items-center gap-2.5">
        <span className="hidden sm:inline-flex items-center gap-2.5">
          <ThemeMenu />
          <Sep />
        </span>
        {settings?.location && (
          <>
            <WeatherReadout place={settings.location} />
            <span className="hidden sm:inline-flex items-center gap-2.5">
              <Sep />
              <span className="text-muted uppercase">{settings.location.name}</span>
            </span>
          </>
        )}
        {settings?.location && <Sep />}
        <Clock />
        <Sep />
        <InboxMenu />
        <Sep />
        <button onClick={onOpenSettings} className="text-muted hover:text-accent transition-colors pointer-coarse:py-2.5">
          settings
        </button>
        <span className="hidden sm:inline-flex items-center gap-2.5">
          <Sep />
          <button onClick={onLogout} className="text-muted hover:text-red transition-colors" title="Log out">
            logout
          </button>
        </span>
        <PhoneMenu onLogout={onLogout} />
      </div>
    </header>
  );
}
