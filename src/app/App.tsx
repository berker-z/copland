/* ============================================================================
   The app: sign-in gate, statusline, and the dashboard.
   ----------------------------------------------------------------------------
   /api/me decides everything: a 401 is the login screen, anything else is
   the dashboard. The dashboard is the panes the `dashboard` setting has on,
   in its columns, each drawn by the widget registry (domain/widgets.ts,
   app/widgets.tsx). /b/KEY swaps it for a board screen, /device for
   approving a box's device login (features/device/DeviceScreen.tsx); signing
   in first comes back to the same address, code and all.
   ========================================================================== */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMatch } from "react-router";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { DashboardLayout } from "@/domain/widgets";
import { LoginScreen } from "@/features/auth/LoginScreen";
import { BoardScreen } from "@/features/board/BoardScreen";
import { DeviceScreen } from "@/features/device/DeviceScreen";
import { SettingsModal, type SettingsPage } from "@/features/settings/SettingsModal";
import { StatusLine } from "@/features/shell/StatusLine";
import { ApiError } from "@/lib/api";
import { useLiveUpdates } from "@/lib/live";
import { useMe, useSettings } from "@/lib/queries";
import { useApplyTheme } from "@/lib/settings";
import { PANE_COMPONENTS, type PaneProps } from "./widgets";

/* Literal class names, so Tailwind sees them. */
const GRID_COLS = ["lg:grid-cols-1", "lg:grid-cols-1", "lg:grid-cols-2", "lg:grid-cols-3"];

/**
 * The panes, in their columns: exactly what the map in settings › widgets
 * shows. The column count is the setting's, so a column with nothing in it
 * still takes its width. Below lg the columns dissolve (`contents`) into
 * one, read left to right: the first column top to bottom, then the next.
 */
function Dashboard({ layout, openSettings }: { layout: DashboardLayout; openSettings: PaneProps["openSettings"] }) {
  return (
    <div
      className={`flex flex-col lg:grid ${GRID_COLS[layout.columns.length]} items-stretch lg:items-start gap-2 sm:gap-4 w-full max-w-[1500px] mx-auto px-0 py-2 sm:px-4 sm:py-4 md:px-8 md:py-6`}
    >
      {layout.columns.map((column, i) => (
        <div key={i} className="contents lg:flex lg:flex-col lg:gap-4 min-w-0">
          {column.map((id) => {
            const Pane = PANE_COMPONENTS[id];
            return <Pane key={id} openSettings={openSettings} />;
          })}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const me = useMe();
  const signedIn = me.isSuccess;
  const queryClient = useQueryClient();
  const settings = useSettings(signedIn);
  /* Which settings page is open, or "start" for wherever it opens by itself. */
  const [openSettings, setSettings] = useState<SettingsPage | "start" | null>(null);
  const boardRoute = useMatch("/b/:key");
  const deviceRoute = useMatch("/device");

  useApplyTheme(signedIn);
  useLiveUpdates(signedIn);

  if (me.isPending) return null;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <LoginScreen />;
    return <p className="p-8 text-red">Could not reach the server: {me.error.message}</p>;
  }

  const logout = async () => {
    await fetch("/auth/logout", { method: "POST" });
    queryClient.clear();
    location.assign("/");
  };

  return (
    <div className="min-h-screen bg-divider text-ink font-mono flex flex-col">
      <StatusLine
        user={me.data.user}
        onOpenSettings={() => setSettings("start")}
        onCustomize={() => setSettings("widgets")}
        onOpenProfile={() => setSettings("profile")}
        onLogout={logout}
      />
      <main className="flex-1 pt-11">
        {boardRoute?.params.key ? (
          <BoardScreen boardKey={boardRoute.params.key} />
        ) : deviceRoute ? (
          <DeviceScreen />
        ) : (
          /* Waits for the settings, so the panes do not jump from the default layout to yours. */
          !settings.isPending && <Dashboard layout={(settings.data ?? DEFAULT_SETTINGS).dashboard} openSettings={setSettings} />
        )}
      </main>
      {openSettings && (
        <SettingsModal me={me.data} initial={openSettings === "start" ? undefined : openSettings} onClose={() => setSettings(null)} />
      )}
    </div>
  );
}
