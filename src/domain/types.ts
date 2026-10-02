/* ============================================================================
   Shapes shared by the browser and the Worker: what the API sends and takes.
   No runtime code here beyond constants; see the neighbouring modules for
   rules.
   ========================================================================== */

import type { RunStatus } from "./runs";

export interface User {
  id: string;
  /** A person, or an agent acting for one (docs/AGENT-IDENTITIES.md). */
  kind: "person" | "agent";
  /** Null for an agent: it has no address and never signs in. */
  email: string | null;
  /** What they go by: unique, lowercase (domain/handle.ts). An agent's is "owner/name". */
  handle: string;
  /** Where their uploaded picture is fetched; null shows initials. */
  avatar: string | null;
  isAdmin: boolean;
  /** The person an agent belongs to; null for a person. */
  ownerId: string | null;
}

/** Personal data of its owner an agent may be given. Board work needs none. */
export const AGENT_GRANTS = ["calendar:read", "notes:read", "notes:write"] as const;
export type AgentGrant = (typeof AGENT_GRANTS)[number];

/** Who is making a request, as the Worker resolved it. */
export interface Viewer {
  user: User;
  /** Set when the request came with an API token instead of a session. */
  access?: ApiAccess;
  /** Set when `user` is an agent: who it acts for, and what of theirs it may reach. */
  agent?: { owner: User; grants: AgentGrant[]; workFrom: "owner" | "members"; description: string };
}

export type SignupMode = "invite" | "open" | "closed";

/** GET /api/me */
export interface Me {
  user: User;
  /** Null for an agent that has not been added to its owner's inbox. */
  inboxId: string | null;
  signup: SignupMode;
  /** For an agent: the person it acts for. */
  owner?: User;
}

/* ---------------------------------------------------------------- boards --- */

export const BOARD_ROLES = ["owner", "editor", "viewer"] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];

/**
 * What a stage means, in the order work flows. backlog is parked, todo is
 * ready to be picked up, active is being worked on, blocked waits on a
 * person: those four are open. done and cancelled close a task.
 */
export const STAGE_CATEGORIES = ["backlog", "todo", "active", "blocked", "done", "cancelled"] as const;
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
  role: BoardRole;
  memberCount: number;
  openTaskCount: number;
}

export interface BoardMember {
  user: User;
  role: BoardRole;
}

/** GET /api/people: someone on the instance, for the share picker. Never their email. */
export interface Person {
  id: string;
  handle: string;
  avatar: string | null;
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
  attachments: Attachment[];
  /** A run working on it right now (routes/runs.ts), or null. Only live claims are sent. */
  claim: TaskClaim | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A run's live hold on a task: whose run, which run, and until when unless renewed. */
export interface TaskClaim {
  userId: string;
  runId: string;
  /** "8f31": how the run is named to people. */
  run: string;
  until: string;
}

/**
 * A parent the change moved along with it (parents follow their children,
 * domain/tasks.ts followChildren), in the order they moved.
 */
export interface AlsoMoved {
  id: string;
  key: string;
  stageId: string;
}

/** What creating or changing a task returns: the task, and any parents that followed it. */
export type TaskWrite = Task & { alsoMoved?: AlsoMoved[] };

/** GET /api/tasks/mine: which tasks are yours and which you handed to your agents (routes/work.ts). */
export interface MyWork {
  mine: { taskId: string; boardId: string }[];
  /** Always empty for an agent. */
  delegated: { taskId: string; boardId: string }[];
}

/** GET /api/boards/:id — everything a board screen draws. */
export interface BoardDetail {
  board: BoardSummary;
  members: BoardMember[];
  stages: Stage[];
  labels: Label[];
  tasks: Task[];
  /** The board's rules for working on it: markdown, '' when there are none. */
  notes: string;
  /** Its docs, metadata only; the bytes are fetched one at a time. */
  docs: BoardDoc[];
}

/** Longest a board's notes may be, in characters. */
export const MAX_BOARD_NOTES = 1000;

/** A reference file that belongs to a board (routes/docs.ts). */
export interface BoardDoc {
  id: string;
  name: string;
  /** MIME type. */
  type: string;
  size: number;
  /** R2 key; the file is at /api/attachments/<key>. */
  key: string;
  /** What the uploader says it is; '' when they said nothing. */
  description: string;
  /** From a text doc: its first heading or opening lines; '' otherwise. */
  excerpt: string;
  /** Handle of whoever added it, when they still exist. */
  addedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/boards/:id/docs/:docId: one doc, with its text when it is a text doc. */
export interface BoardDocContent {
  doc: BoardDoc;
  /** The text, for text/plain, text/markdown and text/csv; null for anything else. */
  text: string | null;
  /** True when text stops short of the whole file. */
  truncated: boolean;
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

/* -------------------------------------------------------------- comments -- */

export interface Comment {
  id: string;
  taskId: string;
  authorId: string;
  authorHandle: string;
  authorAvatar: string | null;
  text: string;
  /** Who it mentions, resolved when it was written: ids, with their handles as they are now. */
  mentions: { id: string; handle: string }[];
  createdAt: string;
  editedAt: string | null;
}

/** One row of a task's history (GET /api/tasks/:id/events). */
export interface TaskEvent {
  id: string;
  kind: string;
  actorHandle: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** What made the change when it was not the web app ("Claude"). */
  via: string | null;
  /** The run it came from ("8f31"), when it came through a run's credential. */
  run: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------ api access -- */

export type ApiTokenScope = "read" | "write";

/** A token someone handed to a tool, as settings lists it. Never the secret. */
export interface ApiToken {
  id: string;
  /** personal: made in settings; oauth: an app connected through its "Connect". */
  kind: "personal" | "oauth";
  name: string;
  scope: ApiTokenScope;
  /** The MCP client that last used it ("claude-code"). */
  client: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** Null: a personal token without an expiry. */
  expiresAt: string | null;
}

/** One of my agents, as settings › agents shows it (GET /api/agents). */
export interface Agent {
  user: User;
  /** The part after the slash. */
  name: string;
  /** What it is for; also told to the agent in the MCP guide. */
  description: string;
  workFrom: "owner" | "members";
  pausedAt: string | null;
  grants: AgentGrant[];
  /** The boards it is on, at the role it was given (it acts at most at yours). */
  boards: { boardId: string; role: BoardRole }[];
  tokens: ApiToken[];
  /** Its latest runs, newest first. */
  runs: Run[];
  createdAt: string;
}

/** One working session of a principal (routes/runs.ts). */
export interface Run {
  id: string;
  /** "8f31". */
  short: string;
  /** The program doing the work, as people say it ("Codex"), when known. */
  client: string | null;
  /** stale: still running on paper, but not heard from for longer than the lease. */
  status: RunStatus;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  /** Keys of the tasks it holds a live claim on. */
  claims: string[];
}

/** POST /api/runs answers with the run's secret once; only its hash is kept. */
export interface StartedRun {
  run: Run;
  secret: string;
}

/** POST /api/tokens answers with the secret once; only its hash is kept. */
export interface CreatedToken {
  token: ApiToken;
  secret: string;
}

/** Set on a Viewer whose request came with a token instead of a session. */
export interface ApiAccess {
  tokenId: string;
  kind: "personal" | "oauth";
  scope: ApiTokenScope;
  /** What the history calls it: "Claude", "Claude Code", or the token's name. */
  via: string;
  /** Set when the secret was a run's (routes/runs.ts); the token above is the one that started it. */
  runId?: string;
}

/* ----------------------------------------------------------- attachments -- */

export interface Attachment {
  id: string;
  name: string;
  /** MIME type; empty for links. */
  type: string;
  size: number;
  kind: "image" | "file" | "link";
  /** R2 key, for images and files. */
  key: string | null;
  /** The address, for links. */
  url: string | null;
  createdAt: string;
}

/** POST /api/uploads answers with this; the task then references the key. */
export interface UploadedFile {
  key: string;
  name: string;
  type: string;
  size: number;
  kind: "image" | "file";
}

/* ---------------------------------------------------------------- inbox -- */

/** Something that needs this principal's attention (GET /api/inbox). */
export interface InboxItem {
  id: string;
  kind: "assigned" | "mentioned" | "commented";
  task: { id: string; key: string; title: string; boardId: string; boardName: string };
  actor: { handle: string; avatar: string | null };
  /** What the actor came through, when it was not the web app ("Claude Code"). */
  via: string | null;
  /** For a mention or a new comment: the comment's text as it is now. */
  comment: string | null;
  createdAt: string;
  readAt: string | null;
}

/** GET /api/inbox: one page, newest first (by created time, then id). */
export interface Inbox {
  /** Every unread item, not just this page's. */
  unread: number;
  items: InboxItem[];
  /** Opaque cursor for the next page (?cursor=), null on the last one. */
  next: string | null;
}
