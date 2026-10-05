/* ============================================================================
   Rows-read budgets for checks/reads.check.ts (COPL-149).
   ----------------------------------------------------------------------------
   Rows D1 reads to answer each route once, summed over its statements, on
   the larger of the check's two seeds. `flat` routes must also read the
   same on both seeds within the check's margin: what they read must not
   grow with a board's history. A change that makes a route read less lowers
   its budget here in the same commit, and says so in its PR; one that makes
   it read more says why. Set at main's numbers when the check came in; the
   routes not yet flat read their board's whole history, which the rest of
   COPL-131 takes away. The board read went flat with COPL-150 (open tasks
   and the last two weeks' closed ones); its paged older history is a page
   of 100. Besides the routes, one row is a live event's cost: what a tab
   reads when it hears a task edit (COPL-151).
   ========================================================================== */

export interface Budget {
  /** Most rows the route may read on the larger seed. */
  rows: number;
  /** Must read the same on both seeds: nothing in it grows with history. */
  flat: boolean;
}

export const BUDGETS: Record<string, Budget> = {
  "GET /api/boards": { rows: 39, flat: true },
  "GET /api/boards/:id": { rows: 739, flat: true },
  "GET /api/boards/:id/shell": { rows: 29, flat: true },
  "GET /api/boards/:id/closed": { rows: 2914, flat: true },
  "GET /api/tasks/:id": { rows: 26, flat: true },
  "GET /api/inbox": { rows: 241, flat: true },
  "GET /api/wired": { rows: 139, flat: true },
  "GET /api/tasks/ready": { rows: 43, flat: true },
  "GET /api/tasks/mine": { rows: 5731, flat: false },
  "GET /api/messages/recipients": { rows: 15, flat: true },
  /* What a listening tab reads after one task edit (COPL-151): until then,
     GET /api/boards/:id and GET /api/boards, 778 rows on the larger seed
     (12213 before COPL-150). */
  "live: one task edit, heard": { rows: 24, flat: true },
  /* What a tab reads to open a task from the inbox or /wired without holding
     its board (COPL-153): its shell, the task and its parent. Until then,
     GET /api/boards/:id, 739 rows. */
  "inbox: one task opened": { rows: 107, flat: true },
};
