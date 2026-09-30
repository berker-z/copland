import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Cloud, CloudRain, Sun } from "lucide-react";
import { getMoonPhase } from "@/domain/moon";
import type { Settings } from "@/domain/settings";
import { THEMES } from "@/domain/themes";
import { useSettings } from "@/lib/queries";
import { useUpdateSettings } from "@/lib/settings";
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

/**
 * The ticking parts live in their own component so the second-by-second
 * re-render stops here. In nord-dash the clock was App state, which
 * re-rendered every pane every second.
 */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const dayKey = formatDate(now);
  /* The phase only moves meaningfully per day. */
  const moon = useMemo(() => getMoonPhase(new Date(`${dayKey}T12:00:00`)), [dayKey]);
  const moonLabel = `${moon.name} · ${Math.round(moon.illumination * 100)}% lit · day ${Math.floor(moon.age) + 1}`;

  return (
    <>
      <span className="flex items-center gap-1.5 text-ink cursor-default" title={moonLabel} aria-label={moonLabel}>
        <MoonPhaseIcon phase={moon} size={16} />
        <span className="hidden lg:inline text-muted">{moon.name.replace(/ /g, "_")}</span>
      </span>
      <span className="hidden md:inline-flex items-center gap-2.5">
        <Sep />
        <span className="text-ink">{dayKey}</span>
      </span>
      <Sep />
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

function ThemeMenu() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const theme = settings?.theme ?? document.documentElement.dataset.theme ?? "nord";

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
        <div className="absolute top-full right-0 mt-2 min-w-[12rem] bg-surface border border-faint py-1 z-50" role="listbox">
          {THEMES.map((t) => (
            <button
              key={t.id}
              data-theme={t.id}
              role="option"
              aria-selected={t.id === theme}
              onClick={() => {
                update.mutate({ theme: t.id });
                setOpen(false);
              }}
              className="w-full flex items-center gap-3 px-3.5 py-2 text-left bg-surface text-ink hover:bg-raised transition-colors"
            >
              {/* data-theme on the row makes these tokens preview that theme */}
              <span className="w-2.5 h-2.5 bg-accent flex-shrink-0" aria-hidden />
              <span className={t.id === theme ? "text-accent" : ""}>{t.label.replace(/ /g, "_")}</span>
              {t.id === theme && <span className="ml-auto text-accent">●</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface StatusLineProps {
  userName: string;
  onOpenSettings: () => void;
  onLogout: () => void;
}

/** tmux-style statusline: global state lives here instead of a header. */
export function StatusLine({ userName, onOpenSettings, onLogout }: StatusLineProps) {
  const { data: settings } = useSettings();
  return (
    <header className="fixed top-0 inset-x-0 z-[55] h-11 bg-bar border-b border-divider px-4 flex items-center justify-between gap-4 whitespace-nowrap">
      <div className="flex items-center gap-2 min-w-0">
        <Link to="/" className="flex items-center gap-2 text-accent hover:text-bright transition-colors" title="Dashboard">
          <LogoMark />
          <span>copland</span>
        </Link>
        <span className="text-muted truncate">{userName.toLowerCase()}</span>
      </div>

      <div className="flex items-center gap-2.5">
        <ThemeMenu />
        {settings?.location && (
          <>
            <Sep />
            <WeatherReadout place={settings.location} />
            <span className="hidden sm:inline-flex items-center gap-2.5">
              <Sep />
              <span className="text-muted uppercase">{settings.location.name}</span>
            </span>
          </>
        )}
        <Sep />
        <Clock />
        <Sep />
        <button onClick={onOpenSettings} className="text-muted hover:text-accent transition-colors">
          settings
        </button>
        <Sep />
        <button onClick={onLogout} className="text-muted hover:text-red transition-colors" title="Log out">
          logout
        </button>
      </div>
    </header>
  );
}
