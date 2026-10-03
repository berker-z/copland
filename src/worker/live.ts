/* ============================================================================
   Live updates: one Durable Object per user, holding that user's open tabs.
   ----------------------------------------------------------------------------
   A route that changes something says who should hear about it and which
   topics changed (Changes, below). After the response succeeds, each of
   those users' hubs sends the topics to every tab it holds, and the tabs
   refetch. A personal write reaches its author's other tabs; a board write
   reaches every member of the board.

   Per user rather than one hub for the instance: nobody's socket carries
   anything about a board they are not on, and the fan-out is exactly the
   board's member list.

   The hibernation API keeps idle sockets free: the object is evicted between
   messages, the sockets stay open on Cloudflare's side, and keepalive pings
   are answered by the auto-response without waking it.

   Nothing is stored and nothing is replayed. A tab that reconnects refetches
   everything it shows, so a missed message costs a refetch, never a stale
   screen.

   The daemon and the box listen too (COPL-62), with a Bearer token in the
   upgrade's Authorization header, resolved like any other request. A socket
   lands in its principal's own hub: an agent's token hears what is sent to
   the agent (its inbox, its boards), never its owner's. Such a socket
   remembers its token, and every broadcast first checks the token is still
   good, so revoking it, pausing the agent or disabling the owner closes the
   socket at the next message instead of leaving it listening.
   ========================================================================== */

import { DurableObject } from "cloudflare:workers";
import type { LiveEvent, LiveTopic } from "@/domain/live";
import type { Viewer } from "@/domain/types";
import type { Env } from "./env";
import { forbidden } from "./http";
import { liveTokenIds } from "./tokens";

const PING = "ping";
const PONG = "pong";
/** Set by connectLive on the request it hands the hub; whatever a client sent under it is dropped. */
const TOKEN_HEADER = "x-copland-live-token";
/** The close code for a socket whose token stopped working; the client's next attempt gets a 401. */
const CREDENTIAL_GONE = 4001;

interface Attachment {
  /** The API token the socket was opened with; absent for a browser tab. */
  tokenId?: string;
}

export class LiveHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** The upgrade, already authenticated by the Worker (connectLive). */
  override async fetch(request: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const tokenId = request.headers.get(TOKEN_HEADER);
    server.serializeAttachment((tokenId ? { tokenId } : {}) satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Called over RPC after a write; sends to every open socket whose credential still works. */
  async broadcast(event: LiveEvent): Promise<void> {
    const message = JSON.stringify(event);
    const sockets = this.ctx.getWebSockets();
    const tokenOf = (socket: WebSocket) => (socket.deserializeAttachment() as Attachment | null)?.tokenId;
    const tokenIds = [...new Set(sockets.map(tokenOf).filter((id): id is string => !!id))];
    const live = tokenIds.length > 0 ? await liveTokenIds(this.env.DB, tokenIds) : new Set<string>();
    for (const socket of sockets) {
      const tokenId = tokenOf(socket);
      try {
        if (tokenId && !live.has(tokenId)) socket.close(CREDENTIAL_GONE, "token no longer valid");
        else socket.send(message);
      } catch {
        /* Closing under us; webSocketClose tidies up. */
      }
    }
  }

  /* Tabs only ever send the ping, which the auto-response takes. */
  override async webSocketMessage(): Promise<void> {}

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    /* 1005/1006 mean no code was given; close() refuses those. */
    socket.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
  }
}

function hub(env: Env, userId: string): DurableObjectStub<LiveHub> {
  return env.LIVE.get(env.LIVE.idFromName(userId));
}

/**
 * GET /api/live: hand a WebSocket to its principal's hub. A browser tab
 * comes with its session cookie, and a WebSocket is not bound by CORS, so
 * the Origin check is what keeps another site from opening one with that
 * cookie. A daemon comes with a Bearer token instead, which no web page can
 * put on a WebSocket, so it needs no Origin. A run's secret is refused: it
 * dies with its run, and a socket would outlive it.
 */
export async function connectLive(request: Request, env: Env, url: URL, viewer: Viewer): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const access = viewer.access;
  if (!access && request.headers.get("origin") !== url.origin) throw forbidden("Cross-origin WebSocket refused");
  if (access?.runId) throw forbidden("A run's secret cannot listen for live updates; use the agent's own token");
  const headers = new Headers(request.headers);
  headers.delete(TOKEN_HEADER);
  headers.delete("authorization");
  if (access) headers.set(TOKEN_HEADER, access.tokenId);
  return hub(env, viewer.user.id).fetch(new Request(request, { headers }));
}

/**
 * What a request changed, collected by its route and sent once the response
 * is known to be a success. A failed write sends nothing, whatever the route
 * noted before it failed.
 */
export class Changes {
  private readonly byUser = new Map<string, Set<LiveTopic>>();

  /** These users should refetch these topics. */
  notify(userIds: Iterable<string>, ...topics: LiveTopic[]): void {
    for (const id of userIds) {
      let set = this.byUser.get(id);
      if (!set) this.byUser.set(id, (set = new Set()));
      for (const t of topics) set.add(t);
    }
  }

  /** Run under waitUntil so it never slows or fails the write. */
  publish(env: Env, ctx: ExecutionContext, tab: string | null): void {
    for (const [userId, topics] of this.byUser) {
      ctx.waitUntil(
        hub(env, userId)
          .broadcast({ topics: [...topics], tab })
          .catch((error: unknown) => console.warn("live broadcast failed", error)),
      );
    }
  }
}
