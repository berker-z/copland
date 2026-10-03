/* ============================================================================
   GitHub on boards: how code names a task (src/domain/github.ts, COPL-73).
   ----------------------------------------------------------------------------
   Run: npm run check. Repo names, keys in branches, titles and closing
   keywords, CI states, and the webhook signature.
   ========================================================================== */

import { generateKeyPairSync } from "node:crypto";
import { ciFrom, closedIn, keysIn, parseRepo, pullRefs, verifySignature } from "../src/domain/github.ts";
import { pkcs8FromPem } from "../src/worker/pem.ts";

const cases: Array<[string, boolean]> = [];
const t = (name: string, pass: boolean) => cases.push([name, pass]);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* Repo names. */
t("owner/name passes, lowercased", parseRepo("Berker-Z/Copland") === "berker-z/copland");
t("a github.com URL passes", parseRepo("https://github.com/berker-z/copland") === "berker-z/copland");
t("a clone URL passes", parseRepo("https://github.com/berker-z/copland.git") === "berker-z/copland");
t("a trailing slash passes", parseRepo("berker-z/copland/") === "berker-z/copland");
t("dots and underscores in the name pass", parseRepo("a/b.c_d") === "a/b.c_d");
t("no slash is refused", parseRepo("copland") === null);
t("a path is refused", parseRepo("a/b/c") === null);
t("'..' as a name is refused", parseRepo("a/..") === null);
t("an owner starting with '-' is refused", parseRepo("-a/b") === null);
t("not a string is refused", parseRepo(42) === null);

/* Keys. */
t("a key in a branch", eq(keysIn("COPL", "copl-73-github"), [73]));
t("a key after a prefix", eq(keysIn("COPL", "feature/COPL-73"), [73]));
t("whole numbers only: COPL-7 is not in COPL-70", eq(keysIn("COPL", "COPL-70"), [70]));
t("another board's key is not ours", eq(keysIn("COPL", "XCOPL-5 and MUT-3"), []));
t("several keys, each once", eq(keysIn("COPL", "COPL-1, copl-2 and COPL-1"), [1, 2]));
t("a key with regex characters is escaped", eq(keysIn("A.B", "AxB-1 A.B-2"), [2]));

/* Closing keywords. */
t("Fixes", eq(closedIn("COPL", "Fixes COPL-73"), [73]));
t("closes: with a colon", eq(closedIn("COPL", "closes: copl-9"), [9]));
t("resolved", eq(closedIn("COPL", "this resolved COPL-4 at last"), [4]));
t("a plain mention closes nothing", eq(closedIn("COPL", "see COPL-73"), []));
t("'prefixes' is not 'fixes'", eq(closedIn("COPL", "prefixes COPL-73"), []));

/* A PR's references, strongest wins. */
const refs = pullRefs("COPL", { branch: "copl-73-github", title: "COPL-73, COPL-74: hooks", body: "Fixes COPL-75\nsee COPL-76" });
t("the branch closes", refs.get(73) === "closes");
t("a title key only mentions", refs.get(74) === "mentions");
t("a closing keyword in the body closes", refs.get(75) === "closes");
t("a plain mention in the body is not a reference", !refs.has(76));

/* CI. */
t("success", ciFrom("success") === "success");
t("a timeout fails", ciFrom("timed_out") === "failure");
t("a commit status error fails", ciFrom("error") === "failure");
t("pending", ciFrom("pending") === "pending");
t("neutral says nothing", ciFrom("neutral") === null);
t("skipped says nothing", ciFrom("skipped") === null);

/* The signature: GitHub's own documented example (docs.github.com, "Validating webhook deliveries"). */
const SECRET = "It's a Secret to Everybody";
const BODY = "Hello, World!";
const GOOD = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
t("GitHub's example verifies", await verifySignature(SECRET, BODY, GOOD));
t("another body fails", !(await verifySignature(SECRET, `${BODY} `, GOOD)));
t("another secret fails", !(await verifySignature("nope", BODY, GOOD)));
t("a missing header fails", !(await verifySignature(SECRET, BODY, null)));
t("sha1 is refused", !(await verifySignature(SECRET, BODY, "sha1=01dc10d0c83e72ed246219cdd91669667fe2ca59")));
t("a short signature is refused", !(await verifySignature(SECRET, BODY, "sha256=abc")));

/* The App's key: GitHub hands out PKCS#1, WebCrypto imports PKCS#8 (worker/githubApp.ts). */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const b64 = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
t("a PKCS#1 key is wrapped into the same PKCS#8 node makes", pkcs8FromPem(pkcs1) === b64(pkcs8));
t("a PKCS#8 key passes through", pkcs8FromPem(pkcs8) === b64(pkcs8));
const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const signer = await crypto.subtle.importKey("pkcs8", Buffer.from(pkcs8FromPem(pkcs1), "base64"), alg, false, ["sign"]);
const verifier = await crypto.subtle.importKey("spki", publicKey.export({ type: "spki", format: "der" }), alg, false, ["verify"]);
const sig = await crypto.subtle.sign(alg, signer, new TextEncoder().encode("jwt"));
t("the wrapped key signs what its public key verifies", await crypto.subtle.verify(alg, verifier, sig, new TextEncoder().encode("jwt")));

let failed = 0;
for (const [name, pass] of cases) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : "FAIL  "} ${name}`);
}
console.log(`\n${cases.length - failed}/${cases.length} GitHub checks passed`);
if (failed) process.exit(1);
