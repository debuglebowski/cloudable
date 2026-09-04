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
