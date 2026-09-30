/* ============================================================================
   Worker entry. Routing only; no business logic lives here.
   ----------------------------------------------------------------------------
     /auth/*    sign-in: Google redirect, invite links, callback, logout
     /api/*     resolve the viewer (session cookie, or DEV_USER_EMAIL on
                localhost) → route → JSON. A successful write then tells the
                affected users' open tabs what changed (live.ts).
     /api/live  a tab's WebSocket for those messages
     anything   the built SPA from the ASSETS binding

   Identity is resolved once, before any route runs, so no route can forget
   to authenticate. Authorization is the route's job: requireBoard and
   requireAdmin in access.ts. The route table is the whole API.
   ========================================================================== */

import { TAB_HEADER } from "@/domain/live";
import type { Viewer } from "@/domain/types";
import { finishLogin, logout, startLogin } from "./auth";
import type { Env } from "./env";
import { errorResponse, HttpError, notFound } from "./http";
import { Changes, connectLive } from "./live";
import { Router } from "./router";
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
import { deleteComment, getComments, getTaskEvents, patchComment, postComment } from "./routes/comments";
import { deleteLabel, deleteStage, patchLabel, patchStage, postLabel, postStage, putStageOrder } from "./routes/stages";
import { deleteTask, patchTask, postTask } from "./routes/tasks";
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

const api = new Router<Ctx>()
  .on("GET", "/api/me", ({ env, viewer }) => getMe(env, viewer))
  .on("GET", "/api/live", ({ request, env, url, viewer }) => connectLive(request, env, url, viewer.user.id))

  .on("GET", "/api/settings", ({ env, viewer }) => getSettings(env, viewer))
  .on("PATCH", "/api/settings", ({ request, env, viewer, changes }) => patchSettings(request, env, viewer, changes))
  .on("GET", "/api/vault", ({ env, viewer }) => getVault(env, viewer))
  .on("PUT", "/api/vault/:name", ({ request, env, viewer, changes }, { name }) =>
    putVault(request, env, viewer, name, changes),
  )
  .on("DELETE", "/api/vault/:name", ({ env, viewer, changes }, { name }) => deleteVault(env, viewer, name, changes))

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
  .on("PATCH", "/api/tasks/:id", ({ request, env, viewer, changes }, { id }) =>
    patchTask(request, env, viewer, id, changes),
  )
  .on("DELETE", "/api/tasks/:id", ({ env, viewer, changes }, { id }) => deleteTask(env, viewer, id, changes))
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
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) throw new HttpError(403, "Cross-origin request refused");
}

/** The Worker's own responses get the same baseline headers as the pages. */
function withSecurityHeaders(response: Response): Response {
  /* A WebSocket handshake cannot be copied and has no body to protect. */
  if (response.status === 101) return response;
  const out = new Response(response.body, response);
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("x-frame-options", "DENY");
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
  if (request.method === "GET" && url.pathname === "/auth/callback") return finishLogin(request, env);
  if (request.method === "POST" && url.pathname === "/auth/logout") return logout(request, env);
  throw notFound(`No route for ${request.method} ${url.pathname}`);
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  requireSameOrigin(request, url);
  const viewer = await resolveViewer(request, env);
  const changes = new Changes();
  const pending = api.dispatch(request.method, url.pathname, { request, env, viewer, url, changes });
  if (!pending) throw notFound(`No route for ${request.method} ${url.pathname}`);
  const response = await pending;
  if (response.ok) changes.publish(env, ctx, request.headers.get(TAB_HEADER));
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
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
