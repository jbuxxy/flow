// Loaded via `node --import ./test/_register.mjs`. A module passed to --import
// runs on the main thread, so it has to register the resolve hook itself for
// that hook to reach the test runner's worker threads (where the *.test.ts
// files actually execute).
import { register } from "node:module";

register("./_alias-hook.mjs", import.meta.url);
