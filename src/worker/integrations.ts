/* ============================================================================
   AI assistants: the MCP endpoint and the OAuth around it.
   ----------------------------------------------------------------------------
     /mcp                          the MCP server (mcp.ts). Tokens only: a
                                   browser's cookie never reaches the tools,
                                   so no other site can drive them through
                                   someone's open session.
     /oauth/*                      register, authorize (consent), token
     /.well-known/oauth-*          where a client learns all of the above

   The tools reach the app through runApi, the same function /api requests
   go through (index.ts), so access checks, validation, the event log and
   live updates are the routes', once. What made a change rides along in
   viaContext for the history.
   ========================================================================== */

import type { Viewer } from "@/domain/types";
import type { Env } from "./env";
import { errorResponse, HttpError, notFound, UnauthenticatedError } from "./http";
import { Changes } from "./live";
import { handleMcp, type ApiCall } from "./mcp";
import {
  authorizationServerMetadata,
  authorize,
  CORS_HEADERS,
  protectedResourceMetadata,
  register,
  token,
} from "./oauth";
import { bearerFrom, setAgent, touchStatement, viaContext } from "./tokens";
import { resolveViewer } from "./viewer";

/** One API request as a viewer: scope check, route, live updates on success (index.ts). */
export type RunApi = (request: Request, url: URL, viewer: Viewer, tab: string | null) => Promise<Response>;

export function isIntegrationPath(path: string): boolean {
  return (
    path === "/mcp" ||
    path.startsWith("/oauth/") ||
    path.startsWith("/.well-known/oauth-") ||
    path === "/.well-known/openid-configuration"
  );
}

/**
 * The app's own API, called in-process as this viewer. What the MCP tools
 * use, so every rule the routes enforce holds for them too, and a tool's
 * write reaches people's open tabs like anyone's.
 */
function apiCaller(viewer: Viewer, url: URL, runApi: RunApi): ApiCall {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const target = new URL(path, url.origin);
    const request = new Request(target, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let response: Response;
    try {
      response = await runApi(request, target, viewer, null);
    } catch (error) {
      response = errorResponse(error);
    }
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    if (!response.ok) throw new Error(data?.message ?? `Request failed (${response.status})`);
    return data as T;
  };
}

/** The 401 an MCP client reads to find the OAuth server (RFC 9728). */
function mcpUnauthorized(url: URL, invalid: boolean): Response {
  const metadata = `${url.origin}/.well-known/oauth-protected-resource/mcp`;
  return new Response(
    JSON.stringify({ error: "unauthenticated", message: "Connect with OAuth, or send a personal token as a Bearer header" }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${metadata}"${invalid ? ', error="invalid_token"' : ""}`,
        ...CORS_HEADERS,
      },
    },
  );
}

export async function handleIntegration(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  runApi: RunApi,
): Promise<Response> {
  const path = url.pathname;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  try {
    if (path.startsWith("/.well-known/oauth-protected-resource")) return protectedResourceMetadata(url.origin);
    if (path.startsWith("/.well-known/oauth-authorization-server") || path === "/.well-known/openid-configuration") {
      return authorizationServerMetadata(url.origin);
    }
    if (path === "/oauth/register" && request.method === "POST") return await register(request, env);
    if (path === "/oauth/token" && request.method === "POST") {
      const { response, userId } = await token(request, env);
      /* A new connection shows up in the person's open settings. */
      if (userId) {
        const changes = new Changes();
        changes.notify([userId], "tokens");
        changes.publish(env, ctx, null);
      }
      return response;
    }
    if (path === "/oauth/authorize" && (request.method === "GET" || request.method === "POST")) {
      /* The consent form is a cookie-authenticated POST: same-origin only,
         the same lock index.ts puts on /api and /auth. */
      const origin = request.headers.get("origin");
      if (request.method === "POST" && origin !== null && origin !== url.origin) {
        throw new HttpError(403, "Cross-origin request refused");
      }
      return await authorize(request, env, url);
    }
    if (path === "/mcp") {
      if (!bearerFrom(request)) return mcpUnauthorized(url, false);
      let viewer: Viewer;
      try {
        viewer = await resolveViewer(request, env);
      } catch (error) {
        if (error instanceof UnauthenticatedError) return mcpUnauthorized(url, true);
        throw error;
      }
      const access = viewer.access;
      if (!access) return mcpUnauthorized(url, true);
      ctx.waitUntil(touchStatement(env.DB, access.tokenId).run());
      return await viaContext.run({ via: access.via }, () =>
        handleMcp(
          request,
          viewer,
          apiCaller(viewer, url, runApi),
          (name) => setAgent(env.DB, access.tokenId, name),
          url.origin,
        ),
      );
    }
    throw notFound(`No route for ${request.method} ${path}`);
  } catch (error) {
    return errorResponse(error);
  }
}
