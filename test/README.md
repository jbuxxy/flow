# Tests

Pure-logic unit tests for `src/lib`. No database, no network, no framework —
just Node's built-in `node:test` runner and `node:assert/strict`.

## Running

```bash
scripts/test.sh                        # whole suite
scripts/test.sh test/lib/date.test.ts  # one file (any glob)
```

The host has no `node`, so this runs inside the already-built `flow-flow`
image (`docker compose build`) — Node 22 with native TypeScript
type-stripping — mounting the repo at `/app`. `TZ=America/Denver` and a
throwaway `ENCRYPTION_KEY` are set to match the deployed container.

Type-check the test files separately (they use `.ts` import specifiers, which
the root `tsconfig.json` — tuned for `next build` — disallows):

```bash
docker run --rm -v "$(pwd)":/app -w /app --entrypoint node flow-flow \
  node_modules/typescript/lib/tsc.js -p test/tsconfig.json
```

## How it works

- `_alias-hook.mjs` — an ESM `resolve` hook mapping `@/x` → `src/x`, plus a
  `load` hook that runs the `typescript` compiler on `.tsx` files (Node strips
  plain `.ts` types itself but has no JSX support, and a `.tsx` module shows up
  transitively via `budget-plan.ts` → `reports.ts` → `report-pdf.tsx`).
- `_register.mjs` — registers that hook (a `--import`ed module has to call
  `register()` itself for the hook to reach the runner's worker threads).
- `helpers.ts` — fixture builders (`debt()`, `income()`, `spendTx()`, `utc()`).

Importing a `src/lib` module that imports `@/lib/db` is fine — Prisma's pg
adapter is lazy, so nothing connects. That's why db-heavy modules
(`buckets.ts`, `recurring-bills.ts`, `debt-payments.ts`, …) can have their
pure exports tested directly with no mocking.

## Adding a test

One file per source module, under `test/lib/`. Put regression cases for a
fixed bug in a `describe("regressions", …)` block and cite the date/context
of the bug in a comment, so the assertion is traceable to the behavior it
protects.

## Scope

Pure functions only. DB-integration tests (against a throwaway Postgres) and
Playwright e2e are deliberately out of scope for now.
