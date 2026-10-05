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
   COPL-131 takes away.
   ========================================================================== */

export interface Budget {
  /** Most rows the route may read on the larger seed. */
  rows: number;
  /** Must read the same on both seeds: nothing in it grows with history. */
  flat: boolean;
}

export const BUDGETS: Record<string, Budget> = {
  "GET /api/boards": { rows: 39, flat: true },
  "GET /api/boards/:id": { rows: 12174, flat: false },
  "GET /api/tasks/:id": { rows: 28, flat: true },
  "GET /api/inbox": { rows: 253, flat: true },
  "GET /api/wired": { rows: 139, flat: true },
  "GET /api/tasks/ready": { rows: 43, flat: true },
  "GET /api/tasks/mine": { rows: 5731, flat: false },
  "GET /api/messages/recipients": { rows: 15, flat: true },
};
