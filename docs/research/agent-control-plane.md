# Copland: Agent-Native Work Control Plane

**Status:** Product / architecture direction note  
**Date:** 2026-10-02  
**Purpose:** Capture the current thesis, competitive findings, architectural primitives, and near-term direction for Copland as an agent-native coordination layer.

---

## 1. The core idea

Copland should not try to become an agent runtime like Hermes, Claude Code, Codex, Devin, LangGraph, CrewAI, or a homegrown agent loop.

The stronger idea is to become the layer that lets a person take **whatever agents and runtimes they already use** and turn them into durable workers inside a shared work system.

A useful shorthand is:

> **Copland lets people "Hermes-ify" their existing setup without forcing them to use Hermes.**

In this model, the runtime is replaceable. The worker identity is not.

A user might have:

```text
berker/dev
berker/research
berker/reviewer
```

Those are durable principals inside Copland. They can own work, receive assignments, be mentioned, comment, accumulate history, and have permissions.

At different times, `berker/dev` might be executed by:

```text
Codex CLI
Claude Code
Hermes
a shell script
a local daemon
a LangGraph deployment
a future model/runtime that does not exist yet
```

Copland should not care very much which one it is.

The runtime computes.

Copland coordinates.

---

## 2. Product thesis

The best current description of Copland is:

> **A runtime-neutral control plane for human-agent work.**

Or, slightly more product-oriented:

> **A shared work protocol between humans and arbitrary agents.**

Or:

> **Give any agent an identity, inbox, permissions, work queue, and place on the team.**

The important boundary is that Copland should own:

- durable identity
- delegation
- assignments
- permissions and authority
- work state
- comments and communication
- mentions
- history
- notifications/inbox
- active execution state
- handoffs
- structured outputs/artifacts
- auditability

Copland should generally **not** own:

- model inference
- agent planning loops
- coding sandboxes
- browser automation engines
- tool execution infrastructure
- durable workflow execution
- model/provider selection
- agent reasoning implementation

Those belong to runtimes and execution frameworks.

This separation is not a weakness. It is the product boundary.

---

## 3. The most important architectural distinction

The system now needs four separate concepts:

```text
Principal
Credential
Client
Run
```

They answer four different questions.

### Principal

**Who is acting?**

Examples:

```text
berker
berker/dev
berker/reviewer
```

The principal is durable.

Assignments, permissions, comments, history, and reputation belong to the principal.

An agent principal should survive token rotation, runtime changes, model changes, machine changes, and individual executions.

---

### Credential

**How did this principal authenticate?**

Examples:

- API token
- OAuth token
- future signing key
- local daemon credential

Credentials are disposable and rotatable.

A credential must not *be* the identity.

If a token is revoked and replaced, `berker/dev` must remain the same worker.

Copland already largely follows this correctly.

---

### Client

**Which program is currently talking to Copland?**

Examples:

```text
Codex CLI
Claude Code
Hermes
Cursor
ChatGPT
VS Code
custom daemon
```

This is provenance, not identity.

The same `berker/dev` principal might appear as:

```text
berker/dev via Codex CLI
berker/dev via Claude Code
berker/dev via Hermes
```

That is desirable.

It means Copland understands that the worker and the software currently embodying the worker are different things.

---

### Run

**Which particular execution of the worker did this?**

A run is one temporary invocation of an agent principal.

Example:

```text
principal:  berker/dev
client:     Codex CLI
run:        run_8f31
started:    14:03
ended:      14:21
status:     completed
```

The best analogy is:

```text
agent principal ≈ Unix user
run             ≈ process
```

The Unix user may exist for years.

Many processes can run simultaneously as that user.

Killing one process does not delete the user.

Likewise, `berker/dev` is persistent, while individual Codex or Claude executions come and go.

This becomes essential once multiple executions happen concurrently.

Without runs:

```text
berker/dev is doing things
```

With runs:

```text
run-A of berker/dev is working on CPL-12
run-B of berker/dev is working on CPL-19
run-C of berker/dev crashed eight minutes ago
```

A run should remain a lightweight execution record, not a new user or agent identity.

---

## 4. Assignment and claim are different concepts

This distinction follows naturally from runs.

### Assignment

Assignment is durable responsibility.

```text
CPL-42 assigned to berker/dev
```

Meaning:

> This worker owns this piece of work.

That may remain true for hours, days, or weeks.

### Claim

A claim is ephemeral execution ownership.

```text
run_8f31 claims CPL-42 until 14:30
```

Meaning:

> This particular execution is actively working on this task right now.

If the process crashes and stops heartbeating, the lease expires.

The task remains assigned to `berker/dev`.

Another run can pick it up.

This distinction prevents crashed executions from permanently holding work and enables safe concurrency.

A future shape might look like:

```text
Task
  assigned_to: berker/dev

Claim
  task_id: CPL-42
  run_id: run_8f31
  claimed_until: 2026-10-02T14:30:00Z
```

---

## 5. What the competitive market is converging on

A useful finding from the current market is that Copland is **not imagining a fake problem**.

Several major systems have independently converged on the same underlying primitives:

- agent-like identities
- delegation
- work items
- agent sessions/runs
- agent activity
- artifacts
- inbox/notification events
- human oversight

That means some of the continent has already been discovered.

It also means the abstractions are probably real.

The important question is not whether these primitives exist elsewhere.

The important question is **which layer Copland owns and how runtime-neutral it is**.

---

## 6. Linear

Linear is the clearest comparison.

Linear currently models AI agents as **app users**. They behave similarly to workspace users and can be:

- mentioned
- delegated issues
- involved in comments
- involved in projects/documents

Linear also has an explicit `AgentSession`.

Its developer documentation describes `AgentSession` as tracking the lifecycle of an individual agent run.

Sessions are automatically created when an agent is mentioned or delegated an issue.

Session states include concepts such as:

```text
pending
active
awaitingInput
error
complete
stale
```

Agents emit structured activity into the session.

Linear also provides inbox notification webhooks for agent users.

This is strikingly close to the model Copland has independently been moving toward.

### Rough conceptual mapping

```text
Copland                 Linear

agent principal         app user
run                     AgentSession
assignment              delegation
event/history           Agent Activity
mention                 mention
inbox event             AppUserNotification
```

### Why this does not invalidate Copland

Linear's product boundary is approximately:

> Build agents that participate naturally inside Linear.

The Linear workspace is the center of gravity.

The installed agent is generally an app identity inside that workspace.

Copland can choose a different center of gravity:

> Create durable worker identities that may be embodied by arbitrary runtimes.

The difference matters.

Copland could let:

```text
berker/dev
```

remain the same durable worker while swapping:

```text
Codex
Claude Code
Hermes
local scripts
future runtimes
```

The worker identity is not inherently the vendor/runtime integration.

That separation should remain a core design principle.

### References

- https://linear.app/developers/agents
- https://linear.app/developers/agent-interaction
- https://linear.app/developers/agent-best-practices
- https://linear.app/docs/agents-in-linear

---

## 7. Jira / Atlassian

Jira is also moving aggressively toward agent-native work management.

Current Jira functionality includes:

- assigning agents to work items
- `@mention`ing agents in comments
- triggering agents from workflow transitions
- attaching agents to board columns
- third-party agent support
- visible agent sessions
- centralized views of active/past agent sessions
- development artifacts such as pull request links
- bulk assignment of agents
- filtering backlogs by active agents

This is particularly important because Jira is moving beyond "AI assistant in a sidebar."

The agent is increasingly becoming a participant in the work graph.

### Atlassian's likely product boundary

Atlassian's center of gravity is:

```text
Jira work item
    ↓
agent invocation
    ↓
agent session
    ↓
output / artifact
```

The workflow remains Jira-native.

Copland's opportunity is to be designed from first principles around mixed human/agent teams rather than adding agents to a decades-old work model.

### References

- https://support.atlassian.com/jira-software-cloud/docs/collaborate-on-work-items-with-ai-agents/
- https://support.atlassian.com/jira-software-cloud/docs/work-with-ai-agents-in-jira/
- https://confluence.atlassian.com/cloud/blog/2026/09/atlassian-cloud-changes-sep-14-to-sep-21-2026

---

## 8. GitHub

GitHub is building the coding-specific version of the same pattern.

A GitHub issue can be assigned to Copilot coding agent.

That launches an asynchronous agent session.

The agent works in a GitHub Actions-backed environment, makes code changes, opens a branch/PR, runs tests, and eventually asks for human review.

GitHub now also exposes centralized agent management concepts, including:

- custom agents
- third-party agents
- agent sessions
- agent audit events
- MCP configuration/policy
- enterprise controls

GitHub explicitly defines an agent session as the interaction between an agent and a specific task.

### GitHub's product boundary

GitHub owns:

```text
software task
repository
execution environment
branch
pull request
review
```

This is enormously powerful for software work.

But it is intentionally GitHub-shaped and software-shaped.

Copland can remain broader:

```text
research
coding
review
operations
content
admin
automation
personal work
arbitrary workflows
```

The goal should not be to beat GitHub at coding agents.

The goal should be to let GitHub-based agents coexist with every other worker in the same coordination model.

### References

- https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/
- https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/
- https://docs.github.com/en/copilot/concepts/enterprise/agent-management

---

## 9. Devin

Devin comes from the opposite side of the stack.

Devin owns the worker/runtime.

It then integrates outward into work systems.

For example, Devin provides automation patterns where:

```text
Linear assignment or label
        ↓
Devin session
        ↓
implementation
        ↓
tests
        ↓
pull request
```

This is almost the inverse of Copland.

### Devin

```text
Devin runtime
    ├── Linear integration
    ├── Jira integration
    ├── GitHub integration
    └── sessions
```

### Copland thesis

```text
               Copland
        ┌────────┼────────┐
      Codex    Claude    Devin
      Hermes    script    etc.
```

Devin asks:

> How can Devin perform work inside your existing tools?

Copland should ask:

> How can arbitrary workers participate in one coherent work system?

### Reference

- https://docs.devin.ai/automation-templates/linear-ticket-implementation

---

## 10. LangGraph / CrewAI / Temporal

These should mostly be treated as complementary rather than direct competition.

### LangGraph / LangSmith

LangGraph/LangSmith models things like:

```text
assistant
thread
run
```

Its job is agent execution, state, configuration, and application runtime behavior.

That is below Copland in the stack.

### Temporal

Temporal is even clearer.

Temporal provides **durable execution**.

It makes long-running workflows and agent loops survive:

- crashes
- network failures
- retries
- long waits
- human approval delays

Copland should not attempt to recreate Temporal.

A Temporal-backed agent should be able to participate in Copland.

Temporal answers:

> How does this execution reliably continue?

Copland answers:

> What work exists, who owns it, what authority do they have, what is happening now, and what came out of it?

### References

- https://docs.langchain.com/langsmith/configuration-cloud
- https://docs.langchain.com/langsmith/managed-deep-agents-api/runs/create-thread-run
- https://docs.temporal.io/ai

---

## 11. A2A is strategically important

The Agent2Agent protocol is especially relevant.

A2A already standardizes concepts including:

```text
Agent Card
Task
Message
Artifact
Task lifecycle
capabilities
authentication
```

Its `Agent Card` describes an agent's identity, capabilities, endpoint, skills, and authentication requirements.

Its `Task` represents a stateful unit of work.

Its `Artifact` represents a tangible structured output.

This is close enough to Copland's future concerns that Copland should avoid inventing proprietary equivalents where protocol compatibility would be more useful.

### MCP and A2A may eventually sit on opposite sides

A useful future mental model:

```text
                    Copland
                       │
           ┌───────────┴───────────┐
           │                       │
          MCP                     A2A
           │                       │
agent uses Copland       Copland communicates with
as a tool                / invokes an agent
```

MCP is currently a good interface for:

> An agent wants to inspect or mutate Copland.

A2A may become useful for:

> Copland needs to address or communicate with an agent/runtime.

Copland should stay protocol-friendly rather than becoming a bespoke execution ecosystem.

### Reference

- https://a2a-protocol.org/latest/topics/key-concepts/

---

## 12. The key product white space

The strongest current opportunity appears to be this intersection:

| Capability | Copland direction |
|---|---|
| Owns work graph | Yes |
| Human + agent workspace | Yes |
| Durable agent identity | Yes |
| Runtime-neutral | Yes, by design |
| Owns model/runtime | No |
| Owns execution infra | No |
| Supports local/private workers | Should |
| Supports arbitrary clients | Should |
| Supports multiple runtimes per identity | Yes |
| Open protocol surface | Should |

Linear, Jira, and GitHub increasingly support agents.

Agent frameworks increasingly support execution.

Protocols increasingly support inter-agent communication.

The potential gap is a **small, open, runtime-neutral coordination system where arbitrary human and machine principals share work**.

That is the space Copland should test.

---

## 13. What would make Copland merely a weaker Linear

There is a major strategic danger.

If Copland becomes:

> A nice Kanban board where cards can be assigned to AI agents.

then it is mostly rediscovering Linear/Jira with fewer resources.

That battle is bad.

Linear already has:

- agent identities
- assignments/delegation
- mentions
- sessions
- activities
- notifications
- workflows
- mature collaboration UX

Jira has all of that plus enormous enterprise distribution.

Therefore "task manager with AI assignees" is not enough.

The stronger thesis is:

> **Copland is where arbitrary runtimes acquire durable organizational identity and participate in a shared work protocol.**

That changes the center of gravity.

Copland is not selling "our AI worker."

Copland is not even fundamentally selling "AI project management."

It is selling the coordination substrate.

---

## 14. A principle worth protecting: Copland should not care what an agent is

This may be the most important product constraint.

Copland should not assume that an agent is:

- Claude
- Codex
- OpenAI
- Anthropic
- an LLM
- a coding agent
- cloud-hosted
- always online
- conversational
- autonomous

A principal like:

```text
berker/deploy
```

might be backed by a deterministic CI automation.

A principal like:

```text
berker/research
```

might be a Claude process.

A principal like:

```text
berker/dev
```

might use Codex today and a local model tomorrow.

A principal like:

```text
berker/reviewer
```

might be operated manually by a human-triggered script.

From Copland's perspective, the important fact is:

> This is an actor that can receive work and perform actions under defined authority.

That generality is valuable.

---

## 15. A missing abstraction: execution binding

Agent identity and runtime connection should probably remain separate concepts.

Today Copland can say:

```text
berker/dev exists
```

But eventually it must answer:

> How does work wake `berker/dev` up?

That suggests another concept, perhaps named:

```text
binding
executor
endpoint
worker binding
runtime binding
```

The exact name can wait.

Conceptually:

```text
berker/dev
    │
    ├── identity
    ├── permissions
    ├── board memberships
    ├── assignments
    │
    └── execution bindings
            ├── polling
            ├── webhook
            ├── local daemon
            ├── A2A
            └── other transport
```

This should not be embedded directly into the agent principal.

Why?

Because the same agent may change execution mechanism without changing identity.

It may even have multiple available bindings.

For example:

```text
berker/dev
  ├── local Codex daemon
  └── remote fallback worker
```

This is analogous to the existing separation between principal and credential.

---

## 16. Agent inbox / event queue

For arbitrary runtimes to operate reliably, polling the task board itself is not sufficient.

Agents need a durable inbox or event stream.

Events might include:

```text
task.assigned
task.unassigned
task.updated
comment.mentioned
comment.replied
task.unblocked
claim.expiring
review.requested
board.access.changed
agent.paused
```

Each event should ideally have:

```text
id
target_principal_id
type
resource_id
created_at
acknowledged_at
payload / metadata
```

Important properties:

- durable
- ordered enough for practical consumption
- idempotent
- acknowledgeable
- safe to retry
- usable by polling clients
- eventually usable by push/webhook clients

This becomes the real work inbox for machine principals.

An agent should be able to ask:

> What happened that requires my attention?

without diffing the entire workspace.

---

## 17. Mentions should resolve to stable IDs

Visible handles are presentation.

Identity should be stable.

If a comment contains:

```text
@berker/reviewer please check this
```

Copland should resolve that mention at write time and store something like:

```text
comment_mentions
  comment_id
  principal_id
```

The textual comment remains human-readable.

The relation remains stable even if:

- the agent is renamed
- the handle changes
- the original name is later reused
- the agent is deleted/disabled

Do not rely on reparsing historical comment text later.

The mention relation should also produce an inbox event.

---

## 18. Artifacts should be first-class

Agent work often produces something more concrete than a comment.

Examples:

- GitHub pull request
- commit
- file
- report
- document
- image
- deployment
- URL
- structured JSON
- diff
- dataset
- test result

Runs should eventually be able to attach structured artifacts.

A generic starting shape could be:

```text
Artifact
  id
  run_id
  task_id
  kind
  label
  url?
  file_ref?
  structured_data?
  created_at
```

Do not overdesign the schema initially.

A simple typed external reference may be enough.

The important conceptual rule is:

> A comment describes work. An artifact is an output of work.

This distinction is already appearing in A2A, GitHub, Jira, and agent runtimes.

---

## 19. Run provenance

Runs create a much cleaner audit model.

Without runs, history looks like:

```text
berker/dev via Codex changed task
berker/dev via Codex commented
berker/dev via Codex changed stage
berker/dev via Codex attached PR
```

With runs:

```text
berker/dev via Codex
run 8f31
worked on CPL-42
14:03–14:21

- changed task metadata
- added implementation note
- attached PR #81
- moved task to review
```

This is useful for:

- UI grouping
- debugging
- cost accounting
- performance analytics
- failure recovery
- provenance
- concurrency
- later undo/revert semantics

Runs should probably become a foreign key or optional context on events generated during execution.

---

## 20. Minimal run schema

Do not overbuild this.

A reasonable first version:

```text
runs
  id
  agent_id
  client
  started_at
  ended_at
  status
  last_seen_at
```

Possible future additions:

```text
credential_id
external_id
external_url
metadata
parent_run_id
trigger_event_id
```

But these should only be added when concrete requirements appear.

The primary purpose is answering:

> Which particular invocation of this persistent worker did this?

---

## 21. Near-term primitive set

The next important primitives are not fifty random features.

They are roughly these:

### 1. Run / session

One execution of one agent principal.

Needed for concurrency, provenance, activity grouping, and claims.

### 2. Claim / lease

A run temporarily claims active execution of a task.

Claims expire.

Assignments do not.

### 3. Agent inbox / events

Durable notifications addressed to principals.

Polling first is completely acceptable.

Push can come later.

### 4. Mentions

Resolve to stable principal IDs and emit inbox events.

### 5. Artifacts

Structured outputs attached to runs/tasks.

### 6. Execution bindings

Eventually describe how an assigned principal can be awakened.

Do not rush this before inbox/polling semantics are proven.

---

## 22. Suggested order of implementation

A sensible sequence is:

```text
1. Run model
2. Task claim / lease
3. Inbox events
4. Stable mentions
5. Run-linked activity/history
6. Artifacts
7. Runtime/executor bindings
8. Push/webhook delivery
9. A2A compatibility where useful
```

This keeps the system useful through simple polling before introducing orchestration complexity.

The system should be capable of supporting the following without Copland hosting a model:

```text
user creates task
      ↓
assigns berker/dev
      ↓
task.assigned inbox event
      ↓
local daemon polls Copland
      ↓
daemon starts Codex
      ↓
creates run
      ↓
run claims task
      ↓
Codex works
      ↓
comments / artifacts / events carry run context
      ↓
task moves to review
      ↓
@berker/reviewer
      ↓
reviewer's inbox receives mention
      ↓
different runtime starts reviewer run
```

That is the first complete demonstration of the thesis.

---

## 23. The "Hermes-ify anything" user experience

The product should eventually make something like this possible:

### Step 1: create durable workers

```text
berker/dev
berker/research
berker/reviewer
```

### Step 2: connect existing tools

Perhaps:

```bash
copland connect berker/dev
```

or through OAuth/token setup.

The exact UX can differ, but the user should not need to rebuild their agent architecture.

### Step 3: give workers access to Copland

MCP is already a strong first interface.

The worker can:

- inspect assigned work
- claim tasks
- comment
- change state
- mention others
- attach artifacts
- mark completion

### Step 4: optionally run a tiny local coordinator

A local daemon could:

- poll agent inboxes
- see new assignments
- launch the user's preferred runtime
- create a run
- renew claims
- terminate/cleanup when done

Copland still does not become Hermes.

The daemon is intentionally boring.

It translates:

```text
work event → user's runtime
```

### Step 5: heterogeneous team

One identity may run via Codex.

Another may run via Claude.

Another may be a shell script.

Another may be a remote SaaS agent.

Copland presents one coherent work graph.

---

## 24. Security principles already worth keeping

Several existing Copland decisions fit this direction well.

### Agent cannot broaden its own authority

Agent-management actions should remain human/browser-owned.

An agent should not be able to:

- expand its own grants
- mint broader credentials
- promote itself
- change its own ownership
- silently increase board access

This is a strong invariant.

### Effective board authority should remain bounded by the owner

The current general principle:

```text
effective agent role
  <= agent membership role
  <= owner's current authority
  <= editor
```

is good.

If the human loses access, the agent loses derived authority immediately.

### Personal data should require explicit grants

Agent access to owner-personal resources should remain opt-in and capability-based.

### Pause should be live

Pausing an agent should invalidate its ability to act without requiring old credentials to be individually discovered and revoked first.

These are all strong foundations for a control-plane product.

---

## 25. One architectural issue to revisit later: actor vs resource owner

When an authorized agent accesses owner-personal resources, Copland currently has logic equivalent to treating the owner as the effective personal viewer.

That is practical, but long term the system should preserve both:

```text
actor:       berker/assistant
on_behalf_of: berker
resource_owner: berker
```

rather than making the operation look as if Berker personally performed it.

This becomes more important once auditing and run provenance matter.

It is not necessarily an urgent migration.

It is a future correctness concern.

---

## 26. Naming agents by job instead of runtime

A persistent principal should usually describe the role/persona, not the software implementing it.

Prefer:

```text
berker/dev
berker/reviewer
berker/scout
berker/research
berker/hermes
```

over:

```text
berker/claude
berker/codex
```

when the intended identity is durable across runtime changes.

There is nothing inherently wrong with `berker/claude` if "Claude" genuinely represents a persistent worker persona.

The rule is simply:

> Do not accidentally collapse **principal** and **client**.

If the point of the identity is "the worker that develops my code," `/dev` is stronger.

If the point is "my specific Claude persona with its own history and role," `/claude` can be legitimate.

---

## 27. Positioning language

Avoid positioning Copland as:

- "AI Kanban"
- "Kanban for agents"
- "project management with AI agents"
- "another autonomous agent framework"
- "our AI employee platform"

Those descriptions pull Copland directly into crowded incumbent categories.

Better language:

> **The work control plane for humans and agents.**

> **Give any agent an identity, inbox, permissions, and work queue.**

> **One place for your humans, Claude, Codex, local agents, and automations to coordinate.**

> **Bring your own agents. Copland gives them somewhere to work.**

> **The shared work protocol for mixed human-agent teams.**

The shortest internal formulation may be:

> **Copland owns coordination, not cognition.**

That is a useful design test.

Whenever a proposed feature appears, ask:

> Is this helping coordinate work, identity, authority, state, or provenance?

If yes, it likely belongs.

If it is trying to make Copland better at thinking/executing tasks itself, it probably belongs in the runtime.

---

## 28. What Copland must prove

The immediate goal should not be feature count.

It should prove one strong workflow:

> A person can take two unrelated agent runtimes, give each a stable Copland identity, assign work to them, let them operate concurrently, hand work between them, and understand exactly what happened afterward.

For example:

```text
berker
  │
  ├── assigns CPL-100 → berker/dev
  │
  └── assigns CPL-101 → berker/research

berker/dev
  client: Codex CLI
  run: run-A
  claims CPL-100
  produces PR

berker/research
  client: Claude Code
  run: run-B
  claims CPL-101
  produces report

run-A finishes
  ↓
mentions berker/reviewer

berker/reviewer
  client: Hermes
  run: run-C
  reviews PR
```

If this works cleanly, the core thesis is real.

It demonstrates:

- runtime neutrality
- persistent identity
- concurrency
- claims
- inbox/mentions
- cross-agent handoff
- run provenance
- artifacts
- shared work state

That is much more compelling than adding more board features.

---

## 29. What not to build yet

Avoid premature expansion into:

- model hosting
- prompt playgrounds
- generic LLM gateways
- token metering infrastructure
- proprietary agent SDKs
- full workflow DAG engines
- durable execution systems
- VM/container sandboxes
- browser automation engines
- vector databases
- memory frameworks
- autonomous planning engines

All of those can become integrations.

The whole point is that Copland should make existing tools more useful together.

---

## 30. Strategic interpretation

There is definitely some "rediscovering the Americas" here.

Linear, Jira, GitHub, LangGraph, Temporal, A2A, and agent runtimes are all converging on concepts such as:

```text
identity
task
session/run
activity
artifact
notification
permission
human oversight
```

That means these concepts themselves are not proprietary differentiation.

The differentiation can instead be:

1. **Runtime neutrality**
2. **Durable organizational identities independent of clients**
3. **A deliberately small shared work substrate**
4. **Local/self-hosted friendliness**
5. **Open protocols instead of runtime lock-in**
6. **First-class humans and agents in the same work graph**
7. **Strong delegation and provenance semantics**
8. **Bring-your-own-runtime rather than bring-your-work-to-our-agent**

The market convergence is therefore both a warning and validation.

### Warning

Linear/Jira/GitHub already understand that agents need work items and sessions.

Do not compete merely on that.

### Validation

Multiple sophisticated teams have independently discovered the same primitives.

Copland's architecture is pointing at a real emerging layer.

---

## 31. A possible stack model

A useful way to reason about the ecosystem:

```text
┌─────────────────────────────────────────────┐
│                Human workflow               │
│                                             │
│     Copland / Linear / Jira / GitHub        │
│      identity, work, state, authority       │
├─────────────────────────────────────────────┤
│            Agent communication              │
│                                             │
│              MCP / A2A / APIs               │
├─────────────────────────────────────────────┤
│              Agent runtimes                 │
│                                             │
│ Claude Code / Codex / Devin / Hermes /      │
│ LangGraph / CrewAI / local scripts          │
├─────────────────────────────────────────────┤
│           Durable execution / infra         │
│                                             │
│ Temporal / queues / containers / CI / VMs   │
├─────────────────────────────────────────────┤
│                 Models                      │
│                                             │
│       OpenAI / Anthropic / local / etc.     │
└─────────────────────────────────────────────┘
```

Copland should stay near the top.

It is the layer where work becomes organizationally legible.

---

## 32. Core domain model, directionally

A future Copland domain model may converge toward:

```text
Principal
  person | agent

Credential
  authenticates Principal

Client
  software currently using Credential

Board / Workspace
  scope of shared work

Task
  durable unit of work

Assignment
  durable responsibility for Task

Run
  one temporary execution by an Agent principal

Claim
  time-bounded execution lease held by Run

Comment / Message
  communication between Principals

Mention
  stable Principal reference inside communication

InboxEvent
  durable event addressed to Principal

Artifact
  structured output produced during work

Grant / Permission
  authority boundary

Event
  audit/history record
```

This is already enough to model surprisingly sophisticated mixed human/agent organizations.

Do not add more fundamental object types without pressure from real workflows.

---

## 33. Design invariants

These are worth treating as architectural laws until proven wrong.

### Identity is durable

A runtime restart does not create a new agent.

A token rotation does not create a new agent.

A model change does not create a new agent.

### Runs are ephemeral

A run can fail, complete, time out, or disappear.

The agent remains.

### Assignment survives execution failure

A crashed run should release/lose its claim.

It should not silently destroy task responsibility.

### Authority is evaluated live

Old credentials must not preserve authority that the owner or board has revoked.

### Agent identity is visibly non-human

Humans should always know whether an action came from a person or an agent.

### Client provenance is preserved

`berker/dev via Codex` is more useful than merely `berker/dev`.

### Run provenance is preserved where meaningful

Actions from a single execution should be groupable.

### Handles are presentation

Internal references use stable IDs.

### Runtimes are replaceable

No core domain object should require a particular model vendor or agent framework.

### Execution is optional

A Copland agent principal can exist even if Copland itself has no way to wake it automatically.

Polling/manual invocation is valid.

---

## 34. Near-term product milestone

A meaningful milestone could be called internally:

> **Bring Your Own Agent**

Definition of done:

1. Create an agent principal.
2. Issue a credential for it.
3. Connect an arbitrary MCP-capable client.
4. Assign a task to the agent.
5. Client discovers the assignment through a durable inbox.
6. Client starts a run.
7. Run claims the task.
8. Run comments/progresses work.
9. Run attaches an artifact.
10. Run finishes and releases claim.
11. Task remains attributable to durable agent identity.
12. Another agent can be mentioned and take over.
13. UI clearly shows principal, client, run, and output provenance.

If Copland can make that workflow boring and reliable, it has something.

---

## 35. Final direction

The project should continue moving toward an **agent-native coordination substrate**, not an agent runtime.

The best current internal thesis is:

> **Copland is the control plane where humans and arbitrary agents share work. It owns identity, authority, delegation, state, communication, and provenance. It does not own cognition or execution.**

The next architecture work should focus on:

```text
Run
Claim
Inbox/Event Queue
Stable Mentions
Artifacts
```

Then introduce execution bindings only when the polling-driven model is understood well enough to know what the abstraction actually needs.

The fact that Linear and Jira independently arrived at persistent agent identities plus sessions is strong evidence that the principal/run distinction is correct.

The fact that A2A, MCP, Temporal, LangGraph, Devin, Codex, Claude Code, and others occupy different layers is a reason for Copland to remain open and composable.

Do not build another Hermes.

Build the place where Hermes, Codex, Claude, Devin, scripts, and humans can all show up for work.

---

## Sources / current market references

Research checked 2026-10-02.

- Linear Agents: https://linear.app/developers/agents
- Linear Agent Interaction / AgentSession: https://linear.app/developers/agent-interaction
- Linear Agent Best Practices: https://linear.app/developers/agent-best-practices
- Linear AI Agents docs: https://linear.app/docs/agents-in-linear
- Jira agent collaboration: https://support.atlassian.com/jira-software-cloud/docs/collaborate-on-work-items-with-ai-agents/
- Jira agent overview: https://support.atlassian.com/jira-software-cloud/docs/work-with-ai-agents-in-jira/
- Atlassian Sep 2026 agent-session changes: https://confluence.atlassian.com/cloud/blog/2026/09/atlassian-cloud-changes-sep-14-to-sep-21-2026
- GitHub Copilot coding agent workflow: https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/
- GitHub Copilot coding agent overview: https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/
- GitHub enterprise agent management: https://docs.github.com/en/copilot/concepts/enterprise/agent-management
- Devin Linear automation example: https://docs.devin.ai/automation-templates/linear-ticket-implementation
- LangSmith assistants: https://docs.langchain.com/langsmith/configuration-cloud
- LangSmith runs: https://docs.langchain.com/langsmith/managed-deep-agents-api/runs/create-thread-run
- Temporal Durable AI: https://docs.temporal.io/ai
- A2A core concepts: https://a2a-protocol.org/latest/topics/key-concepts/
