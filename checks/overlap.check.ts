/* ============================================================================
   Overlap reports: who may send one, what a path may be, the cap, and
   which tasks overlap (src/domain/overlap.ts, COPL-102, COPL-104).
   ----------------------------------------------------------------------------
   Run: npm run check. Only the run holding a task's live claim reports its
   files; paths are plain repo-relative ones; a report is sorted, deduplicated
   and capped at TASK_FILES_CAP, and says when it was truncated; a report
   replaces the last one, and one that says nothing new is told apart; and
   which tasks share files with which (COPL-104).
   ========================================================================== */

import { overlaps, parseFileReport, pathProblem, reportRefusal, sameReport, TASK_FILE_MAX, TASK_FILES_ACCEPTED, TASK_FILES_CAP, type FileReport } from "../src/domain/overlap.ts";

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const BASE = "9431726c06153edf2f5348aae996cd62832bf486";
const parsed = (body: Record<string, unknown>) => {
  const r = parseFileReport(body);
  return typeof r === "string" ? null : r;
};

/* Who may report. */
t("a token or session without a run is refused with 403", reportRefusal(null, { runId: "r1", live: true })?.status === 403);
t("no claim on the task is a 409", reportRefusal("r1", null)?.status === 409);
t("another run's claim is a 409", reportRefusal("r1", { runId: "r2", live: true })?.status === 409);
t("this run's lapsed claim is a 409", reportRefusal("r1", { runId: "r1", live: false })?.status === 409);
t("this run's live claim may report", reportRefusal("r1", { runId: "r1", live: true }) === null);

/* Paths. */
t("a plain path passes", pathProblem("src/worker/index.ts") === null);
t("a dotfile passes", pathProblem(".github/workflows/ci.yml") === null);
t("a name with dots passes", pathProblem("a/..b/c..") === null);
t("empty is refused", pathProblem("") !== null);
t("absolute is refused", pathProblem("/etc/passwd") !== null);
t("a drive letter is refused", pathProblem("C:/x") !== null);
t("'..' is refused", pathProblem("src/../../etc") !== null && pathProblem("..") !== null);
t("'.' is refused", pathProblem("./src/a.ts") !== null);
t("an empty segment is refused", pathProblem("src//a.ts") !== null && pathProblem("src/") !== null);
t("a backslash is refused", pathProblem("src\\a.ts") !== null);
t("a control character is refused", pathProblem("a\nb") !== null && pathProblem("a\u0000") !== null);
t("the longest path passes, one more is refused", pathProblem("a".repeat(TASK_FILE_MAX)) === null && pathProblem("a".repeat(TASK_FILE_MAX + 1)) !== null);

/* The body. */
t("a report passes, sorted and deduplicated", eq(parsed({ base: BASE, files: ["b.ts", "a.ts", "b.ts"] }), { base: BASE, files: ["a.ts", "b.ts"], truncated: false }));
t("base is lowercased", parsed({ base: BASE.toUpperCase(), files: [] })?.base === BASE);
t("a short sha passes", parsed({ base: "9431726", files: [] }) !== null);
t("no files is a report too", eq(parsed({ base: BASE, files: [] })?.files, []));
t("a base that isn't a commit is refused", typeof parseFileReport({ base: "main", files: [] }) === "string");
t("a missing base is refused", typeof parseFileReport({ files: [] }) === "string");
t("files not an array is refused", typeof parseFileReport({ base: BASE, files: "a.ts" }) === "string");
t("a path that isn't a string is refused", typeof parseFileReport({ base: BASE, files: [1] }) === "string");
t("one bad path refuses the report", typeof parseFileReport({ base: BASE, files: ["a.ts", "../x"] }) === "string");
t("truncated that isn't a boolean is refused", typeof parseFileReport({ base: BASE, files: [], truncated: "yes" }) === "string");

/* The cap. */
const many = Array.from({ length: TASK_FILES_CAP + 20 }, (_, i) => `f/${String(i).padStart(4, "0")}.ts`).reverse();
const capped = parsed({ base: BASE, files: many });
t("more than the cap keeps the first CAP, sorted, and says truncated", capped?.files.length === TASK_FILES_CAP && capped.truncated && capped.files[0] === "f/0000.ts");
const exact = parsed({ base: BASE, files: many.slice(0, TASK_FILES_CAP) });
t("exactly the cap is not truncated", exact?.files.length === TASK_FILES_CAP && exact.truncated === false);
t("duplicates don't count toward the cap", parsed({ base: BASE, files: [...many.slice(0, TASK_FILES_CAP), ...many.slice(0, 10)] })?.truncated === false);
t("the sender's own truncated is kept", parsed({ base: BASE, files: ["a.ts"], truncated: true })?.truncated === true);
t("more than accepted is refused", typeof parseFileReport({ base: BASE, files: Array.from({ length: TASK_FILES_ACCEPTED + 1 }, (_, i) => `f${i}`) }) === "string");

/* Replacing. */
const r: FileReport = { base: BASE, files: ["a.ts", "b.ts"], truncated: false };
t("the same report says nothing new", sameReport(r, { ...r, files: [...r.files] }));
t("another file is new", !sameReport(r, { ...r, files: ["a.ts", "c.ts"] }));
t("one file fewer is new", !sameReport(r, { ...r, files: ["a.ts"] }));
t("another base is new", !sameReport(r, { ...r, base: "1234567" }));
t("truncated is new", !sameReport(r, { ...r, truncated: true }));

/* Which tasks share files. */
const lists = [
  { id: "a", files: ["src/x.ts", "src/y.ts", "README.md"] },
  { id: "b", files: ["src/y.ts"] },
  { id: "c", files: ["src/x.ts", "src/y.ts", "src/z.ts"] },
  { id: "d", files: ["docs/only.md"] },
  { id: "e", files: [] },
];
const o = overlaps(lists);
t("a task sharing nothing is absent", !o.has("d") && !o.has("e"));
t("each side sees the other", o.get("b")?.some((x) => x.taskId === "a") === true && o.get("a")?.some((x) => x.taskId === "b") === true);
t("the shared files are listed, sorted", eq(o.get("a")?.find((x) => x.taskId === "c")?.shared, ["src/x.ts", "src/y.ts"]));
t("most shared first", eq(o.get("a")?.map((x) => x.taskId), ["c", "b"]));
t("more shared before fewer, from the other side too", eq(o.get("c")?.map((x) => x.taskId), ["a", "b"]));
t("a tie in count keeps input order", eq(overlaps([{ id: "p", files: ["f"] }, { id: "q", files: ["f"] }, { id: "r", files: ["f"] }]).get("r")?.map((x) => x.taskId), ["p", "q"]));
t("a task never overlaps itself", [...o].every(([id, list]) => list.every((x) => x.taskId !== id)));
t("a duplicate path in one list counts once", eq(overlaps([{ id: "p", files: ["f", "f"] }, { id: "q", files: ["f"] }]).get("p")?.[0].shared, ["f"]));
t("no lists, no overlap", overlaps([]).size === 0);
t("one task alone overlaps nothing", overlaps([{ id: "p", files: ["f"] }]).size === 0);

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} overlap report checks passed`);
if (failed) process.exit(1);
