/* ============================================================================
   The app: sign-in gate, statusline, and the pane grid.
   ----------------------------------------------------------------------------
   /api/me decides everything: a 401 is the login screen, anything else is
   the dashboard. The grid is the Splits layout from nord-dash: one surface
   split into panes by 1px dividers. Its panes come over from nord-dash one
   at a time; until they do, their slots say so.
   ========================================================================== */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMatch } from "react-router";
import { LoginScreen } from "@/features/auth/LoginScreen";
import { BoardScreen } from "@/features/board/BoardScreen";
import { BoardsPane } from "@/features/boards/BoardsPane";
import { MarketsPane } from "@/features/markets/MarketsPane";
import { NotepadPane } from "@/features/notepad/NotepadPane";
import { SettingsModal } from "@/features/settings/SettingsModal";
import { StatusLine } from "@/features/shell/StatusLine";
import { TasksPane } from "@/features/tasks/TasksPane";
import { VersePane } from "@/features/verse/VersePane";
import { ApiError } from "@/lib/api";
import { useLiveUpdates } from "@/lib/live";
import { useMe } from "@/lib/queries";
import { useApplyTheme } from "@/lib/settings";
import { WidgetFrame } from "@/ui/WidgetFrame";

function Porting({ title }: { title: string }) {
  return (
    <WidgetFrame title={title}>
      <p className="text-faint text-sm">not ported yet</p>
    </WidgetFrame>
  );
}

export function App() {
  const me = useMe();
  const signedIn = me.isSuccess;
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      <StatusLine userName={me.data.user.name} onOpenSettings={() => setSettingsOpen(true)} onLogout={logout} />
      <main className="flex-1 pt-11">
        {boardRoute?.params.key ? (
          <BoardScreen boardKey={boardRoute.params.key} />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 items-start gap-px w-full max-w-[1500px] mx-auto px-4 py-4 md:px-8 md:py-6">
            <div className="flex flex-col gap-px">
              <Porting title="/calendar" />
              <Porting title="/daily_agenda" />
              <NotepadPane />
            </div>
            <div className="flex flex-col gap-px">
              <TasksPane />
              <BoardsPane />
            </div>
            <div className="flex flex-col gap-px">
              <MarketsPane onOpenSettings={() => setSettingsOpen(true)} />
              <VersePane onOpenSettings={() => setSettingsOpen(true)} />
            </div>
          </div>
        )}
      </main>
      {settingsOpen && <SettingsModal me={me.data} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
