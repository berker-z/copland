/* ============================================================================
   Messages: short notes between a person and their agents (COPL-44,
   migrations/0025_messages.sql).
   ----------------------------------------------------------------------------
   Who may message whom, the one rule both the Worker and the checks read:
     - a person may message their own agents;
     - an agent may message its owner;
     - anyone else on a board an agent is on may message it when its owner
       opened it to the board's members (agents.work_from = 'members'), and
       those messages are untrusted, like comments;
     - a reply goes back to whoever sent the message it answers, whoever
       they are, so an agent can answer a member it was allowed to hear from;
     - nobody messages themselves, agents never message other agents (not
       even their owner's other agents) and people never message people:
       between people, comments on a task are the way.
   A message is trusted when it comes from the recipient's owner, or, for a
   person, from one of their own agents.
   ========================================================================== */

/** The most a message holds. A message is a nudge, not a document. */
export const MESSAGE_MAX = 1000;

export interface MessageParty {
  id: string;
  kind: "person" | "agent";
  /** For an agent: the person it belongs to. */
  ownerId: string | null;
  /** For an agent: who may give it work, and so message it. */
  workFrom?: "owner" | "members";
}

export type MessageVerdict = { ok: true; trusted: boolean } | { ok: false; reason: string };

/** Whether the owner relation joins the two, either way round. */
export const ownerRelated = (a: MessageParty, b: MessageParty) => a.ownerId === b.id || b.ownerId === a.id;

/**
 * May `sender` message `recipient`? `sharesBoard` is whether they are both on
 * a board the agent can see; `reply` whether this answers a message
 * `recipient` sent `sender`.
 */
export function mayMessage(
  sender: MessageParty,
  recipient: MessageParty,
  { sharesBoard = false, reply = false }: { sharesBoard?: boolean; reply?: boolean } = {},
): MessageVerdict {
  const trusted = ownerRelated(sender, recipient);
  if (sender.id === recipient.id) return { ok: false, reason: "You cannot message yourself" };
  if (sender.kind === "agent" && recipient.kind === "agent") return { ok: false, reason: "Agents cannot message other agents" };
  if (reply) return { ok: true, trusted };
  if (sender.kind === "person" && recipient.kind === "person") {
    return { ok: false, reason: "Messages go between a person and their agents; between people, comment on a task" };
  }
  if (trusted) return { ok: true, trusted };
  if (sender.kind === "agent") return { ok: false, reason: "An agent can message only its owner, or answer a message it was sent" };
  if (recipient.workFrom === "members" && sharesBoard) return { ok: true, trusted: false };
  return {
    ok: false,
    reason:
      recipient.workFrom === "members"
        ? "You can message this agent only while you share a board with it"
        : "Only this agent's owner can message it",
  };
}

/**
 * Whom a nudge on a task offers to message (COPL-108): the viewer's own
 * agents among the board's members, those assigned to the task first, then
 * by handle. Other people's agents are left out even when they are open to
 * members: the browser doesn't know which are, and a nudge is the owner's.
 */
export function nudgeTargets<U extends { id: string; kind: "person" | "agent"; ownerId: string | null; handle: string }>(
  users: U[],
  viewerId: string,
  assigneeIds: string[],
): U[] {
  const assigned = (u: U) => Number(!assigneeIds.includes(u.id));
  return users
    .filter((u) => u.kind === "agent" && u.ownerId === viewerId)
    .sort((a, b) => assigned(a) - assigned(b) || a.handle.localeCompare(b.handle));
}
