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

Terraform is the customer-facing format; Bicep is the one-click alternative. No Terraform for provisioning machines — direct ARM SDK calls and a reconciliation loop.

## Layout

```
apps/         control-plane, console, agent, cli
packages/     events, contracts, schema
infra/        terraform, bicep
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
| `docs/cloud-auth.md`  | OIDC federation, per-customer subject, RBAC scope              |
| `docs/access.md`      | Web terminal, SSH certificates, session tokens                 |
| `docs/lifecycle.md`   | Archive, snapshots, restore, offboarding, break-glass          |
| `docs/compliance.md`  | Events → checks → controls, the six v1 checks, evidence export |
| `docs/events.md`      | Full event catalogue                                           |
| `docs/frontend.md`    | Console structure, design tokens, LineageGutter                |
| `docs/spec.md`        | Reasoning behind every decision. Read when you need *why*      |

## Not in v1

No templates. No Tailscale. No AWS or GCP. No billing. No idle suspend. Six compliance checks, not more.

Never build: SSH public key upload, per-machine passwords or 2FA codes, shared machines, auto-correcting drift, code-server, application hosting.
