/* ============================================================================
   Loading Worker modules in a check, and a D1 stand-in to run them on.
   ----------------------------------------------------------------------------
   The Worker imports "@/..." and extensionless relative paths, which Vite
   and wrangler resolve and node does not. The hook below resolves both to
   the .ts file (node strips the types), so a check can import a route and
   call it. Import this before any Worker module, and import those with
   `await import(...)` so the hook is in place first.

   d1() is the real migrations on an in-memory node:sqlite database behind
   the slice of D1 the routes use: prepare, bind, first, all, run, and batch
   as one transaction.
   ========================================================================== */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = new URL("../src/", import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    let url: URL | null = null;
    if (specifier.startsWith("@/")) url = new URL(specifier.slice(2), SRC);
    else if (specifier.startsWith(".") && context.parentURL?.startsWith(SRC.href)) url = new URL(specifier, context.parentURL);
    if (url && !/\.\w+$/.test(url.pathname)) {
      const file = [".ts", ".tsx", "/index.ts"].map((ext) => fileURLToPath(url) + ext).find((f) => existsSync(f));
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

export function sqlite(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  return db;
}

type Stmt = { sql: string; args: SQLInputValue[] };
const plain = <T>(row: unknown) => (row === undefined ? null : ({ ...(row as object) } as T));

export function d1(db: DatabaseSync): D1Database {
  const stmt = (sql: string, args: SQLInputValue[] = []) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a as SQLInputValue[]),
    first: async <T>() => plain<T>(db.prepare(sql).get(...args)),
    all: async <T>() => ({ results: db.prepare(sql).all(...args).map((r) => plain<T>(r)) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: Stmt[]) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => ({ meta: { changes: Number(db.prepare(s.sql).run(...s.args).changes) } }));
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

/** Just enough of R2 for uploads: put, head, delete, and objects put by the check. */
export function r2() {
  const objects = new Map<string, { size: number; type: string; name: string; uploadedBy: string; bytes?: Uint8Array }>();
  const bucket = {
    put: async (
      key: string,
      body: ReadableStream<Uint8Array>,
      options: { httpMetadata: { contentType: string }; customMetadata: { name: string; uploadedBy: string } },
    ) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { size: bytes.length, type: options.httpMetadata.contentType, ...options.customMetadata, bytes });
      return { size: bytes.length };
    },
    head: async (key: string) => {
      const o = objects.get(key);
      return o ? { size: o.size, httpMetadata: { contentType: o.type }, customMetadata: { name: o.name, uploadedBy: o.uploadedBy } } : null;
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return { objects, bucket: bucket as unknown as R2Bucket };
}
