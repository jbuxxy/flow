import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Reading a *fresh* `new Date()` as a calendar day through the UTC getters (or
// toISOString().slice) is the "everything shows a day ahead" bug we keep
// hitting: the server runs TZ=America/Denver, so in the household's evening a
// bare `new Date()` is already on tomorrow's UTC date (and, on a month's last
// evening, next month). "What day is it now" must come from the household's
// local clock — use `todayAsUTCDate()` / `currentDateKey()` / `currentPeriodKey()`
// from src/lib/{date,period}.ts. See WORKING_ON.md's "Core data conventions"
// and test/lib/timezone-regression.test.ts.
const noNowAsUtcCalendarDay = {
  files: ["src/**/*.{ts,tsx,mts}"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "CallExpression[callee.object.type='NewExpression'][callee.object.callee.name='Date'][callee.object.arguments.length=0][callee.property.name=/^getUTC(FullYear|Month|Date|Day)$/]",
        message:
          "`new Date().getUTC*` reads 'now' as a UTC calendar day — a day ahead in the household's evening. Use todayAsUTCDate() (src/lib/date.ts).",
      },
      {
        selector:
          "CallExpression[callee.property.name='slice'][callee.object.type='CallExpression'][callee.object.callee.property.name='toISOString'][callee.object.callee.object.type='NewExpression'][callee.object.callee.object.callee.name='Date'][callee.object.callee.object.arguments.length=0]",
        message:
          "`new Date().toISOString().slice(...)` derives a date key from 'now' in UTC — a day ahead in the household's evening. Use currentDateKey() / currentPeriodKey() (src/lib/period.ts).",
      },
    ],
  },
};

// A destructured field pulled out only to exclude it from a `...rest` spread
// (e.g. PasswordInput's `type: _type` stripping the hardcoded `type` prop out
// of `...props` before it reaches the real <input>) is deliberately unused —
// same idea as an underscore-prefixed callback param that's never read, just
// on the object-destructuring side instead. Without ignoreRestSiblings/the
// `^_` patterns, eslint-config-next's default no-unused-vars settings flag
// both as real dead code.
const unusedVarsIntentionalOmission = {
  files: ["src/**/*.{ts,tsx,mts}"],
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
    ],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  noNowAsUtcCalendarDay,
  unusedVarsIntentionalOmission,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
