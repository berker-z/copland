/* ============================================================================
   Settings › dashboard › widgets and theme.
   ----------------------------------------------------------------------------
   One switch per pane and statusline item in the widget registry
   (domain/widgets.ts), except the ones that are always on. A widget that
   needs a setting (the weather needs a place) cannot be switched on before
   it has one: switching it on asks for the place right there, and picking
   one saves both at once. Clearing the place switches the weather off with
   it; the Worker refuses the one without the other.
   ========================================================================== */

import { useEffect, useState, type ReactNode } from "react";
import { CheckSquare, Square } from "lucide-react";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { THEMES } from "@/domain/themes";
import {
  PANES,
  TOPBAR,
  paneOn,
  requirementMet,
  toggleWidget,
  topbarOn,
  type PaneSpec,
  type TopbarSpec,
} from "@/domain/widgets";
import { searchCities, type GeoResult } from "@/features/shell/weather";
import { useSettings } from "@/lib/queries";
import { useUpdateSettings } from "@/lib/settings";
import { Group, Section, input } from "./Section";

/* ------------------------------------------------------------ city search -- */

/**
 * Pick a place by name. Open-Meteo's geocoder turns what is typed into
 * candidates; choosing one hands its name and coordinates to `onPick`.
 */
function CityPicker({ onPick, autoFocus }: { onPick: (place: GeoResult) => void; autoFocus?: boolean }) {
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

  return (
    <div>
      <input
        className={`${input} w-full`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search a city"
        maxLength={80}
        aria-label="Search a city"
        autoFocus={autoFocus}
      />
      {searching && <p className="text-xs text-muted mt-2 animate-pulse">searching…</p>}
      {results && !searching && results.length === 0 && <p className="text-xs text-faint mt-2">no match</p>}
      {results && results.length > 0 && (
        <ul className="mt-2">
          {results.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => {
                  onPick(r);
                  setQuery("");
                  setResults(null);
                }}
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
      {error && <p className="text-red text-xs mt-2">{error}</p>}
    </div>
  );
}

/* ---------------------------------------------------------------- widgets -- */

function Switch({
  spec,
  on,
  onChange,
  children,
}: {
  spec: PaneSpec | TopbarSpec;
  on: boolean;
  onChange: (on: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <li className="border-b border-divider last:border-b-0">
      <button
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className="w-full flex items-start gap-3 px-1 py-2 pointer-coarse:py-3 text-left hover:bg-raised transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {on ? <CheckSquare size={16} className="text-green shrink-0 mt-0.5" /> : <Square size={16} className="text-muted shrink-0 mt-0.5" />}
        <span className="min-w-0">
          <span className={on ? "text-bright" : "text-ink"}>{spec.name}</span>
          <span className="block text-xs text-muted">{spec.description}</span>
        </span>
      </button>
      {children}
    </li>
  );
}

/** The weather's switch, which needs a place before it can be on. */
function WeatherSwitch({ spec }: { spec: TopbarSpec }) {
  const { data: settings = DEFAULT_SETTINGS } = useSettings();
  const update = useUpdateSettings();
  const [picking, setPicking] = useState(false);
  const layout = settings.dashboard;
  const on = topbarOn(layout, spec.id);
  const place = settings.location;

  const turn = (next: boolean) => {
    if (next && !requirementMet(spec, settings)) return setPicking(true);
    setPicking(false);
    update.mutate({ dashboard: toggleWidget(layout, spec.id, next) });
  };

  return (
    <Switch spec={spec} on={on} onChange={turn}>
      <div className="pl-8 pr-1 pb-3 text-sm">
        {place && !picking && (
          <div className="flex items-baseline gap-2">
            <span className="text-muted">place</span>
            <span className="text-bright">{place.name}</span>
            <span className="text-faint tabular-nums text-xs">
              {place.latitude.toFixed(2)}, {place.longitude.toFixed(2)}
            </span>
            <span className="flex-1" />
            <button onClick={() => setPicking(true)} className="tap text-xs text-muted hover:text-accent">
              change
            </button>
            <button
              onClick={() => update.mutate({ location: null, dashboard: toggleWidget(layout, spec.id, false) })}
              className="tap text-xs text-muted hover:text-red"
            >
              clear
            </button>
          </div>
        )}
        {!place && !picking && <p className="text-xs text-faint">Needs a place: switching it on asks for one.</p>}
        {picking && (
          <div>
            <p className="text-xs text-muted mb-2">
              {place ? "Pick a new place." : "Where is the weather for? Picking a place switches it on."}{" "}
              <button onClick={() => setPicking(false)} className="tap text-muted hover:text-ink underline">
                cancel
              </button>
            </p>
            <CityPicker
              autoFocus
              onPick={(r) => {
                setPicking(false);
                update.mutate({
                  location: { name: r.name, latitude: r.latitude, longitude: r.longitude },
                  /* A new place for weather that was off leaves it off; a
                     first place was asked for to switch it on. */
                  ...(place ? {} : { dashboard: toggleWidget(layout, spec.id, true) }),
                });
              }}
            />
          </div>
        )}
      </div>
    </Switch>
  );
}

export function DashboardSection() {
  const { data: settings = DEFAULT_SETTINGS } = useSettings();
  const update = useUpdateSettings();
  const layout = settings.dashboard;
  const set = (id: Parameters<typeof toggleWidget>[1]) => (on: boolean) => update.mutate({ dashboard: toggleWidget(layout, id, on) });

  return (
    <Section
      title="widgets"
      hint="What is on your dashboard and in the statusline. Boards, the clock and the inbox bell are always there."
    >
      <Group title="panes">
        <ul>
          {PANES.filter((p) => !p.required).map((p) => (
            <Switch key={p.id} spec={p} on={paneOn(layout, p.id)} onChange={set(p.id)} />
          ))}
        </ul>
      </Group>
      <Group title="statusline">
        <ul>
          {TOPBAR.filter((t) => !t.required).map((t) =>
            t.requires === "location" ? (
              <WeatherSwitch key={t.id} spec={t} />
            ) : (
              <Switch key={t.id} spec={t} on={topbarOn(layout, t.id)} onChange={set(t.id)} />
            ),
          )}
        </ul>
      </Group>
      {update.error && <p className="text-red text-xs mt-2">{update.error.message}</p>}
    </Section>
  );
}

/* ------------------------------------------------------------------ theme -- */

export function ThemeSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const theme = settings?.theme ?? document.documentElement.dataset.theme ?? DEFAULT_SETTINGS.theme;
  return (
    <Section title="theme" hint="The colours of everything. Each row previews its own.">
      <div role="radiogroup" aria-label="Color theme" className="border border-divider">
        {THEMES.map((t) => (
          <button
            key={t.id}
            data-theme={t.id}
            role="radio"
            aria-checked={t.id === theme}
            onClick={() => update.mutate({ theme: t.id })}
            className="w-full flex items-center gap-3 px-3.5 py-2 pointer-coarse:py-3 text-left bg-surface text-ink hover:bg-raised transition-colors border-b border-divider last:border-b-0"
          >
            {/* data-theme on the row makes these tokens preview that theme */}
            <span className="w-2.5 h-2.5 bg-accent flex-shrink-0" aria-hidden />
            <span className={t.id === theme ? "text-accent" : ""}>{t.label.replace(/ /g, "_")}</span>
            {t.id === theme && <span className="ml-auto text-accent">●</span>}
          </button>
        ))}
      </div>
      {update.error && <p className="text-red text-xs mt-2">{update.error.message}</p>}
    </Section>
  );
}
