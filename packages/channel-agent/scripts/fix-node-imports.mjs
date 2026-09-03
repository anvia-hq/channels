import { readFile, writeFile } from "node:fs/promises";

// tsup normalizes node: imports to bare specifiers. Bare "sqlite" does not
// resolve on Node — only "node:sqlite" exists — so restore the prefix.
const file = new URL("../dist/index.js", import.meta.url);
const code = (await readFile(file, "utf8")).replaceAll('from "sqlite"', 'from "node:sqlite"');
if (code.includes('from "sqlite"')) {
  throw new Error("Unresolved bare sqlite import remains in dist/index.js");
}
await writeFile(file, code);
console.log("Restored node:sqlite import in dist/index.js");
