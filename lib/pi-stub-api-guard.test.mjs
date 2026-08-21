import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      && !entry.name.endsWith(".test.ts")
      && !entry.name.endsWith(".test.tsx")
    ) {
      files.push(path);
    }
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
    /from ["']@\/lib\/pi-stubs\//,
  ];
  const hits = [];
  for (const file of walk(join(process.cwd(), "src/routes/api")).concat(
    walk(join(process.cwd(), "lib")).filter((path) => path.endsWith("-http.ts")),
  )) {
    const source = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(source)) hits.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("lib and hooks do not import pi-stubs except grokHome wrappers", () => {
  const allowed = new Set([
    "lib/pi-stubs/coding-agent.ts", // leftover getAgentDir only; Task 6 deletes the directory
    "lib/rpc-manager.ts", // Task 5 deletes rpc-manager; not a permanent exception
  ]);
  const hits = [];
  for (const file of walk(join(process.cwd(), "lib")).concat(walk(join(process.cwd(), "hooks")))) {
    if (file.includes("/pi-stubs/")) continue;
    const source = readFileSync(file, "utf8");
    if (source.includes("lib/pi-stubs") || source.includes("pi-stubs/")) {
      hits.push(relative(process.cwd(), file));
    }
  }
  assert.deepEqual(
    hits.filter((h) => !h.endsWith(".test.mjs") && !allowed.has(h)),
    [],
  );
});
