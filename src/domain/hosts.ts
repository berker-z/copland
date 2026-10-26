/* ============================================================================
   Where an agent runs (COPL-135): what its daemon reports about the machine,
   and the rules for it, shared by the Worker (routes/hosts.ts) and the checks.
   ----------------------------------------------------------------------------
   One agent per place: choosing a host means assigning to the right agent
   (@sam/laptop, @sam/server); nothing routes one agent between hosts. Two
   hosts live at once for one agent is usually a forgotten daemon, so the
   owner is warned (liveOnTwoHosts).
   ========================================================================== */

/** The upgrade header a daemon names its host with on its live socket (live.ts). */
export const HOST_HEADER = "x-copland-host";

/** Most hosts kept per agent; a report from a new one past this drops the longest quiet. */
export const MAX_HOSTS = 16;
export const MAX_RUNTIMES = 16;
export const MAX_REPOS = 64;
const VERSION_MAX = 40;
const RUNTIME_NAME_MAX = 40;
const REPO_MAX = 300;
const DETAIL_MAX = 200;

/** A runtime the daemon can start (claude, codex): on its PATH, and logged in. */
export interface RuntimeCapability {
  name: string;
  onPath: boolean;
  loggedIn: boolean;
}

/** One board repo, as this machine reaches it: "owner/name" or a remote URL. */
export interface RepoCapability {
  repo: string;
  clone: boolean;
  push: boolean;
  /** One line on why not, or how ("no push access", "ssh key"), when the daemon says. */
  detail: string | null;
}

export interface HostCapabilities {
  runtimes: RuntimeCapability[];
  repos: RepoCapability[];
}

/** PUT /api/hosts/self, as stored. */
export interface HostReport {
  hostname: string;
  version: string;
  capabilities: HostCapabilities;
}

/**
 * A hostname as it is kept: trimmed and lowercased (hostnames don't care
 * about case, so "Laptop" and "laptop" are one host), 1 to 253 of letters,
 * digits, dot, dash and underscore, starting with a letter or digit. Null
 * when it can't be one.
 */
export function parseHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,252}$/.test(name) ? name : null;
}

const line = (value: unknown, max: number): string | null | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? undefined : text || null;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A report's body checked and bounded, or what is wrong with it, in words a caller can act on. */
export function parseHostReport(body: unknown): { ok: true; report: HostReport } | { ok: false; problem: string } {
  const no = (problem: string) => ({ ok: false as const, problem });
  if (!isObject(body)) return no("The body must be a JSON object");
  const hostname = parseHostname(body.hostname);
  if (!hostname) return no("`hostname` must be 1 to 253 of letters, digits, `.`, `-` and `_`, starting with a letter or digit");
  const version = line(body.version, VERSION_MAX);
  if (!version) return no(`\`version\` must be a non-empty string of at most ${VERSION_MAX} characters`);
  const caps = body.capabilities;
  if (!isObject(caps)) return no("`capabilities` must be an object with `runtimes` and `repos`");
  if (!Array.isArray(caps.runtimes) || caps.runtimes.length > MAX_RUNTIMES) {
    return no(`\`capabilities.runtimes\` must be a list of at most ${MAX_RUNTIMES}`);
  }
  if (!Array.isArray(caps.repos) || caps.repos.length > MAX_REPOS) {
    return no(`\`capabilities.repos\` must be a list of at most ${MAX_REPOS}`);
  }
  const runtimes: RuntimeCapability[] = [];
  for (const [i, r] of caps.runtimes.entries()) {
    const name = isObject(r) ? line(r.name, RUNTIME_NAME_MAX) : undefined;
    if (!isObject(r) || !name || typeof r.onPath !== "boolean" || typeof r.loggedIn !== "boolean") {
      return no(`\`capabilities.runtimes[${i}]\` must be { name (at most ${RUNTIME_NAME_MAX} characters), onPath, loggedIn }`);
    }
    runtimes.push({ name, onPath: r.onPath, loggedIn: r.loggedIn });
  }
  const repos: RepoCapability[] = [];
  for (const [i, r] of caps.repos.entries()) {
    const repo = isObject(r) ? line(r.repo, REPO_MAX) : undefined;
    const detail = isObject(r) ? (r.detail === undefined || r.detail === null ? null : line(r.detail, DETAIL_MAX)) : undefined;
    if (!isObject(r) || !repo || typeof r.clone !== "boolean" || typeof r.push !== "boolean" || detail === undefined) {
      return no(
        `\`capabilities.repos[${i}]\` must be { repo (at most ${REPO_MAX} characters), clone, push, detail? (one line, at most ${DETAIL_MAX}) }`,
      );
    }
    repos.push({ repo, clone: r.clone, push: r.push, detail });
  }
  return { ok: true, report: { hostname, version, capabilities: { runtimes, repos } } };
}

/**
 * Whether an agent is live on two hosts at once, given the hosts its live
 * sockets named (null: a socket that named none, from a daemon older than
 * COPL-135). Only named hosts count: an unnamed socket may be either of them.
 */
export function liveOnTwoHosts(hosts: Iterable<string | null>): boolean {
  return new Set([...hosts].filter((h) => h !== null)).size > 1;
}

/** Hostnames as a sentence names them: "laptop", "laptop and server", "a, b and c". */
export function hostList(hosts: string[]): string {
  if (hosts.length <= 1) return hosts.join("");
  return `${hosts.slice(0, -1).join(", ")} and ${hosts[hosts.length - 1]}`;
}

/**
 * What the web app says when an agent is live on two hosts at once, naming
 * the ones it knows (a live host that never reported has no name to give).
 */
export function twoHostsWarning(hosts: string[]): string {
  const where = hosts.length > 1 ? hostList(hosts) : "two hosts";
  return `Live on ${where} at once: usually a forgotten daemon. Stop the one you don't mean to run.`;
}
