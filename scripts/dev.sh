#!/usr/bin/env bash
# Run the Next.js dev server against this box's real Postgres, for visual
# verification in a browser before shipping — the host has no `node`, so
# this runs inside the already-built `flow-flow` image (same trick as
# scripts/test.sh), bind-mounting the live repo over the image's own
# node_modules.
#
# --network host: the container needs to reach Postgres at the host's
# 127.0.0.1:5432 (see .env's DATABASE_URL — same instance production uses,
# see WORKING_ON.md's ".env footgun" note) and expose :3000 directly as
# localhost:3000, no port mapping needed on Linux.
#
# This points at the REAL household database, same as every manual
# verification done via the deployed container — a bug clicked through here
# can write bad data same as prod. Nothing here is a sandboxed copy.
#
# --user "$(id -u):$(id -g)": without this, the container's default `flow`
# user (uid 1001) can't read the bind-mounted .env (mode 600, host-owned)
# and Next/Turbopack's dev cache under .next/ ends up root-owned, breaking
# every later run with a lockfile permission error. If .next/ ever gets
# corrupted this way again (e.g. from a manual `docker run` without
# --user), it can't be `rm -rf`'d as a normal user either — fix with
# `docker run --rm -v "$(pwd)":/app alpine rm -rf /app/.next` (root inside
# the container can remove it regardless of host ownership).
#
# Usage: scripts/dev.sh
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${FLOW_TEST_IMAGE:-flow-flow}"

exec docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v "$(pwd)":/app -w /app \
  --network host \
  --env-file .env \
  --entrypoint npm "$IMAGE" \
  run dev
