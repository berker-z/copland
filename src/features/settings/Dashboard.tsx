/* ============================================================================
   Settings › dashboard › widgets and theme.
   ----------------------------------------------------------------------------
   The widgets page is the map of the dashboard (WidgetMap.tsx): lanes for
   the columns, blocks for the panes, the statusline along the top and a
   tray of what is off. It is loaded when the page is first opened, so the
   dragging code stays out of the bundle everyone loads.
   ========================================================================== */

import { Suspense, lazy } from "react";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { THEMES } from "@/domain/themes";
import { useSettings } from "@/lib/queries";
import { useUpdateSettings } from "@/lib/settings";
import { Section } from "./Section";

const WidgetMap = lazy(() => import("./WidgetMap"));

/* ---------------------------------------------------------------- widgets -- */

export function DashboardSection() {
  return (
    <Section
      title="widgets"
      hint="Your dashboard in miniature. Drag a block to move it, into the tray to switch it off, out of the tray to switch it on; or focus one and use the arrow keys, or its ⋯ menu. Boards, the clock and the inbox bell are always there."
    >
      <Suspense fallback={<p className="text-xs text-muted animate-pulse">loading…</p>}>
        <WidgetMap />
      </Suspense>
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
