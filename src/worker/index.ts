/* ============================================================================
   Worker entry. Routing only; no business logic lives here.
   ----------------------------------------------------------------------------
     /auth/*    sign-in: Google redirect, invite links, callback, logout
     /api/*     resolve the viewer (API token, session cookie, or
                DEV_USER_EMAIL on localhost) → route → JSON. A successful write then tells the
                affected users' open tabs what changed (live.ts).
     /api/live  a tab's WebSocket for those messages
     /mcp, /oauth/*, /.well-known/oauth-*
                AI assistants: the MCP server and its OAuth (integrations.ts).
                /api also takes the same tokens as a Bearer header.
     anything   the built SPA from the ASSETS binding

   Identity is resolved once, before any route runs, so no route can forget
   to authenticate. Authorization is the route's job: requireBoard and
   requireAdmin in access.ts. The route table is the whole API.

   The viewer may be an agent (docs/AGENT-IDENTITIES.md). Board routes need
   nothing extra, requireBoard caps it. Personal routes are wrapped in
   mine(grant) below, which decides whether an agent gets its owner's data;
   a new personal route gets that wrapper too.
   ========================================================================== */

import { TAB_HEADER } from "@/domain/live";
import type { AgentGrant, Viewer } from "@/domain/types";
import { personalViewer } from "./access";
import { finishLogin, logout, startCalendarConnect, startLogin } from "./auth";
import type { Env } from "./env";
import { errorResponse, HttpError, notFound } from "./http";
import { Changes, connectLive } from "./live";
import { Router, type Params } from "./router";
import { deleteInvite, getInvites, getUsers, patchUser, postInvite } from "./routes/admin";
import {
  deleteBoard,
  deleteMember,
  getBoard,
  getBoards,
  patchBoard,
  patchMember,
  postBoard,
  postMember,
} from "./routes/boards";
import {
  deleteAccount,
  deleteCalendar,
  getCalendarSetup,
  getEvents,
  patchCalendar,
  postAccountSync,
  postEvent,
  postIcsFeed,
  putEvent,
  removeEvent,
} from "./routes/calendar";
import { deleteTaskAttachment, getAttachment, postTaskAttachment, postUpload } from "./routes/attachments";
import { deleteComment, getComments, getTaskEvents, patchComment, postComment } from "./routes/comments";
import { deleteLabel, deleteStage, patchLabel, patchStage, postLabel, postStage, putStageOrder } from "./routes/stages";
import { deleteTask, getTask, patchTask, postTask } from "./routes/tasks";
import { deleteToken, getTokens, postToken } from "./routes/tokens";
import { handleIntegration, isIntegrationPath } from "./integrations";
import { bearerFrom, requireWriteScope, touchStatement, viaContext } from "./tokens";
import { getMarketExtras } from "./routes/markets";
import { deleteNote, getNotes, patchNote, postNote } from "./routes/notes";
import { deleteAvatar, getAvatar, patchMe, putAvatar } from "./routes/profile";
import {
  deleteAgent,
  deleteAgentAvatar,
  deleteAgentBoard,
  getAgents,
  patchAgent,
  postAgent,
  putAgentAvatar,
  putAgentBoard,
} from "./routes/agents";
import { deleteVault, getMe, getSettings, getVault, patchSettings, putVault } from "./routes/personal";
import { resolveViewer } from "./viewer";

/* The Durable Object class must be exported from the entry module. */
export { LiveHub } from "./live";

interface Ctx {
  request: Request;
  env: Env;
  viewer: Viewer;
  url: URL;
  changes: Changes;
}

/**
 * A personal route: a person reaches their own data, an agent its owner's
 * and only with `grant` (null: never). The handler runs as the owner, so it
 * needs no idea agents exist. See personalViewer in access.ts.
 */
function mine(grant: AgentGrant | null, handler: (ctx: Ctx, params: Params) => Promise<Response>) {
  return (ctx: Ctx, params: Params) => handler({ ...ctx, viewer: personalViewer(ctx.viewer, grant) }, params);
}

const api = new Router<Ctx>()
  /* An agent's own: who it is and whom it acts for. */
  .on("GET", "/api/me", ({ env, viewer }) => getMe(env, viewer))
  .on("PATCH", "/api/me", mine(null, ({ request, env, viewer, changes }) => patchMe(request, env, viewer, changes)))
  .on("PUT", "/api/me/avatar", mine(null, ({ request, env, viewer, changes }) => putAvatar(request, env, viewer, changes)))
  .on("DELETE", "/api/me/avatar", mine(null, ({ env, viewer, changes }) => deleteAvatar(env, viewer, changes)))
  /* Keys are "avatars/<uuid>", pinned here like attachments below. */
  .on("GET", "/api/avatars/:id", ({ env, viewer }, { id }) => getAvatar(env, viewer, `avatars/${id}`))
  .on("GET", "/api/live", mine(null, ({ request, env, url, viewer }) => connectLive(request, env, url, viewer.user.id)))

  .on("GET", "/api/settings", mine(null, ({ env, viewer }) => getSettings(env, viewer)))
  .on("PATCH", "/api/settings", mine(null, ({ request, env, viewer, changes }) => patchSettings(request, env, viewer, changes)))
  .on("GET", "/api/vault", mine(null, ({ env, viewer }) => getVault(env, viewer)))
  .on(
    "PUT",
    "/api/vault/:name",
    mine(null, ({ request, env, viewer, changes }, { name }) => putVault(request, env, viewer, name, changes)),
  )
  .on("DELETE", "/api/vault/:name", mine(null, ({ env, viewer, changes }, { name }) => deleteVault(env, viewer, name, changes)))
  .on("GET", "/api/tokens", mine(null, ({ env, viewer }) => getTokens(env, viewer)))
  .on("POST", "/api/tokens", mine(null, ({ request, env, viewer, changes }) => postToken(request, env, viewer, changes)))
  .on("DELETE", "/api/tokens/:id", mine(null, ({ env, viewer, changes }, { id }) => deleteToken(env, viewer, id, changes)))
  .on("GET", "/api/agents", mine(null, ({ env, viewer }) => getAgents(env, viewer)))
  .on("POST", "/api/agents", mine(null, ({ request, env, viewer, changes }) => postAgent(request, env, viewer, changes)))
  .on("PATCH", "/api/agents/:id", mine(null, ({ request, env, viewer, changes }, { id }) => patchAgent(request, env, viewer, id, changes)))
  .on("DELETE", "/api/agents/:id", mine(null, ({ env, viewer, changes }, { id }) => deleteAgent(env, viewer, id, changes)))
  .on(
    "PUT",
    "/api/agents/:id/avatar",
    mine(null, ({ request, env, viewer, changes }, { id }) => putAgentAvatar(request, env, viewer, id, changes)),
  )
  .on("DELETE", "/api/agents/:id/avatar", mine(null, ({ env, viewer, changes }, { id }) => deleteAgentAvatar(env, viewer, id, changes)))
  .on(
    "PUT",
    "/api/agents/:id/boards/:boardId",
    mine(null, ({ request, env, viewer, changes }, p) => putAgentBoard(request, env, viewer, p.id, p.boardId, changes)),
  )
  .on(
    "DELETE",
    "/api/agents/:id/boards/:boardId",
    mine(null, ({ env, viewer, changes }, p) => deleteAgentBoard(env, viewer, p.id, p.boardId, changes)),
  )

  .on("GET", "/api/notes", mine("notes:read", ({ env, viewer }) => getNotes(env, viewer)))
  .on("POST", "/api/notes", mine("notes:write", ({ request, env, viewer, changes }) => postNote(request, env, viewer, changes)))
  .on(
    "PATCH",
    "/api/notes/:id",
    mine("notes:write", ({ request, env, viewer, changes }, { id }) => patchNote(request, env, viewer, id, changes)),
  )
  .on("DELETE", "/api/notes/:id", mine("notes:write", ({ env, viewer, changes }, { id }) => deleteNote(env, viewer, id, changes)))
  .on("GET", "/api/markets/coingecko", mine(null, ({ env, viewer }) => getMarketExtras(env, viewer)))

  .on("GET", "/api/calendar", mine("calendar:read", ({ env, viewer }) => getCalendarSetup(env, viewer)))
  .on(
    "POST",
    "/api/calendar/accounts/:id/sync",
    mine(null, ({ env, viewer, changes }, { id }) => postAccountSync(env, viewer, id, changes)),
  )
  .on(
    "DELETE",
    "/api/calendar/accounts/:id",
    mine(null, ({ env, viewer, changes }, { id }) => deleteAccount(env, viewer, id, changes)),
  )
  .on("POST", "/api/calendar/ics", mine(null, ({ request, env, viewer, changes }) => postIcsFeed(request, env, viewer, changes)))
  .on(
    "PATCH",
    "/api/calendar/calendars/:id",
    mine(null, ({ request, env, viewer, changes }, { id }) => patchCalendar(request, env, viewer, id, changes)),
  )
  .on(
    "DELETE",
    "/api/calendar/calendars/:id",
    mine(null, ({ env, viewer, changes }, { id }) => deleteCalendar(env, viewer, id, changes)),
  )
  .on("GET", "/api/calendar/events", mine("calendar:read", ({ env, viewer, url }) => getEvents(env, viewer, url)))
  .on("POST", "/api/calendar/events", mine(null, ({ request, env, viewer, changes }) => postEvent(request, env, viewer, changes)))
  .on(
    "PUT",
    "/api/calendar/events/:calendarId/:eventId",
    mine(null, ({ request, env, viewer, changes }, p) => putEvent(request, env, viewer, p.calendarId, p.eventId, changes)),
  )
  .on(
    "DELETE",
    "/api/calendar/events/:calendarId/:eventId",
    mine(null, ({ env, viewer, changes }, p) => removeEvent(env, viewer, p.calendarId, p.eventId, changes)),
  )

  .on("GET", "/api/boards", ({ env, viewer }) => getBoards(env, viewer))
  .on("POST", "/api/boards", ({ request, env, viewer, changes }) => postBoard(request, env, viewer, changes))
  .on("GET", "/api/boards/:id", ({ env, viewer }, { id }) => getBoard(env, viewer, id))
  .on("PATCH", "/api/boards/:id", ({ request, env, viewer, changes }, { id }) =>
    patchBoard(request, env, viewer, id, changes),
  )
  .on("DELETE", "/api/boards/:id", ({ env, viewer, changes }, { id }) => deleteBoard(env, viewer, id, changes))
  .on("POST", "/api/boards/:id/members", ({ request, env, viewer, url, changes }, { id }) =>
    postMember(request, env, viewer, id, url, changes),
  )
  .on("PATCH", "/api/boards/:id/members/:userId", ({ request, env, viewer, changes }, p) =>
    patchMember(request, env, viewer, p.id, p.userId, changes),
  )
  .on("DELETE", "/api/boards/:id/members/:userId", ({ env, viewer, changes }, p) =>
    deleteMember(env, viewer, p.id, p.userId, changes),
  )

  .on("POST", "/api/boards/:id/tasks", ({ request, env, viewer, changes }, { id }) =>
    postTask(request, env, viewer, id, changes),
  )
  .on("GET", "/api/tasks/:id", ({ env, viewer }, { id }) => getTask(env, viewer, id))
  .on("PATCH", "/api/tasks/:id", ({ request, env, viewer, changes }, { id }) =>
    patchTask(request, env, viewer, id, changes),
  )
  .on("DELETE", "/api/tasks/:id", ({ env, viewer, changes }, { id }) => deleteTask(env, viewer, id, changes))
  .on("POST", "/api/uploads", ({ request, env, viewer }) => postUpload(request, env, viewer))
  /* Keys are "attachments/<uuid>": the prefix is part of the key and the route
     pins it, so only that R2 namespace is reachable here. */
  .on("GET", "/api/attachments/attachments/:id", ({ env, viewer, url }, { id }) =>
    getAttachment(env, viewer, `attachments/${id}`, url.searchParams.get("download") === "1"),
  )
  .on("POST", "/api/tasks/:id/attachments", ({ request, env, viewer, changes }, { id }) =>
    postTaskAttachment(request, env, viewer, id, changes),
  )
  .on("DELETE", "/api/tasks/:id/attachments/:attachmentId", ({ env, viewer, changes }, p) =>
    deleteTaskAttachment(env, viewer, p.id, p.attachmentId, changes),
  )
  .on("GET", "/api/tasks/:id/comments", ({ env, viewer }, { id }) => getComments(env, viewer, id))
  .on("POST", "/api/tasks/:id/comments", ({ request, env, viewer, changes }, { id }) =>
    postComment(request, env, viewer, id, changes),
  )
  .on("PATCH", "/api/comments/:id", ({ request, env, viewer, changes }, { id }) =>
    patchComment(request, env, viewer, id, changes),
  )
  .on("DELETE", "/api/comments/:id", ({ env, viewer, changes }, { id }) => deleteComment(env, viewer, id, changes))
  .on("GET", "/api/tasks/:id/events", ({ env, viewer }, { id }) => getTaskEvents(env, viewer, id))

  .on("POST", "/api/boards/:id/stages", ({ request, env, viewer, changes }, { id }) =>
    postStage(request, env, viewer, id, changes),
  )
  .on("PUT", "/api/boards/:id/stages/order", ({ request, env, viewer, changes }, { id }) =>
    putStageOrder(request, env, viewer, id, changes),
  )
  .on("PATCH", "/api/stages/:id", ({ request, env, viewer, changes }, { id }) =>
    patchStage(request, env, viewer, id, changes),
  )
  .on("DELETE", "/api/stages/:id", ({ env, viewer, url, changes }, { id }) => deleteStage(env, viewer, id, url, changes))
  .on("POST", "/api/boards/:id/labels", ({ request, env, viewer, changes }, { id }) =>
    postLabel(request, env, viewer, id, changes),
  )
  .on("PATCH", "/api/labels/:id", ({ request, env, viewer, changes }, { id }) =>
    patchLabel(request, env, viewer, id, changes),
  )
  .on("DELETE", "/api/labels/:id", ({ env, viewer, changes }, { id }) => deleteLabel(env, viewer, id, changes))

  .on("GET", "/api/admin/users", ({ env, viewer }) => getUsers(env, viewer))
  .on("PATCH", "/api/admin/users/:id", ({ request, env, viewer, changes }, { id }) =>
    patchUser(request, env, viewer, id, changes),
  )
  .on("GET", "/api/admin/invites", ({ env, viewer }) => getInvites(env, viewer))
  .on("POST", "/api/admin/invites", ({ request, env, viewer, url, changes }) =>
    postInvite(request, env, viewer, url, changes),
  )
  .on("DELETE", "/api/admin/invites/:id", ({ env, viewer, changes }, { id }) =>
    deleteInvite(env, viewer, id, changes),
  );

/**
 * The session rides in a cookie, so a page on another site could make the
 * browser send it. SameSite=Lax already withholds it from cross-site POSTs;
 * this is the second lock: a mutation whose Origin is not ours is refused.
 */
function requireSameOrigin(request: Request, url: URL): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  /* A token is not sent by the browser on its own, so it cannot be forged
     from another site; a tool calling from a browser tab has its own Origin. */
  if (bearerFrom(request)) return;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) throw new HttpError(403, "Cross-origin request refused");
}

/** The Worker's own responses get the same baseline headers as the pages. */
function withSecurityHeaders(response: Response): Response {
  /* A WebSocket handshake cannot be copied and has no body to protect. */
  if (response.status === 101) return response;
  const out = new Response(response.body, response);
  out.headers.set("x-content-type-options", "nosniff");
  /* Attachments set SAMEORIGIN so the task modal can preview a PDF. */
  if (!out.headers.has("x-frame-options")) out.headers.set("x-frame-options", "DENY");
  out.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  if (!out.headers.has("content-security-policy")) {
    out.headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  }
  return out;
}

const INVITE_PATH = /^\/auth\/invite\/([A-Za-z0-9_-]{20,})$/;

async function handleAuth(request: Request, env: Env, url: URL): Promise<Response> {
  requireSameOrigin(request, url);
  if (request.method === "GET" && url.pathname === "/auth/google") return startLogin(request, env, null);
  const invite = request.method === "GET" ? INVITE_PATH.exec(url.pathname) : null;
  if (invite) return startLogin(request, env, invite[1]);
  if (request.method === "GET" && url.pathname === "/auth/calendar") return startCalendarConnect(request, env);
  if (request.method === "GET" && url.pathname === "/auth/callback") return finishLogin(request, env);
  if (request.method === "POST" && url.pathname === "/auth/logout") return logout(request, env);
  throw notFound(`No route for ${request.method} ${url.pathname}`);
}

/**
 * One API request as a viewer: the route, then live updates if it worked.
 * /api requests and the MCP tools' in-process calls both come through here,
 * so a read-only token is refused the same way on either path.
 */
async function runApi(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  url: URL,
  viewer: Viewer,
  tab: string | null,
): Promise<Response> {
  requireWriteScope(viewer, request.method);
  const changes = new Changes();
  const pending = api.dispatch(request.method, url.pathname, { request, env, viewer, url, changes });
  if (!pending) throw notFound(`No route for ${request.method} ${url.pathname}`);
  const response = await pending;
  if (response.ok) changes.publish(env, ctx, tab);
  return response;
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  requireSameOrigin(request, url);
  const viewer = await resolveViewer(request, env);
  const run = () => runApi(env, ctx, request, url, viewer, request.headers.get(TAB_HEADER));
  if (!viewer.access) return run();
  ctx.waitUntil(touchStatement(env.DB, viewer.access.tokenId).run());
  return viaContext.run({ via: viewer.access.via }, run);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isIntegrationPath(url.pathname)) {
      return withSecurityHeaders(
        await handleIntegration(request, env, ctx, url, (req, target, viewer, tab) =>
          runApi(env, ctx, req, target, viewer, tab),
        ),
      );
    }
    const isAuth = url.pathname.startsWith("/auth/");
    if (!isAuth && !url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return withSecurityHeaders(
        isAuth ? await handleAuth(request, env, url) : await handleApi(request, env, ctx, url),
      );
    } catch (error) {
      return withSecurityHeaders(errorResponse(error));
    }
  },
} satisfies ExportedHandler<Env>;
