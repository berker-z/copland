/* ============================================================================
   The app: sign-in gate, statusline, and the pane grid.
   ----------------------------------------------------------------------------
   /api/me decides everything: a 401 is the login screen, anything else is
   the dashboard. The grid is the Splits layout from nord-dash: one surface
   split into panes by 1px dividers, all of them ported from nord-dash.
   /b/KEY swaps the grid for a board screen.
   ========================================================================== */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMatch } from "react-router";
import { LoginScreen } from "@/features/auth/LoginScreen";
import { BoardScreen } from "@/features/board/BoardScreen";
import { AgendaPane, CalendarPane } from "@/features/calendar/CalendarPanes";
import { BoardsPane } from "@/features/boards/BoardsPane";
import { InboxPane } from "@/features/inbox/InboxPane";
import { MarketsPane } from "@/features/markets/MarketsPane";
import { NotepadPane } from "@/features/notepad/NotepadPane";
import { SettingsModal, type SettingsPage } from "@/features/settings/SettingsModal";
import { StatusLine } from "@/features/shell/StatusLine";
import { TasksPane } from "@/features/tasks/TasksPane";
import { ApiError } from "@/lib/api";
import { useLiveUpdates } from "@/lib/live";
import { useMe } from "@/lib/queries";
import { useApplyTheme } from "@/lib/settings";

export function App() {
  const me = useMe();
  const signedIn = me.isSuccess;
  const queryClient = useQueryClient();
  /* Which settings page is open, or "start" for wherever it opens by itself. */
  const [settings, setSettings] = useState<SettingsPage | "start" | null>(null);
  const boardRoute = useMatch("/b/:key");

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
        onOpenProfile={() => setSettings("profile")}
        onLogout={logout}
      />
      <main className="flex-1 pt-11">
        {boardRoute?.params.key ? (
          <BoardScreen boardKey={boardRoute.params.key} />
        ) : (
          /* Below lg the three columns dissolve (`contents`) into one, and
             `order` puts what a phone is opened for first: today's agenda
             and tasks, your inbox, then the rest, markets last. */
          <div className="flex flex-col lg:grid lg:grid-cols-3 items-stretch lg:items-start gap-px w-full max-w-[1500px] mx-auto px-0 py-0 sm:px-4 sm:py-4 md:px-8 md:py-6">
            <div className="contents lg:flex lg:flex-col lg:gap-px">
              <div className="order-5 lg:order-none">
                <CalendarPane onOpenSettings={() => setSettings("calendars")} />
              </div>
              <div className="order-1 lg:order-none">
                <AgendaPane onOpenSettings={() => setSettings("calendars")} />
              </div>
              <div className="order-6 lg:order-none">
                <NotepadPane />
              </div>
            </div>
            <div className="contents lg:flex lg:flex-col lg:gap-px">
              <div className="order-2 lg:order-none">
                <TasksPane />
              </div>
              <div className="order-4 lg:order-none">
                <BoardsPane />
              </div>
              <div className="order-3 lg:order-none">
                <InboxPane />
              </div>
            </div>
            <div className="contents lg:flex lg:flex-col lg:gap-px">
              <div className="order-7 lg:order-none">
                <MarketsPane onOpenSettings={setSettings} />
              </div>
            </div>
          </div>
        )}
      </main>
      {settings && (
        <SettingsModal me={me.data} initial={settings === "start" ? undefined : settings} onClose={() => setSettings(null)} />
      )}
    </div>
  );
}
