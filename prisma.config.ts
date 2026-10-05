import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
    // Only used by `migrate dev` (local schema iteration). Plain env lookup
    // (not the strict `env()` helper) so `generate`/`migrate deploy` — which
    // don't need it — don't fail when it's unset, e.g. in the Docker build.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
