#!/usr/bin/env bash
# `bun run test:integration` for this package: every suite that needs a real Postgres or
# Docker, except the two that cost money or minutes.
#
# 1. reconcile-diff.integration.ts, plus the `*.test.ts` files that guard on
#    `isDbReachable`. They run against DATABASE_URL, which must be migrated
#    (docker compose up -d, then bun run db:migrate). They also run under `test:unit`,
#    where they skip when no such database is reachable. Here reconcile-diff fails
#    without one, so the run cannot pass with those files silently skipped.
# 2. The `*.integration-check.ts` files. Each starts its own throwaway Postgres through
#    testcontainers, so they only need Docker.
#
# Left out on purpose:
# - ProvisioningService.azure.integration-check.ts creates and bills a real VM whenever
#   AZURE_SUBSCRIPTION_ID and AZURE_MACHINES_SUBNET_ID are set in the environment. Run it
#   by hand, against a subscription meant for it.
# - ProvisioningService.docker.integration-check.ts builds two binaries and an image.
#   `test:docker-provisioning` runs it.
#
# Two `bun test` runs, not one: the second set starts its own databases and should not
# share a process (or `config`) with the first.
set -euo pipefail
cd "$(dirname "$0")/.."

# Unquoted on purpose: these are lists of paths with no spaces, and `bun test` needs each
# as its own argument. The leading `./` makes bun read an argument as a path, not a filter.
db_files=$(grep -rl --include='*.test.ts' 'testing/db-reachable' ./src)
check_files=$(find ./src ./test -name '*.integration-check.ts' \
  ! -name 'ProvisioningService.azure.integration-check.ts' \
  ! -name 'ProvisioningService.docker.integration-check.ts')

# shellcheck disable=SC2086
bun test ./src/services/reconcile-diff.integration.ts $db_files
# shellcheck disable=SC2086
bun test $check_files
