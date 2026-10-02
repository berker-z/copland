/* ============================================================================
   Users and sign-up.
   ----------------------------------------------------------------------------
   Google authenticates (auth.ts); this decides whether that person gets in.

     - An address with a user row signs in, unless the row is disabled or
       belongs to a different Google account.
     - A new address gets a row when one of these holds:
         there are no users yet (the first person in becomes the admin),
         SIGNUP is "open",
         it arrived through an unused, unexpired invite (locked to that
         address, if the invite names one).
       Otherwise it is refused, which on SIGNUP=closed means everyone after
       the first: a personal instance.

   Being an admin is the is_admin column and nothing else. Admins promote
   and demote each other in settings (routes/admin.ts), and `npm run admin`
   sets it from the command line for when nobody can.

   A new user gets their inbox board in the same batch, and joins the
   invite's board if it carries one.

   People go by a handle (domain/handle.ts), made from their Google name when
   the account is created and theirs to change after (routes/profile.ts).
   Google's name and photo are not kept; a picture is one they upload.
   ========================================================================== */

import { handleFrom, handleProblem, HANDLE_MAX } from "@/domain/handle";
import type { SignupMode, User } from "@/domain/types";
import type { Env } from "../env";
import { createBoardStatements, uniqueBoardKey } from "./boards";
import { nowIso } from "../http";

export interface UserRow {
  id: string;
  email: string;
  google_sub: string | null;
  handle: string;
  avatar_key: string | null;
  is_admin: number;
  disabled_at: string | null;
  kind: "person" | "agent";
  owner_id: string | null;
}

/** An agent's stand-in for the NOT NULL email (migrations/0007_agents.sql): never shown, never signed in with. */
export const agentEmail = (id: string) => `${id}@agent.invalid`;

/** Avatars live under this R2 prefix; the route that serves them pins it. */
export const AVATAR_PREFIX = "avatars/";

/** Where the browser fetches a picture. The key is new with every upload, so the URL can be cached for good. */
export function avatarUrl(key: string | null): string | null {
  return key ? `/api/${key}` : null;
}

export function rowToUser(row: UserRow): User {
  const agent = row.kind === "agent";
  return {
    id: row.id,
    kind: row.kind,
    email: agent ? null : row.email,
    handle: row.handle,
    avatar: avatarUrl(row.avatar_key),
    /* Being an admin is about the instance, which is for people. */
    isAdmin: !agent && row.is_admin === 1,
    ownerId: row.owner_id,
  };
}

export function signupMode(env: Env): SignupMode {
  return env.SIGNUP === "open" || env.SIGNUP === "closed" ? env.SIGNUP : "invite";
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare(`SELECT * FROM users WHERE id = ?1`).bind(id).first<UserRow>();
}

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  /* People only: an agent's stand-in address must never be typed into a board's member box and work. */
  return db
    .prepare(`SELECT * FROM users WHERE email = ?1 AND kind = 'person'`)
    .bind(email.toLowerCase())
    .first<UserRow>();
}

/* ---------------------------------------------------------------- sign-up -- */

/** What auth.ts takes from a verified Google ID token. */
export interface GoogleProfile {
  sub: string;
  /** Lowercased and verified by Google. */
  email: string;
  /** Only used to suggest a new account's handle; never stored. */
  name: string | null;
}

/** Why a sign-in was refused; auth.ts turns it into a reason on the login screen. */
export class SignInRefused extends Error {
  constructor(readonly reason: "disabled" | "mismatch" | "not_invited" | "invite_used" | "invite_email") {
    super(reason);
  }
}

interface InviteRow {
  id: string;
  email: string | null;
  board_id: string | null;
  expires_at: string;
  used_at: string | null;
}

/**
 * The user for this Google account, creating one if the rules above allow.
 * `inviteHash` is the hash of the invite code the browser arrived with, if
 * any; it only matters for an address without a row.
 */
export async function signIn(env: Env, profile: GoogleProfile, inviteHash: string | null): Promise<UserRow> {
  const db = env.DB;
  const existing = await findUserByEmail(db, profile.email);

  if (existing) {
    if (existing.disabled_at) throw new SignInRefused("disabled");
    if (existing.google_sub && existing.google_sub !== profile.sub) throw new SignInRefused("mismatch");
    /* Claim the row on first real sign-in. */
    if (!existing.google_sub) {
      await db.prepare(`UPDATE users SET google_sub = ?2 WHERE id = ?1`).bind(existing.id, profile.sub).run();
    }
    return { ...existing, google_sub: profile.sub };
  }

  const first = !(await db.prepare(`SELECT 1 FROM users LIMIT 1`).first());
  let invite: InviteRow | null = null;
  if (!first && signupMode(env) !== "open") {
    if (signupMode(env) === "closed" || !inviteHash) throw new SignInRefused("not_invited");
    invite = await db
      .prepare(`SELECT id, email, board_id, expires_at, used_at FROM invites WHERE code_hash = ?1`)
      .bind(inviteHash)
      .first<InviteRow>();
    if (!invite || invite.expires_at < nowIso()) throw new SignInRefused("not_invited");
    if (invite.used_at) throw new SignInRefused("invite_used");
    if (invite.email && invite.email !== profile.email) throw new SignInRefused("invite_email");
  }

  return createUser(env, {
    email: profile.email,
    googleSub: profile.sub,
    handleFrom: profile.name?.trim() || profile.email.split("@")[0],
    isAdmin: false,
    invite,
  });
}

/** A new user, their inbox, and whatever their invite brings, in one batch. */
export async function createUser(
  env: Env,
  input: {
    email: string;
    googleSub: string | null;
    /** What the handle is made from: their Google name, or the email's local part. */
    handleFrom: string;
    isAdmin: boolean;
    invite: InviteRow | null;
  },
): Promise<UserRow> {
  const db = env.DB;
  const id = crypto.randomUUID();
  const inboxId = crypto.randomUUID();
  const handle = await uniqueHandle(db, input.handleFrom, input.email);
  const key = await uniqueBoardKey(db, handle);
  const { invite } = input;

  await db.batch([
    db
      /* The first user is the admin, decided in the INSERT itself so two
         first sign-ins racing cannot both get it. */
      .prepare(
        `INSERT INTO users (id, email, google_sub, handle, is_admin)
         VALUES (?1, ?2, ?3, ?4, CASE WHEN EXISTS (SELECT 1 FROM users) THEN ?5 ELSE 1 END)`,
      )
      .bind(id, input.email, input.googleSub, handle, input.isAdmin ? 1 : 0),
    ...createBoardStatements(db, {
      id: inboxId,
      key,
      name: "inbox",
      ownerId: id,
      isInbox: true,
    }),
    ...(invite
      ? [
          /* used_at IS NULL in the WHERE: two sign-ins racing on one link,
             and only one of them marks it. The other still gets in; single
             use is a courtesy against forwarding, not a security boundary. */
          db
            .prepare(`UPDATE invites SET used_by = ?2, used_at = ?3 WHERE id = ?1 AND used_at IS NULL`)
            .bind(invite.id, id, nowIso()),
          ...(invite.board_id
            ? [
                db
                  .prepare(
                    `INSERT OR IGNORE INTO board_members (board_id, user_id, role)
                     SELECT id, ?2, 'editor' FROM boards WHERE id = ?1 AND is_inbox = 0`,
                  )
                  .bind(invite.board_id, id),
              ]
            : []),
        ]
      : []),
  ]);

  const row = await findUserById(db, id);
  if (!row) throw new Error("user row missing right after insert");
  return row;
}

/**
 * A free handle made from `text`, else from the email's local part, else
 * "user", with a number on the end when the plain one is taken. Two sign-ups
 * racing for the same one: the unique index refuses the second, and signing
 * in again picks the next number.
 */
export async function uniqueHandle(db: D1Database, text: string, email: string): Promise<string> {
  const usable = (h: string | null) => (h && !handleProblem(h) ? h : null);
  const base = usable(handleFrom(text)) ?? usable(handleFrom(email.split("@")[0])) ?? "user";
  const stem = base.slice(0, HANDLE_MAX - 3).replace(/-+$/, "");
  const candidates = [base, ...Array.from({ length: 9 }, (_, i) => `${stem}-${i + 2}`)];
  const { results } = await db
    .prepare(`SELECT handle FROM users WHERE handle IN (${candidates.map((_, i) => `?${i + 1}`).join(",")})`)
    .bind(...candidates)
    .all<{ handle: string }>();
  const taken = new Set(results.map((r) => r.handle));
  const free = candidates.find((h) => !taken.has(h) && !handleProblem(h));
  if (free) return free;
  const random = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => (b % 36).toString(36)).join("");
  return `${stem}-${random}`;
}

/**
 * Who sees this person's handle and picture, and so refetches when they
 * change: themselves, everyone they or their agents share a board with, and
 * the admins (the people page). Agents have no tabs to tell.
 */
export async function peopleAudience(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM users
        WHERE kind = 'person' AND (
              id = ?1
           OR is_admin = 1
           OR id IN (SELECT other.user_id FROM board_members mine
                       JOIN board_members other ON other.board_id = mine.board_id
                      WHERE mine.user_id = ?1 OR mine.user_id IN (SELECT id FROM users WHERE owner_id = ?1)))`,
    )
    .bind(userId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** The statement that keeps a person's agents' handles ("old/codex" → "new/codex") in step with theirs. */
export function renameAgentsStatement(db: D1Database, ownerId: string, handle: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE users SET handle = ?2 || '/' || (SELECT name FROM agents WHERE user_id = users.id) WHERE owner_id = ?1`)
    .bind(ownerId, handle);
}

export async function inboxIdFor(db: D1Database, userId: string): Promise<string> {
  const row = await db.prepare(`SELECT board_id FROM inboxes WHERE user_id = ?1`).bind(userId).first<{ board_id: string }>();
  if (!row) throw new Error(`user ${userId} has no inbox`);
  return row.board_id;
}
