import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const OXLINT_BIN = resolve(REPO_ROOT, "node_modules/.bin/oxlint");
const CONFIG_PATH = resolve(REPO_ROOT, ".oxlintrc.json");

function lintSnippet(filename, code) {
  const dir = mkdtempSync(join(tmpdir(), "anvia-oxlint-"));
  const filePath = join(dir, filename);

  try {
    writeFileSync(filePath, code, "utf8");
    const stdout = execFileSync(OXLINT_BIN, ["-c", CONFIG_PATH, "--format", "json", filePath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return JSON.parse(stdout).diagnostics.map((diagnostic) => diagnostic.code);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      return JSON.parse(error.stdout).diagnostics.map((diagnostic) => diagnostic.code);
    }

    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("anvia/no-comments flags comments in TS but allows directives", () => {
  assert.ok(
    lintSnippet("a.ts", "// regular comment\nexport const x = 1;\n").includes("anvia(no-comments)"),
  );
  assert.ok(
    lintSnippet("b.ts", "/** jsdoc */\nexport const x = 1;\n").includes("anvia(no-comments)"),
  );
  assert.deepEqual(
    lintSnippet(
      "c.ts",
      "// oxlint-disable-next-line no-unused-vars\nconst x = 1;\nexport const y = 2;\n",
    ),
    [],
  );
});

test("anvia/no-conditional-spread flags conditional spreads", () => {
  assert.ok(
    lintSnippet(
      "a.ts",
      "export const f = (c: boolean) => ({ ...(c ? { a: 1 } : {}) });\n",
    ).includes("anvia(no-conditional-spread)"),
  );
  assert.deepEqual(
    lintSnippet("b.ts", "export const f = (a: Record<string, number>) => ({ ...a });\n"),
    [],
  );
});

test("anvia/no-barrel-file flags pure re-export files", () => {
  assert.ok(
    lintSnippet("barrel.ts", 'export { a } from "./a.js";\n').includes("anvia(no-barrel-file)"),
  );
  assert.deepEqual(lintSnippet("not-barrel.ts", "export const a = 1;\n"), []);
});

test("anvia/padded-if requires blank lines around if statements", () => {
  assert.ok(
    lintSnippet(
      "a.ts",
      "export function f(x: number) {\n  const y = x;\n  if (y > 0) return y;\n  return 0;\n}\n",
    ).includes("anvia(padded-if)"),
  );
  assert.deepEqual(
    lintSnippet(
      "b.ts",
      "export function f(x: number) {\n  const y = x;\n\n  if (y > 0) return y;\n\n  return 0;\n}\n",
    ),
    [],
  );
});

test("anvia/no-array-filter-map flags filter/map chains", () => {
  assert.ok(
    lintSnippet(
      "a.ts",
      "export const f = (xs: number[]) => xs.filter((x) => x > 0).map((x) => x * 2);\n",
    ).includes("anvia(no-array-filter-map)"),
  );
});

test("anvia/no-chained-type-assertions flags double casts in source", () => {
  assert.ok(
    lintSnippet("a.ts", "export const f = (x: string) => x as unknown as number;\n").includes(
      "anvia(no-chained-type-assertions)",
    ),
  );
  assert.deepEqual(
    lintSnippet("a.test.ts", "export const f = (x: string) => x as unknown as number;\n"),
    [],
  );
});

test("anvia/no-unknown-type-aliases flags aliases to unknown", () => {
  assert.ok(
    lintSnippet("a.ts", "export type Mystery = unknown;\n").includes(
      "anvia(no-unknown-type-aliases)",
    ),
  );
});

test("anvia/no-module-mocking flags vi.mock and jest.mock", () => {
  assert.ok(
    lintSnippet("a.ts", 'declare const vi: { mock(id: string): void };\nvi.mock("fs");\n').includes(
      "anvia(no-module-mocking)",
    ),
  );
});

test("anvia/no-reflect-get and anvia/no-reflect-apply flag Reflect helpers", () => {
  assert.ok(
    lintSnippet("a.ts", "export const f = (o: object) => Reflect.get(o, 'k');\n").includes(
      "anvia(no-reflect-get)",
    ),
  );
  assert.ok(
    lintSnippet(
      "b.ts",
      "export const f = (fn: () => void) => Reflect.apply(fn, null, []);\n",
    ).includes("anvia(no-reflect-apply)"),
  );
});

test("anvia/no-reduce-accumulator-copy flags accumulator copying in reduce", () => {
  assert.ok(
    lintSnippet(
      "a.ts",
      "export const f = (xs: number[]) => xs.reduce((acc, x) => acc.concat(x), [] as number[]);\n",
    ).includes("anvia(no-reduce-accumulator-copy)"),
  );
});
