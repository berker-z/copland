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
   ========================================================================== */

import { DurableObject } from "cloudflare:workers";
import type { LiveEvent, LiveTopic } from "@/domain/live";
import type { Env } from "./env";
import { forbidden } from "./http";

const PING = "ping";
const PONG = "pong";

export class LiveHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** The upgrade, already authenticated by the Worker (connectLive). */
  override async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Called over RPC after a write; sends to every open socket. */
  async broadcast(event: LiveEvent): Promise<void> {
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
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
 * GET /api/live: hand a signed-in tab's WebSocket to its user's hub. A
 * WebSocket is not bound by CORS, so the Origin check is what keeps another
 * site from opening one with someone's cookie.
 */
export async function connectLive(request: Request, env: Env, url: URL, userId: string): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  if (request.headers.get("origin") !== url.origin) throw forbidden("Cross-origin WebSocket refused");
  return hub(env, userId).fetch(request);
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
