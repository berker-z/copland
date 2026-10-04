/* ============================================================================
   Images on comments (COPL-117): src/domain/commentImages.ts and the comment
   routes in src/worker/routes/comments.ts.
   ----------------------------------------------------------------------------
   Run: npm run check. The rule for the attachments field is a pure
   function. The routes run for real (checks/worker.ts) on the migrations in
   an in-memory node:sqlite, with a stand-in R2: a comment goes in with its
   images or not at all, only the caller's own unattached images are taken,
   they come back on the thread and stay off the task's own attachments, an
   edit keeps them and a delete takes their rows and objects.

   And the MCP's way in (COPL-119): comment_on_task's images field, and the
   tool itself through handleMcp, uploading through the real upload route
   and posting through the real comment route.
   ========================================================================== */

import { d1, r2, sqlite } from "./worker.ts";
import type { Comment, Viewer } from "../src/domain/types.ts";
import type { ApiCall } from "../src/worker/mcp.ts";

const { COMMENT_IMAGES_MAX, admitCommentImages, isCommentImage, parseCommentImages, parseToolImages, TOOL_IMAGE_BYTES_MAX } = await import("../src/domain/commentImages.ts");
const { deleteComment, getComments, patchComment, postComment } = await import("../src/worker/routes/comments.ts");
const { findTask } = await import("../src/worker/repo/tasks.ts");

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);

/* The field. */
const keys = (raw: unknown) => {
  const v = parseCommentImages(raw);
  return v.ok ? v.keys.join(",") : null;
};
t("no attachments field is no images", keys(undefined) === "" && keys(null) === "");
t("a list of keys is taken in order", keys(["a", "b"]) === "a,b");
t("anything but a list of strings is refused", keys("a") === null && keys([1]) === null && keys([""]) === null && keys({}) === null);
t("the same key twice is refused", keys(["a", "a"]) === null);
t("the cap is a cap", keys(Array.from({ length: COMMENT_IMAGES_MAX }, (_, i) => `k${i}`)) !== null);
t("one over the cap is refused, saying why", (() => {
  const v = parseCommentImages(Array.from({ length: COMMENT_IMAGES_MAX + 1 }, (_, i) => `k${i}`));
  return !v.ok && v.reason.includes(String(COMMENT_IMAGES_MAX));
})());
t("png, jpeg, gif and webp are images", ["image/png", "image/jpeg", "image/gif", "image/webp", "IMAGE/PNG; x=1"].every(isCommentImage));
t("svg, pdf and the rest are not", !["image/svg+xml", "image/avif", "application/pdf", "text/plain", ""].some(isCommentImage));

/* The comment box's check before it uploads (COPL-118). */
const f = (name: string, type: string) => ({ name, type });
const names = (v: { take: { name: string }[] }) => v.take.map((x) => x.name).join(",");
t("the box takes images in order", (() => {
  const v = admitCommentImages(0, [f("a.png", "image/png"), f("b.jpg", "image/jpeg")]);
  return names(v) === "a.png,b.jpg" && v.refused === null;
})());
t("the box turns a non-image away by name and keeps the images", (() => {
  const v = admitCommentImages(0, [f("a.png", "image/png"), f("brief.pdf", "application/pdf")]);
  return names(v) === "a.png" && !!v.refused?.includes("brief.pdf");
})());
t("a file with no type is not an image", admitCommentImages(0, [f("x", "")]).take.length === 0);
t("the box fills up to the cap and says why it stopped", (() => {
  const v = admitCommentImages(COMMENT_IMAGES_MAX - 1, [f("a.png", "image/png"), f("b.png", "image/png")]);
  return names(v) === "a.png" && !!v.refused?.includes(String(COMMENT_IMAGES_MAX));
})());
t("a full box takes nothing", (() => {
  const v = admitCommentImages(COMMENT_IMAGES_MAX, [f("a.png", "image/png")]);
  return v.take.length === 0 && v.refused !== null;
})());

/* The routes. */
const db = sqlite();
db.exec(`
  INSERT INTO users (id, email, handle) VALUES ('sam', 'sam@x.test', 'sam'), ('ada', 'ada@x.test', 'ada'), ('zed', 'zed@x.test', 'zed');
  INSERT INTO boards (id, name, key, created_by) VALUES ('b1', 'B', 'BB', 'sam');
  INSERT INTO board_members (board_id, user_id, role) VALUES ('b1', 'sam', 'owner'), ('b1', 'ada', 'viewer');
  INSERT INTO stages (id, board_id, name, position, category) VALUES ('s1', 'b1', 'todo', 0, 'todo');
  INSERT INTO tasks (id, board_id, number, title, stage_id, created_by) VALUES ('t1', 'b1', 1, 'T', 's1', 'sam');
`);
const files = r2();
/* before() runs inside the next batch, ahead of its statements: another request landing between the claim and the write. */
let beforeBatch: (() => void) | null = null;
const real = d1(db);
const DB = { prepare: real.prepare, batch: (stmts: D1PreparedStatement[]) => (beforeBatch?.(), (beforeBatch = null), real.batch(stmts)) };
const env = { DB, FILES: files.bucket } as unknown as Parameters<typeof postComment>[1];
const notified: string[][] = [];
const changes = {
  notify: (ids: string[], ...topics: string[]) => void (topics.includes("board") && notified.push(ids)),
} as unknown as Parameters<typeof postComment>[4];
const who = (id: string): Viewer => ({ user: { id, kind: "person", email: `${id}@x.test`, handle: id, avatar: null, isAdmin: false, ownerId: null } });
const sam = who("sam");
const ada = who("ada");
const zed = who("zed");

let n = 0;
const upload = (by: string, type = "image/png") => {
  const key = `attachments/u${++n}`;
  files.objects.set(key, { size: 100 + n, type, name: `pic${n}.png`, uploadedBy: by });
  return key;
};
const req = (body: unknown) => new Request("https://x.test/", { method: "POST", body: JSON.stringify(body) });
const refused = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return false;
  } catch (error) {
    return (error as { status?: number }).status === 400 || (error as { status?: number }).status === 404;
  }
};
const thread = async (viewer = sam) => (await (await getComments(env, viewer, "t1")).json()) as Comment[];
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const comments = () => count(`SELECT count(*) AS n FROM comments`);

const a = upload("sam");
const b = upload("sam", "image/webp");
const posted = (await (await postComment(req({ text: "look", attachments: [a, b] }), env, sam, "t1", changes)).json()) as Comment[];
const mine = posted[0];
/* At GET /api/attachments/<key>, the download route every attachment is served from (COPL-118). */
t("a comment goes in with its images, in order, each at the download route", mine.attachments.map((x) => x.url).join(",") === `/api/attachments/${a},/api/attachments/${b}`);
t("each image says its name, type and size", mine.attachments[1].name === "pic2.png" && mine.attachments[1].type === "image/webp" && mine.attachments[1].size === 102);
t("the thread reads them back, for a viewer too", (await thread(ada))[0].attachments.length === 2);
t("they keep the task's id, so the board check reads them", count(`SELECT count(*) AS n FROM attachments WHERE task_id = 't1' AND comment_id IS NOT NULL`) === 2);
t("they stay off the task's own attachments", (await findTask(env.DB, "t1"))?.attachments.length === 0);
t("a comment without images has none", ((await (await postComment(req({ text: "plain" }), env, sam, "t1", changes)).json()) as Comment[])[1].attachments.length === 0);

const before = comments();
t("a key already on a comment is refused", await refused(() => postComment(req({ text: "again", attachments: [a] }), env, sam, "t1", changes)));
t("someone else's upload is refused", await refused(() => postComment(req({ text: "x", attachments: [upload("zed")] }), env, sam, "t1", changes)));
t("a key never uploaded is refused", await refused(() => postComment(req({ text: "x", attachments: ["attachments/nope"] }), env, sam, "t1", changes)));
t("a key outside the upload space is refused", await refused(() => postComment(req({ text: "x", attachments: ["avatars/x"] }), env, sam, "t1", changes)));
const pdf = upload("sam", "application/pdf");
t("a file that isn't an image is refused", await refused(() => postComment(req({ text: "x", attachments: [pdf] }), env, sam, "t1", changes)));
const good = upload("sam");
t("one bad key refuses the lot", await refused(() => postComment(req({ text: "x", attachments: [good, pdf] }), env, sam, "t1", changes)));
t("someone not on the board can't attach to it", await refused(() => postComment(req({ text: "x", attachments: [upload("zed")] }), env, zed, "t1", changes)));
t("a refused comment leaves nothing behind", comments() === before && count(`SELECT count(*) AS n FROM attachments`) === 2);
t("the good key from a refused comment is still free", ((await (await postComment(req({ text: "y", attachments: [good] }), env, sam, "t1", changes)).json()) as Comment[])[2].attachments.length === 1);

/* Two comments racing for one key: the loser's batch fails on attachments.key UNIQUE and takes its comment with it. */
const raced = upload("sam");
const atRace = comments() + 1;
beforeBatch = () =>
  db.exec(`INSERT INTO comments (id, task_id, author_id, text) VALUES ('c-race', 't1', 'sam', 'first');
    INSERT INTO attachments (id, task_id, comment_id, name, mime, size, kind, key) VALUES ('a-race', 't1', 'c-race', 'p', 'image/png', 1, 'image', '${raced}')`);
const lost = await postComment(req({ text: "second", attachments: [raced] }), env, sam, "t1", changes).then(
  () => false,
  () => true,
);
t("a key taken meanwhile refuses the whole comment", lost && comments() === atRace && count(`SELECT count(*) AS n FROM comments WHERE text = 'second'`) === 0);

const patched = (await (await patchComment(new Request("https://x.test/", { method: "PATCH", body: JSON.stringify({ text: "look again" }) }), env, sam, mine.id, changes)).json()) as Comment[];
t("an edit keeps the images", patched[0].text === "look again" && patched[0].attachments.length === 2);

await deleteComment(env, sam, mine.id, changes);
t("deleting the comment deletes its image rows", count(`SELECT count(*) AS n FROM attachments WHERE key IN ('${a}', '${b}')`) === 0);
t("and their objects", !files.objects.has(a) && !files.objects.has(b));
t("and nobody else's", files.objects.has(good) && files.objects.has(raced));
t("board members hear about each write", notified.length >= 4 && notified.every((ids) => ids.includes("sam") && ids.includes("ada")));


/* comment_on_task's images (COPL-119): the field, then the tool through
   handleMcp, its in-process calls built by apiRequest (what the Worker's
   apiCaller sends) and answered by the real upload and comment routes. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const b64 = (bytes: number[] | Uint8Array) => btoa(String.fromCharCode(...bytes));
const png = b64([...PNG, 1, 2, 3]);
const jpeg = b64([0xff, 0xd8, 0xff, 0xe0, 9]);
const reason = (raw: unknown) => {
  const v = parseToolImages(raw);
  return v.ok ? "" : v.reason;
};
t("no images is none", (() => {
  const v = parseToolImages(undefined);
  return v.ok && v.images.length === 0;
})());
t("a png and a jpeg are read from their bytes", (() => {
  const v = parseToolImages([{ name: "a.jpg", data: png }, { name: " b ", data: `data:image/jpeg;base64,${jpeg}` }]);
  return v.ok && v.images[0].type === "image/png" && v.images[0].bytes.length === 11 && v.images[1].type === "image/jpeg" && v.images[1].name === "b";
})());
t("the name doesn't make a gif a png", reason([{ name: "x.png", data: b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) }]).includes("not a PNG or JPEG"));
t("svg text is not an image", reason([{ name: "x.png", data: btoa("<svg/>") }]).includes("not a PNG or JPEG"));
t("data that isn't base64 is refused, naming the image", reason([{ name: "ok.png", data: png }, { name: "shot.png", data: "not base64!" }]).startsWith("Image 2 (shot.png)"));
t("a missing name or data is refused", reason([{ data: png }]).includes("needs a name") && reason([{ name: "a" }]).includes("needs data"));
t("unknown fields are refused", reason([{ name: "a", data: png, type: "image/png" }]).includes("unknown field type"));
t("anything but a list of objects is refused", reason("x") !== "" && reason(["x"]) !== "");
t("more than the comment's cap is refused, naming it", reason(Array.from({ length: COMMENT_IMAGES_MAX + 1 }, () => ({ name: "a", data: png }))).includes(String(COMMENT_IMAGES_MAX)));
const big = new Uint8Array(TOOL_IMAGE_BYTES_MAX + 1);
big.set(PNG);
/* In chunks a multiple of three long, so the pieces join into one base64 string. */
const b64Long = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 30000) out += b64(bytes.subarray(i, i + 30000));
  return out;
};
t("one byte over the size cap is refused, naming it", reason([{ name: "big.png", data: b64Long(big) }]).includes(`${TOOL_IMAGE_BYTES_MAX / 1024 / 1024} MB`));
t("the size cap itself is fine", parseToolImages([{ name: "max.png", data: b64Long(big.subarray(0, TOOL_IMAGE_BYTES_MAX)) }]).ok);

const { apiRequest, CallError, handleMcp } = await import("../src/worker/mcp.ts");
const { postUpload } = await import("../src/worker/routes/attachments.ts");
const { requireWriteScope } = await import("../src/worker/tokens.ts");
const calls: string[] = [];
const api = (viewer: Viewer): ApiCall => async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  calls.push(`${method} ${path}`);
  const request = apiRequest(new URL(path, "https://x.test"), method, body);
  try {
    requireWriteScope(viewer, method);
    const task = (await findTask(env.DB, "t1"))!;
    const route: Record<string, () => Promise<unknown>> = {
      "GET /api/tasks/BB-1": async () => task,
      "GET /api/boards/b1": async () => ({ board: { id: "b1", key: "BB" }, tasks: [task] }),
      "POST /api/uploads": async () => (await postUpload(request, env, viewer)).json(),
      "POST /api/tasks/t1/comments": async () => (await postComment(request, env, viewer, "t1", changes)).json(),
    };
    return (await route[`${method} ${path}`]()) as T;
  } catch (error) {
    const e = error as { message: string; status?: number };
    throw new CallError(e.message, e.status ?? 500, null);
  }
};
const callTool = async (viewer: Viewer, args: Record<string, unknown>) => {
  calls.length = 0;
  const request = new Request("https://x.test/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "comment_on_task", arguments: args } }),
  });
  const out = (await (await handleMcp(request, viewer, api(viewer), async () => {}, "https://x.test")).json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { text: out.result.content[0].text, error: out.result.isError === true };
};

const toolBefore = comments();
const said = await callTool(sam, { task: "BB-1", text: "screenshot", images: [{ name: "shot one.png", data: png }, { name: "b.jpg", data: jpeg }] });
const last = (await thread()).at(-1)!;
t("the tool posts the comment with its images", !said.error && said.text.includes("with 2 images") && comments() === toolBefore + 1 && last.attachments.length === 2);
t("each image went up as its sniffed type and its own name", last.attachments[0].type === "image/png" && last.attachments[0].name === "shot one.png" && last.attachments[1].type === "image/jpeg");
t("the bytes in R2 are the bytes sent", (() => {
  const stored = files.objects.get(last.attachments[0].url.replace(/^\/api\/attachments\//, ""))?.bytes;
  return !!stored && b64(stored) === png;
})());
t("it uploads each image, then posts once", calls.filter((c) => c === "POST /api/uploads").length === 2 && calls.at(-1) === "POST /api/tasks/t1/comments");
t("without images it is a plain comment", !(await callTool(sam, { task: "BB-1", text: "plain" })).error && (await thread()).at(-1)!.attachments.length === 0);

const bad = await callTool(sam, { task: "BB-1", text: "x", images: [{ name: "a.png", data: png }, { name: "fake.png", data: btoa("GIF89a") }] });
t("a bad image refuses the comment before anything is uploaded", bad.error && bad.text.includes("Image 2 (fake.png)") && calls.length === 0);
const objectsBefore = files.objects.size;
const readOnly: Viewer = { ...sam, access: { scope: "read" } as Viewer["access"] };
const refusedRead = await callTool(readOnly, { task: "BB-1", text: "x", images: [{ name: "a.png", data: png }] });
t("a read-only token is refused at the upload", refusedRead.error && refusedRead.text.includes("read-only") && files.objects.size === objectsBefore);
const viewerTry = await callTool(ada, { task: "BB-1", text: "from a viewer", images: [{ name: "a.png", data: png }] });
t("a viewer may comment with images too", !viewerTry.error && (await thread()).at(-1)!.attachments.length === 1);
let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} comment checks passed`);
if (failed) process.exit(1);
