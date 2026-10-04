/* ============================================================================
   Shapes shared by the browser and the Worker: what the API sends and takes.
   No runtime code here beyond constants; see the neighbouring modules for
   rules.
   ========================================================================== */

import type { CodeLink } from "./github";
import type { RunKind, RunStatus } from "./runs";

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
  /** When the request came with a token (or a run's secret) rather than a session: what it may do. */
  access?: MeAccess;
}

/** GET /api/me's `access`: the credential's reach, never the token itself. */
export interface MeAccess {
  kind: ApiAccess["kind"];
  /** "read" refuses every write. */
  scope: ApiTokenScope;
  /** What the history calls it ("Claude Code", or the token's name). */
  via: string;
  /** The run this is a run's secret for, or null for the token itself. */
  runId: string | null;
  /** For the token itself: its live interactive run (made by its first claim), or null. */
  interactiveRunId: string | null;
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

/** A board and the viewer's role on it: what an access check learns, no counts. */
export interface BoardAccess {
  id: string;
  key: string;
  name: string;
  isInbox: boolean;
  role: BoardRole;
}

/** GET /api/boards: a board in the list, with what the boards pane counts. */
export interface BoardSummary extends BoardAccess {
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
  /** Always set (COPL-85): a task unless said otherwise. */
  level: Level;
  assigneeIds: string[];
  labelIds: string[];
  dependsOn: string[];
  commentCount: number;
  attachments: Attachment[];
  /** A run working on it right now (routes/runs.ts), or null. Only live claims are sent. */
  claim: TaskClaim | null;
  /** An agent working it opens the PR and leaves the merge to a person (COPL-77); off, it merges itself once CI is green. */
  reviewFirst: boolean;
  /** Branches and PRs naming it, from a connected repo's webhook (domain/github.ts); open ones first. */
  code: CodeLink[];
  /**
   * Other open tasks on its board whose latest changed files (the daemon's
   * reports) share some with its own, most shared first, and how many files
   * (domain/overlap.ts, COPL-104). Open tasks only, and only on a board's
   * task list: a single task read leaves it empty.
   */
  overlap: TaskOverlap[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Another open task a task shares changed files with: its key and how many files. */
export interface TaskOverlap {
  key: string;
  files: number;
}

/** A run's live hold on a task (or a message, InboxMessage.claim): whose run, which run, and until when unless renewed. */
export interface TaskClaim {
  userId: string;
  runId: string;
  /** "8f31": how the run is named to people. */
  run: string;
  /** supervised: a launcher's (the daemon's) run; interactive: a chat session's. */
  kind: RunKind;
  /** The program, as people say it ("Claude Code"), when known. */
  client: string | null;
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
/** GET /api/tasks/ready: one task the caller can start now (routes/work.ts getReady). */
export interface ReadyTask {
  id: string;
  key: string;
  boardId: string;
  updatedAt: string;
}

export interface MyWork {
  mine: { taskId: string; boardId: string }[];
  /** Always empty for an agent. */
  delegated: { taskId: string; boardId: string }[];
}

/** One task on the /wired pane's wires (routes/wired.ts). */
export interface WiredTask {
  id: string;
  boardId: string;
  key: string;
  title: string;
  /** The agent it is on: the claimer when a run holds it, else the first of the owner's agents assigned. */
  agentId: string;
  /**
   * doing: when the live claim was taken (null when no run holds it).
   * done: when it was completed. Otherwise when the task last changed.
   */
  since: string | null;
  /** doing only: a run of the agent holds a live claim on it right now. */
  live: boolean;
}

/** GET /api/wired: what the signed-in person's agents have on, by pole (routes/wired.ts). */
export interface Wired {
  agents: { id: string; handle: string; name: string; paused: boolean }[];
  todo: WiredTask[];
  /** Live claims first (oldest claim first), then active tasks no run holds. */
  doing: WiredTask[];
  blocked: WiredTask[];
  /** Done within the window, newest first, at most DONE_LIMIT of them. */
  done: WiredTask[];
  /** How many were done within the window, all of them. */
  doneCount: number;
  doneWindowHours: number;
}

/** GET /api/boards/:id — everything a board screen draws. */
export interface BoardDetail {
  board: BoardAccess;
  members: BoardMember[];
  stages: Stage[];
  labels: Label[];
  tasks: Task[];
  /** The board's rules for working on it: markdown, '' when there are none. */
  notes: string;
  /** Its docs, metadata only; the bytes are fetched one at a time. */
  docs: BoardDoc[];
  /** GitHub repos connected to it (domain/github.ts). */
  repos: BoardRepo[];
}

/**
 * A board's code. A GitHub repo is connected by an instance admin, and the
 * instance's GitHub App delivers its events; a plain git remote (COPL-95) by
 * the board's owner, with no App, webhooks or PRs.
 */
export interface BoardRepo {
  id: string;
  kind: "github" | "git";
  /** The name shown: "owner/name" on GitHub, the remote without scheme and ".git" otherwise. */
  repo: string;
  /** What the daemons clone. */
  remote: string;
  /** Handle of the owner who connected it: the webhook acts as them. */
  connectedBy: string | null;
  createdAt: string;
  /** When GitHub last delivered anything, and which event; null until the first. */
  lastDeliveryAt: string | null;
  lastEvent: string | null;
}

/** The instance's GitHub App (worker/githubApp.ts), as GET /api/admin/github and board settings see it. */
export interface GithubApp {
  slug: string;
  /** Its page on GitHub, where its settings are. */
  htmlUrl: string;
  /** The account that owns it. */
  owner: string;
  /** Where to install it on more repos, or change which ones. */
  installUrl: string;
  createdAt: string;
}

/** GET /api/boards/:id/repos/available: what an admin can connect; repos is empty without an App. */
export interface RepoChoices {
  app: GithubApp | null;
  /** "owner/name", the App's installed repos not on this board yet. */
  repos: string[];
}

/** POST /api/admin/github/manifest: the form the browser posts to GitHub to make the App. */
export interface AppManifestForm {
  action: string;
  manifest: string;
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
  /** Its images, oldest first (COPL-117). Never in the task's own attachments. */
  attachments: CommentAttachment[];
  createdAt: string;
  editedAt: string | null;
}

/** An image on a comment; url is the authenticated /api/attachments/<key>. */
export interface CommentAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  url: string;
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
  /** supervised: started by a launcher with POST /api/runs; interactive: a chat session's, made by its first claim. */
  kind: RunKind;
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
  /**
   * Set when the secret was the token itself and it has a live interactive
   * run (a chat session that claimed a task without a run's secret): the
   * request renews it and its claims, and its events carry it.
   */
  interactiveRunId?: string;
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
  kind: "assigned" | "mentioned" | "commented" | "message";
  /** Null only for a message that points at no task. */
  task: { id: string; key: string; title: string; boardId: string; boardName: string } | null;
  actor: { id: string; handle: string; avatar: string | null };
  /** What the actor came through, when it was not the web app ("Claude Code"). */
  via: string | null;
  /** For a mention or a new comment: the comment's text as it is now. */
  comment: string | null;
  /** For a message: what it says, and whether it is trusted (domain/messages.ts). */
  message: InboxMessage | null;
  createdAt: string;
  readAt: string | null;
}

export interface InboxMessage {
  /** What a reply names (POST /api/messages replyTo). */
  id: string;
  text: string;
  /** From the recipient's owner, or to a person from their own agent. Anyone else's is untrusted, like a comment. */
  trusted: boolean;
  /**
   * The run handling it right now (POST /api/messages/:id/claim), or null.
   * Only live claims are sent; only the recipient's runs ever hold one.
   */
  claim: TaskClaim | null;
}

/** POST /api/messages/:id/claim: the message and the claim this run now holds on it. */
export interface MessageClaimed {
  messageId: string;
  claim: TaskClaim;
}

/** POST /api/messages: the message as sent. */
export interface SentMessage {
  id: string;
  to: { id: string; handle: string };
  taskId: string | null;
  replyTo: string | null;
  trusted: boolean;
  createdAt: string;
}

/** GET /api/messages/recipients: an agent the viewer may message, for the nudge pane. */
export interface Recipient {
  user: User;
  /** The viewer's own agent; otherwise someone else's, open to its boards' members. */
  own: boolean;
  /**
   * Its daemon (or the box running it) is connected: a socket opened with
   * one of its tokens, heard from within the last 75 s. While it is not,
   * nothing reads a message sent to it.
   */
  connected: boolean;
}

/** GET /api/inbox: one page, newest first (by created time, then id). */
export interface Inbox {
  /** Every unread item, not just this page's. */
  unread: number;
  items: InboxItem[];
  /** Opaque cursor for the next page (?cursor=), null on the last one. */
  next: string | null;
}
