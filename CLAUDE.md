# Flow

If [WORKING_ON.md](./WORKING_ON.md) exists, read it first — architecture,
deploy mechanics, data conventions, and past incidents worth not repeating.
Keep it updated when something in it changes. (It's the maintainer's private
dev journal and isn't part of the public repository.)

## Tests

`scripts/test.sh` runs the pure-logic unit suite (`test/lib/*.test.ts`) inside
the `flow-flow` image — no host Node, no DB, no dependencies. With Node 22
installed, `npm test` runs the same suite (CI does this — see
`.github/workflows/ci.yml`). Run it (and add a
regression case) when you touch anything in `src/lib`. See
[test/README.md](./test/README.md).
