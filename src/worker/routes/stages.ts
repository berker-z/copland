/* ============================================================================
   Stages and labels: a board's own vocabulary. Owners shape the stages
   (the columns); editors manage labels, since tagging is part of the work.

   A stage with tasks in it cannot be deleted outright: the caller names
   another stage to move them to, so no task is ever left without a column.
   The last open stage and the last done stage stay, because the tasks pane
   ticks between them.
   ========================================================================== */

import { isClosing } from "@/domain/tasks";
import { STAGE_CATEGORIES, type StageCategory, type Viewer } from "@/domain/types";
import { requireBoard } from "../access";
import type { Env } from "../env";
import { badRequest, conflict, json, notFound, nowIso, readJson } from "../http";
import type { Changes } from "../live";
import { boardAudience } from "../repo/boards";
import { eventStatement, listLabels, listStages } from "../repo/tasks";

function parseName(raw: unknown, max: number): string {
  if (typeof raw !== "string" || !raw.trim()) throw badRequest("`name` must be a non-empty string");
  const name = raw.trim();
  if (name.length > max) throw badRequest(`\`name\` is longer than ${max} characters`);
  return name;
}

function parseTone(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 7) throw badRequest("`tone` must be 0-7");
  return raw;
}

function parseCategory(raw: unknown): StageCategory {
  if (typeof raw !== "string" || !(STAGE_CATEGORIES as readonly string[]).includes(raw)) {
    throw badRequest(`\`category\` must be one of ${STAGE_CATEGORIES.join(", ")}`);
  }
  return raw as StageCategory;
}

async function stageRow(db: D1Database, id: string) {
  const row = await db
    .prepare(`SELECT id, board_id, category FROM stages WHERE id = ?1`)
    .bind(id)
    .first<{ id: string; board_id: string; category: StageCategory }>();
  if (!row) throw notFound("No such stage");
  return row;
}

/** Would the board still have an open stage and a done stage without this one? */
function keepsTheBasics(categories: StageCategory[]): boolean {
  return categories.some((c) => !isClosing(c)) && categories.includes("done");
}

/* --------------------------------------------------------------- stages -- */

/** POST /api/boards/:id/stages { name, category, tone? }: appended at the end. */
export async function postStage(request: Request, env: Env, viewer: Viewer, boardId: string, changes: Changes) {
  const db = env.DB;
  await requireBoard(db, viewer, boardId, "owner");
  const body = await readJson(request);
  const name = parseName(body.name, 30);
  const category = parseCategory(body.category);
  const tone = body.tone === undefined ? 0 : parseTone(body.tone);
  const stages = await listStages(db, boardId);
  if (stages.length >= 12) throw badRequest("A board can have at most 12 stages");
  await db
    .prepare(`INSERT INTO stages (id, board_id, position, name, category, tone) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(crypto.randomUUID(), boardId, stages.length, name, category, tone)
    .run();
  changes.notify(await boardAudience(db, boardId), "board");
  return json(await listStages(db, boardId), { status: 201 });
}

/** PATCH /api/stages/:id { name?, category?, tone? } */
export async function patchStage(request: Request, env: Env, viewer: Viewer, id: string, changes: Changes) {
  const db = env.DB;
  const stage = await stageRow(db, id);
  await requireBoard(db, viewer, stage.board_id, "owner");
  const body = await readJson(request);
  const sets: string[] = [];
  const values: unknown[] = [];
  const extra: D1PreparedStatement[] = [];
  if (body.name !== undefined) {
    sets.push(`name = ?${values.length + 2}`);
    values.push(parseName(body.name, 30));
  }
  if (body.tone !== undefined) {
    sets.push(`tone = ?${values.length + 2}`);
    values.push(parseTone(body.tone));
  }
  if (body.category !== undefined) {
    const category = parseCategory(body.category);
    const others = (await listStages(db, stage.board_id)).filter((s) => s.id !== id).map((s) => s.category);
    if (!keepsTheBasics([...others, category])) {
      throw conflict("A board needs at least one open stage and one done stage");
    }
    sets.push(`category = ?${values.length + 2}`);
    values.push(category);
    /* The tasks in it open or close with the stage. */
    if (isClosing(category) !== isClosing(stage.category)) {
      extra.push(
        isClosing(category)
          ? db.prepare(`UPDATE tasks SET completed_at = ?2 WHERE stage_id = ?1 AND completed_at IS NULL`).bind(id, nowIso())
          : db.prepare(`UPDATE tasks SET completed_at = NULL WHERE stage_id = ?1`).bind(id),
      );
    }
  }
  if (sets.length === 0) throw badRequest("Nothing to update");
  await db.batch([db.prepare(`UPDATE stages SET ${sets.join(", ")} WHERE id = ?1`).bind(id, ...values), ...extra]);
  changes.notify(await boardAudience(db, stage.board_id), "board");
  return json(await listStages(db, stage.board_id));
}

/** PUT /api/boards/:id/stages/order { ids: [...] }: every stage, in the new order. */
export async function putStageOrder(request: Request, env: Env, viewer: Viewer, boardId: string, changes: Changes) {
  const db = env.DB;
  await requireBoard(db, viewer, boardId, "owner");
  const { ids } = await readJson(request);
  const stages = await listStages(db, boardId);
  if (
    !Array.isArray(ids) ||
    ids.length !== stages.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !stages.some((s) => s.id === id))
  ) {
    throw badRequest("`ids` must list every stage of the board exactly once");
  }
  await db.batch(ids.map((id, position) => db.prepare(`UPDATE stages SET position = ?2 WHERE id = ?1`).bind(id, position)));
  changes.notify(await boardAudience(db, boardId), "board");
  return json(await listStages(db, boardId));
}

/** DELETE /api/stages/:id?moveTo=<stageId>: tasks in it move to moveTo first. */
export async function deleteStage(env: Env, viewer: Viewer, id: string, url: URL, changes: Changes) {
  const db = env.DB;
  const stage = await stageRow(db, id);
  await requireBoard(db, viewer, stage.board_id, "owner");
  const stages = await listStages(db, stage.board_id);
  const rest = stages.filter((s) => s.id !== id);
  if (!keepsTheBasics(rest.map((s) => s.category))) {
    throw conflict("A board needs at least one open stage and one done stage");
  }
  const count = await db
    .prepare(`SELECT count(*) AS n FROM tasks WHERE stage_id = ?1`)
    .bind(id)
    .first<{ n: number }>();
  const moveTo = url.searchParams.get("moveTo");
  const target = rest.find((s) => s.id === moveTo);
  if ((count?.n ?? 0) > 0 && !target) throw badRequest("This stage has tasks; pass `moveTo` with another stage's id");

  await db.batch([
    ...(target
      ? [
          db
            .prepare(
              `UPDATE tasks SET stage_id = ?2,
                 completed_at = CASE WHEN ?3 THEN coalesce(completed_at, ?4) ELSE NULL END
               WHERE stage_id = ?1`,
            )
            .bind(id, target.id, isClosing(target.category) ? 1 : 0, nowIso()),
        ]
      : []),
    db.prepare(`DELETE FROM stages WHERE id = ?1`).bind(id),
    ...rest.map((s, position) => db.prepare(`UPDATE stages SET position = ?2 WHERE id = ?1`).bind(s.id, position)),
  ]);
  changes.notify(await boardAudience(db, stage.board_id), "board");
  return json(await listStages(db, stage.board_id));
}

/* --------------------------------------------------------------- labels -- */

async function labelRow(db: D1Database, id: string) {
  const row = await db.prepare(`SELECT id, board_id FROM labels WHERE id = ?1`).bind(id).first<{ id: string; board_id: string }>();
  if (!row) throw notFound("No such label");
  return row;
}

async function requireFreeName(db: D1Database, boardId: string, name: string, exceptId: string | null) {
  const clash = await db
    .prepare(`SELECT id FROM labels WHERE board_id = ?1 AND lower(name) = lower(?2) AND id IS NOT ?3`)
    .bind(boardId, name, exceptId)
    .first();
  if (clash) throw conflict(`There is already a label called ${name}`);
}

/** POST /api/boards/:id/labels { name, tone? } */
export async function postLabel(request: Request, env: Env, viewer: Viewer, boardId: string, changes: Changes) {
  const db = env.DB;
  const board = await requireBoard(db, viewer, boardId, "editor");
  const body = await readJson(request);
  const name = parseName(body.name, 24);
  const tone = body.tone === undefined ? Math.floor(Math.random() * 8) : parseTone(body.tone);
  await requireFreeName(db, board.id, name, null);
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO labels (id, board_id, name, tone) VALUES (?1, ?2, ?3, ?4)`).bind(id, board.id, name, tone),
    eventStatement(db, { boardId: board.id, taskId: null, actorId: viewer.user.id, kind: "label.created", after: { name } }),
  ]);
  changes.notify(await boardAudience(db, board.id), "board");
  return json({ id, name, tone }, { status: 201 });
}

/** PATCH /api/labels/:id { name?, tone? } */
export async function patchLabel(request: Request, env: Env, viewer: Viewer, id: string, changes: Changes) {
  const db = env.DB;
  const label = await labelRow(db, id);
  await requireBoard(db, viewer, label.board_id, "editor");
  const body = await readJson(request);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) {
    const name = parseName(body.name, 24);
    await requireFreeName(db, label.board_id, name, id);
    sets.push(`name = ?${values.length + 2}`);
    values.push(name);
  }
  if (body.tone !== undefined) {
    sets.push(`tone = ?${values.length + 2}`);
    values.push(parseTone(body.tone));
  }
  if (sets.length === 0) throw badRequest("Nothing to update");
  await db.prepare(`UPDATE labels SET ${sets.join(", ")} WHERE id = ?1`).bind(id, ...values).run();
  changes.notify(await boardAudience(db, label.board_id), "board");
  return json(await listLabels(db, label.board_id));
}

/** DELETE /api/labels/:id: also comes off every task that had it. */
export async function deleteLabel(env: Env, viewer: Viewer, id: string, changes: Changes) {
  const db = env.DB;
  const label = await labelRow(db, id);
  await requireBoard(db, viewer, label.board_id, "editor");
  await db.prepare(`DELETE FROM labels WHERE id = ?1`).bind(id).run();
  changes.notify(await boardAudience(db, label.board_id), "board");
  return json({ ok: true });
}
