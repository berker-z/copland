/* ============================================================================
   Users and sign-up.
   ----------------------------------------------------------------------------
   Google authenticates (auth.ts); this decides whether that person gets in.

     - An address with a user row signs in, unless the row is disabled or
       belongs to a different Google account.
     - A new address gets a row when one of these holds:
         it is listed in ADMIN_EMAILS (the bootstrap path),
         SIGNUP is "open",
         it arrived through an unused, unexpired invite (locked to that
         address, if the invite names one).
       Otherwise it is refused, which on SIGNUP=closed means everyone but the
       admins: a personal instance.

   A new user gets their inbox board in the same batch, and joins the
   invite's board if it carries one.
   ========================================================================== */

import type { SignupMode, User } from "@/domain/types";
import type { Env } from "../env";
import { createBoardStatements, uniqueBoardKey } from "./boards";
import { nowIso } from "../http";

export interface UserRow {
  id: string;
  email: string;
  google_sub: string | null;
  name: string;
  picture: string | null;
  is_admin: number;
  disabled_at: string | null;
}

export function rowToUser(row: UserRow, admins: Set<string>): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    isAdmin: row.is_admin === 1 || admins.has(row.email),
  };
}

export function adminEmails(env: Env): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function signupMode(env: Env): SignupMode {
  return env.SIGNUP === "open" || env.SIGNUP === "closed" ? env.SIGNUP : "invite";
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare(`SELECT * FROM users WHERE id = ?1`).bind(id).first<UserRow>();
}

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare(`SELECT * FROM users WHERE email = ?1`).bind(email.toLowerCase()).first<UserRow>();
}

/* ---------------------------------------------------------------- sign-up -- */

/** What auth.ts takes from a verified Google ID token. */
export interface GoogleProfile {
  sub: string;
  /** Lowercased and verified by Google. */
  email: string;
  name: string | null;
  picture: string | null;
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
    /* Claim the row on first real sign-in, and follow Google's photo. The
       name is left alone once set: the person may have changed it here. */
    await db
      .prepare(`UPDATE users SET google_sub = ?2, picture = ?3 WHERE id = ?1`)
      .bind(existing.id, profile.sub, profile.picture)
      .run();
    return { ...existing, google_sub: profile.sub, picture: profile.picture };
  }

  const isAdmin = adminEmails(env).has(profile.email);
  let invite: InviteRow | null = null;
  if (!isAdmin && signupMode(env) !== "open") {
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
    name: profile.name?.trim() || profile.email.split("@")[0],
    picture: profile.picture,
    isAdmin,
    invite,
  });
}

/** A new user, their inbox, and whatever their invite brings, in one batch. */
export async function createUser(
  env: Env,
  input: {
    email: string;
    googleSub: string | null;
    name: string;
    picture: string | null;
    isAdmin: boolean;
    invite: InviteRow | null;
  },
): Promise<UserRow> {
  const db = env.DB;
  const id = crypto.randomUUID();
  const inboxId = crypto.randomUUID();
  const key = await uniqueBoardKey(db, input.name);
  const { invite } = input;

  await db.batch([
    db
      .prepare(`INSERT INTO users (id, email, google_sub, name, picture, is_admin) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(id, input.email, input.googleSub, input.name, input.picture, input.isAdmin ? 1 : 0),
    ...createBoardStatements(db, {
      id: inboxId,
      key,
      name: "inbox",
      ownerId: id,
      isInbox: true,
      hasPlanning: false,
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

export async function inboxIdFor(db: D1Database, userId: string): Promise<string> {
  const row = await db.prepare(`SELECT board_id FROM inboxes WHERE user_id = ?1`).bind(userId).first<{ board_id: string }>();
  if (!row) throw new Error(`user ${userId} has no inbox`);
  return row.board_id;
}
