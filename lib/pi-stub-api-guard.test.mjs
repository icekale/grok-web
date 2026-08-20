import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

test("API routes do not call foundation stubs that throw at runtime", () => {
  const forbidden = [
    /ModelRuntime/,
    /completeSimple/,
    /createAgentSessionFromServices/,
    /createAgentSessionServices/,
    /parseFrontmatter.*pi-stubs/,
    /from ["']@\/lib\/pi-stubs\/ai-compat["']/,
  ];
  const hits = [];
  for (const file of walk(join(process.cwd(), "app/api"))) {
    const source = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(source)) hits.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(hits, []);
});
