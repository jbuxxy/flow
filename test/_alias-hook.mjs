// ESM hooks for `node --test`:
//   1. resolve  — makes the project's `@/*` -> `src/*` path alias (declared in
//      tsconfig.json, which Node does not read) work.
//   2. load     — transpiles `.tsx` files with the `typescript` compiler.
//      Node 22 strips plain `.ts` type syntax natively, but has no JSX support,
//      so a `.tsx` module anywhere in an import chain (e.g. report-pdf.tsx,
//      pulled in transitively by budget-plan.ts) would otherwise crash the run.
// Registered by _register.mjs so both hooks reach the test runner's workers.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = process.cwd();
const require = createRequire(pathToFileURL(`${projectRoot}/`));
/** @type {import("typescript") | null} */
let ts = null;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = resolvePath(projectRoot, "src", specifier.slice(2));
    const candidates = [base, `${base}.ts`, `${base}.tsx`, resolvePath(base, "index.ts")];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
  }
  // `next` ships its subpath entry points (next/navigation, next/headers, …)
  // as bare .js files with no package "exports" map — bundlers resolve the
  // extensionless import, Node's ESM resolver doesn't.
  if (/^next\/[\w-]+$/.test(specifier)) {
    return nextResolve(`${specifier}.js`, context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".tsx")) {
    ts ??= require("typescript");
    const source = readFileSync(fileURLToPath(url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        esModuleInterop: true,
      },
      fileName: fileURLToPath(url),
    });
    return { format: "module", shortCircuit: true, source: outputText };
  }
  return nextLoad(url, context);
}
