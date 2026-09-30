/* ============================================================================
   HTTP helpers. Uniform JSON shapes so the client has one error contract.
   ========================================================================== */

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      /* Responses are per-identity; never let a shared cache hold one. */
      "cache-control": "no-store",
      ...init.headers,
    },
  });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** No session, or one that has ended. The client sends the person to sign in. */
export class UnauthenticatedError extends Error {
  constructor(message = "Not signed in") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const forbidden = (m: string) => new HttpError(403, m);
export const notFound = (m = "Not found") => new HttpError(404, m);
/** The row changed under the caller; refetch and try again. */
export const conflict = (m: string) => new HttpError(409, m);

/**
 * A request body that is a JSON object, or a 400. `null`, a bare string or
 * an array parse fine as JSON and would then crash the first `body.x` with a
 * TypeError, a 500 for what is the caller's mistake. Every value is still
 * `unknown` until the route checks it.
 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest("Body must be JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Single place where an exception becomes a status code. */
export function errorResponse(error: unknown): Response {
  if (error instanceof UnauthenticatedError) {
    return json({ error: "unauthenticated", message: error.message }, { status: 401 });
  }
  if (error instanceof HttpError) {
    return json({ error: "request_failed", message: error.message }, { status: error.status });
  }
  console.error("Unhandled worker error:", error);
  return json({ error: "internal", message: "Something went wrong" }, { status: 500 });
}

/* ------------------------------------------------------------ crypto --- */

export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

export async function sha256Hex(input: string): Promise<string> {
  return [...(await sha256(input))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64url(input: string): Promise<string> {
  return base64url(await sha256(input));
}

export function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  return fromBase64(text.replace(/-/g, "+").replace(/_/g, "/"));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export const nowIso = () => new Date().toISOString();
