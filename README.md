# Cloudable

Persistent, governed cloud Linux machines. One per person, provisioned from identity, controlled by
policy, evidenced for audit. Azure only. MIT.

The buyer answers the auditor. This is not a developer productivity tool.

Read `CLAUDE.md` first — it holds the invariants everything else is built against. Read `docs/spec.md`
for the reasoning behind every decision, and the table in `CLAUDE.md` for which other `docs/*.md`
file covers which area.

## Stack

TypeScript + Bun throughout. Control plane: Effect v3, Drizzle, PostgreSQL, BetterAuth. Frontend:
React, Vite, TanStack Router + Query, shadcn/ui, Tailwind. Agent and CLI compiled via
`bun build --compile`.

## Layout

```
apps/         control-plane, console, agent, cli
packages/     events, contracts, schema
infra/        terraform
docs/
```

## Local development

```bash
bun install
docker compose up -d
bun run db:migrate
bun run dev
```

Control plane on `http://localhost:4780`, console on `http://localhost:5180`. See `.env.example`.

## CLI

`cloudable` is the command-line client for a control plane. `cable` is an alias for it — the same
program under a shorter name.

From a checkout:

```bash
bun link --cwd apps/cli          # puts both `cloudable` and `cable` on PATH
export CLOUDABLE_API_URL=https://cloudable.example.com
cloudable auth login
cloudable machines list
```

From a release: take `cloudable-cli-linux-x64` or `-arm64` off the GitHub release, put it on your
PATH as `cloudable`, and symlink the alias next to it.

```bash
chmod +x cloudable-cli-linux-x64
sudo install cloudable-cli-linux-x64 /usr/local/bin/cloudable
sudo ln -s cloudable /usr/local/bin/cable
```

Releases are built for Linux only. On macOS or Windows, use the checkout.

`cloudable help` lists every command, `cloudable <command> --help` explains one, and
`cloudable version` says which build you are on. `cloudable connect <machine>` opens a terminal on a
machine; read `docs/access.md` for how that reaches it without any inbound port.
