/* ============================================================================
   Shapes shared by the browser and the Worker: what the API sends and takes.
   No runtime code here beyond constants; see the neighbouring modules for
   rules.
   ========================================================================== */

export interface User {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  isAdmin: boolean;
}

/** Who is making a request, as the Worker resolved it. */
export interface Viewer {
  user: User;
}

export type SignupMode = "invite" | "open" | "closed";

/** GET /api/me */
export interface Me {
  user: User;
  inboxId: string;
  signup: SignupMode;
}

/* ---------------------------------------------------------------- boards --- */

export const BOARD_ROLES = ["owner", "editor", "viewer"] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];

export const STAGE_CATEGORIES = ["backlog", "active", "done", "cancelled"] as const;
export type StageCategory = (typeof STAGE_CATEGORIES)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const LEVELS = ["epic", "story", "task", "milestone"] as const;
export type Level = (typeof LEVELS)[number];

/** A board in the list: what the sidebar and the picker need. */
export interface BoardSummary {
  id: string;
  key: string;
  name: string;
  isInbox: boolean;
  hasPlanning: boolean;
  role: BoardRole;
  memberCount: number;
  openTaskCount: number;
}

export interface BoardMember {
  user: User;
  role: BoardRole;
}

export interface Stage {
  id: string;
  position: number;
  name: string;
  category: StageCategory;
  tone: number;
}

export interface Label {
  id: string;
  name: string;
  tone: number;
}

export interface Task {
  id: string;
  boardId: string;
  number: number;
  /** "CPL-12": the board key and the number. */
  key: string;
  title: string;
  brief: string;
  stageId: string;
  rank: number;
  priority: Priority;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  parentId: string | null;
  level: Level | null;
  assigneeIds: string[];
  labelIds: string[];
  dependsOn: string[];
  commentCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/boards/:id — everything a board screen draws. */
export interface BoardDetail {
  board: BoardSummary;
  members: BoardMember[];
  stages: Stage[];
  labels: Label[];
  tasks: Task[];
}

/* ------------------------------------------------------------- admin ------ */

export interface Invite {
  id: string;
  email: string | null;
  boardId: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedBy: string | null;
  usedAt: string | null;
}

/** POST /api/invites answers with the link once; only its hash is kept. */
export interface CreatedInvite {
  invite: Invite;
  url: string;
}
