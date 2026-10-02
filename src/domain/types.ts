/* ============================================================================
   Shapes shared by the browser and the Worker: what the API sends and takes.
   No runtime code here beyond constants; see the neighbouring modules for
   rules.
   ========================================================================== */

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
  attachments: Attachment[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

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
  agent: string | null;
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
  createdAt: string;
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
