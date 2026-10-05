#!/usr/bin/env bash
# Run the automated test suite (pure business-logic unit tests, no DB).
#
# The host has no `node`, so tests run inside the already-built `flow-flow`
# image — Node 22 with native TypeScript type-stripping + the built-in
# `node:test` runner, plus the repo's own generated `@prisma/client` (needed
# only so the db-heavy modules import cleanly; nothing here touches Postgres).
# Same `-v "$(pwd)":/app -w /app` shape as the tsc / prisma-migrate commands
# documented in test/README.md.
#
# Usage:
#   scripts/test.sh                       # whole suite
#   scripts/test.sh test/lib/date.test.ts # one file (any glob works)
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${FLOW_TEST_IMAGE:-flow-flow}"
GLOB="${1:-test/**/*.test.ts}"

# TZ matches the deployed container (TZ=America/Denver) — the date logic is
# written around a household clock that sits behind UTC, and several tests
# pin exactly that boundary behavior.
exec docker run --rm \
  -v "$(pwd)":/app -w /app \
  -e TZ="${TZ:-America/Denver}" \
  -e ENCRYPTION_KEY="${ENCRYPTION_KEY:-0000000000000000000000000000000000000000000000000000000000000000}" \
  --entrypoint node "$IMAGE" \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --import ./test/_register.mjs --test "$GLOB"
