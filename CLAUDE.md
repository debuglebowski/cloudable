# SlayZone Environment

You are an agent running inside a [SlayZone](https://slayzone.com) task. Other agents may be running in their own tasks in parallel, and a human or another agent can reach you through this terminal at any time.

## Interact with SlayZone

If useful, you have a toolbox for acting on SlayZone itself. You can:

- create and update tasks, and spawn sub-tasks with their own agents
- attach assets, run processes, open web panels, set up automations
- change your own task's state

The toolbox is the `slay` CLI. When you omit the task-id, most `slay` commands auto-resolve to your current task: `$SLAYZONE_TASK_ID` is used if set, otherwise the task bound to `$SLAYZONE_SESSION_ID` (always set in a task terminal) is looked up. Trust the resolution: just run the command, don't check or echo the env vars, and pass an explicit task-id only when you deliberately target a different task. **Load the `slay` skill before running any `slay` command** — it holds the full reference of commands, flags, and domain-specific guides. Never guess subcommands or flags.

# Cloudable

Persistent, governed cloud Linux machines. One per person, provisioned from identity, controlled by policy, evidenced for audit. Azure only. MIT.

The buyer answers the auditor. This is not a developer productivity tool.

## Invariants

Never violate these. If one seems wrong, stop and say so — do not work around it.

1. No cloud credential is ever stored. Federation only, never client secrets.
2. Events are append-only. No updates, no deletes. Retention is expiry.
3. A machine has exactly one owner, always a person. No shared or unowned machines.
4. Reconcile only closes gaps. It removes undeclared software, never installs.
5. Drift is flagged, never auto-corrected.
6. Machines are archived, never deleted. Data expires; the record is permanent.
7. No inbound access to any machine. Agents poll; tunnels are outbound.
8. Cloudable injects secrets, never stores them.
9. The CA private key never enters the control plane. Sign operations only.
10. Desired state is edited; live machines are not.
11. Event type names are a public interface. Additive only, no renaming.
12. The agent never submits audit events. It reports state; the control plane derives.

## Stack

TypeScript + Bun throughout. Control plane: Effect v3, Drizzle, PostgreSQL, BetterAuth. Frontend: React, Vite, TanStack Router + Query, shadcn/ui, Tailwind. Agent and CLI compiled via `bun build --compile`.

Terraform only for deploy infrastructure — no Bicep. No Terraform for provisioning machines — direct ARM SDK calls and a reconciliation loop.

## Distribution

Open source, self-hosted only. There is no Cloudable-hosted production environment. The only
release artifact is the control-plane container image, built and published (publicly, no pull
credential required) by CI on every push to main — that is the entire CD story. A published npm
package for the image to depend on is a possible later addition, not v1.

## Layout

```
apps/         control-plane, console, agent, cli
packages/     events, contracts, schema
infra/        terraform
docs/

```

`packages/events` is the single source of truth for the catalogue. Its snapshot test must fail on any rename or removal.

## Terminology

`machine`, never "workspace". **Compliance checks**, never "tests".

## Docs

Read the relevant file before working in that area.

| File                  | Covers                                                         |
| :-------------------- | :------------------------------------------------------------- |
| `docs/inheritance.md` | org → template → machine, package manifest, overrides, pinning |
| `docs/agents.md`      | Control agent, tunnel daemon, wire protocol, attestation       |
| `docs/cloud-auth.md`  | Self-hosted managed identity (the real path), RBAC scope, why BYOC federation was removed |
| `docs/access.md`      | Web terminal, SSH certificates, session tokens                 |
| `docs/lifecycle.md`   | Archive, snapshots, restore, offboarding, break-glass          |
| `docs/compliance.md`  | Events → checks → controls, the six v1 checks, evidence export |
| `docs/events.md`      | Full event catalogue                                           |
| `docs/frontend.md`    | Console structure, design tokens, LineageGutter                |
| `docs/spec.md`        | Reasoning behind every decision. Read when you need *why*      |

## Not in v1

No templates. No Tailscale. No AWS or GCP. No billing. No idle suspend. Six compliance checks, not more.

Never build: SSH public key upload, per-machine passwords or 2FA codes, shared machines, auto-correcting drift, code-server, application hosting.