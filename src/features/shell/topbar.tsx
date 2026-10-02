/* ============================================================================
   The statusline's readouts, one component per item in the widget registry
   (domain/widgets.ts): weather, moon, clock. StatusLine places them and the
   separators between them; each hides its own detail on narrow screens.
   ========================================================================== */

import { useEffect, useMemo, useState } from "react";
import { Cloud, CloudRain, Sun } from "lucide-react";
import { getMoonPhase } from "@/domain/moon";
import { useSettings } from "@/lib/queries";
import { MoonPhaseIcon } from "@/ui/MoonPhaseIcon";
import { useWeather } from "./weather";

export const Sep = () => (
  <span className="text-faint select-none" aria-hidden>
    │
  </span>
);

const pad = (n: number) => String(n).padStart(2, "0");
export const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Today's moon. The phase only moves meaningfully per day. */
export function useMoon(dayKey: string) {
  return useMemo(() => {
    const moon = getMoonPhase(new Date(`${dayKey}T12:00:00`));
    const label = `${moon.name} · ${Math.round(moon.illumination * 100)}% lit · day ${Math.floor(moon.age) + 1}`;
    return { moon, label };
  }, [dayKey]);
}

/**
 * The date and the ticking time. The second-by-second re-render stops here;
 * in nord-dash the clock was App state, which re-rendered every pane every
 * second. Below md the date moves into the phone menu.
 */
export function ClockItem() {
  const now = useNow();
  return (
    <>
      <span className="hidden md:inline-flex items-center gap-2.5">
        <span className="text-ink">{formatDate(now)}</span>
        <Sep />
      </span>
      <span className="text-ink tabular-nums">{now.toLocaleTimeString("en-GB", { hour12: false })}</span>
    </>
  );
}

/** Today's moon phase; its name from lg up, and on hover. */
export function MoonItem() {
  /* The day key from the clock would tick every second; the moon only needs
     the date, read once per mount and on the next day's first render. */
  const { moon, label } = useMoon(formatDate(new Date()));
  return (
    <span className="flex items-center gap-1.5 text-ink cursor-default" title={label} aria-label={label}>
      <MoonPhaseIcon phase={moon} size={16} />
      <span className="hidden lg:inline text-muted">{moon.name.replace(/ /g, "_")}</span>
    </span>
  );
}

/* nord-dash's three buckets of WMO codes: clear to overcast, fog, and
   anything falling. */
function WeatherIcon({ code }: { code: number }) {
  if (code <= 3) return <Sun className="text-yellow" size={16} />;
  if (code <= 48) return <Cloud className="text-cyan" size={16} />;
  return <CloudRain className="text-blue" size={16} />;
}

/** The temperature where you set; the place's name only on hover. Nothing without a place. */
export function WeatherItem() {
  const { data: settings } = useSettings();
  const place = settings?.location ?? null;
  const { data: weather, isError } = useWeather(place);
  if (!place) return null;
  return (
    <span className="flex items-center gap-1.5 text-ink" title={isError ? "Weather unavailable" : place.name}>
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
