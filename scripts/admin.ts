/* ============================================================================
   npm run admin -- you@example.com [--local]

   Makes an existing user an admin, straight in D1 through wrangler. The way
   back in when nobody who can still sign in is an admin; day to day, admins
   do this in settings › instance. The person must have signed in once, so
   that they have a row. --local works on the dev database instead.
   ========================================================================== */

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const local = args.includes("--local");
const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();

/* No quotes or whitespace can get through this, which is what keeps the
   address safe to put in the SQL below. */
if (!email || !/^[^\s@'"\\;]+@[^\s@'"\\;]+\.[^\s@'"\\;]+$/.test(email)) {
  console.error("usage: npm run admin -- you@example.com [--local]");
  process.exit(1);
}

const sql =
  `UPDATE users SET is_admin = 1 WHERE email = '${email}'; ` +
  `SELECT email, is_admin, disabled_at FROM users WHERE email = '${email}';`;

execFileSync("npx", ["wrangler", "d1", "execute", "copland", local ? "--local" : "--remote", "--command", sql], {
  stdio: "inherit",
});
console.log(`\nAn empty result means nobody has signed in as ${email} yet.`);
