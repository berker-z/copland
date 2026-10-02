/* ============================================================================
   The browser's half of the widget registry: which component draws each
   pane and statusline item listed in domain/widgets.ts. The Record types
   make a new id there fail to compile until it has a component here.
   ========================================================================== */

import type { ReactNode } from "react";
import type { PaneId, TopbarId } from "@/domain/widgets";
import { BoardsPane } from "@/features/boards/BoardsPane";
import { AgendaPane, CalendarPane } from "@/features/calendar/CalendarPanes";
import { InboxBadge } from "@/features/inbox/InboxBadge";
import { InboxPane } from "@/features/inbox/InboxPane";
import { MarketsPane } from "@/features/markets/MarketsPane";
import { NotepadPane } from "@/features/notepad/NotepadPane";
import type { SettingsPage } from "@/features/settings/SettingsModal";
import { ClockItem, MoonItem, WeatherItem } from "@/features/shell/topbar";
import { TasksPane } from "@/features/tasks/TasksPane";

/** What the dashboard hands every pane: a way to open settings at a page. */
export interface PaneProps {
  openSettings: (page: SettingsPage) => void;
}

export const PANE_COMPONENTS: Record<PaneId, (props: PaneProps) => ReactNode> = {
  calendar: ({ openSettings }) => <CalendarPane onOpenSettings={() => openSettings("calendars")} />,
  agenda: ({ openSettings }) => <AgendaPane onOpenSettings={() => openSettings("calendars")} />,
  notepad: () => <NotepadPane />,
  tasks: () => <TasksPane />,
  boards: () => <BoardsPane />,
  inbox: () => <InboxPane />,
  markets: ({ openSettings }) => <MarketsPane onOpenSettings={openSettings} />,
};

export const TOPBAR_COMPONENTS: Record<TopbarId, () => ReactNode> = {
  weather: WeatherItem,
  moon: MoonItem,
  clock: ClockItem,
  "inbox-badge": InboxBadge,
};
