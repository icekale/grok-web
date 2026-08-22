import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("pins the TanStack toolchain after Next retirement", () => {
  assert.equal(pkg.dependencies.next, undefined);
  assert.equal(pkg.dependencies["@tanstack/react-start"], "1.168.42");
  assert.equal(pkg.dependencies["@tanstack/react-router"], "1.170.25");
  assert.equal(pkg.devDependencies.vite, "8.2.1");
  assert.equal(pkg.devDependencies["@vitejs/plugin-react"], "6.0.5");
  assert.equal(pkg.devDependencies.nitro, "3.0.260311-beta");
});

test("package metadata does not point clones at Pi Web", () => {
  assert.equal(pkg.name, "grok-web");
  const published = JSON.stringify({
    homepage: pkg.homepage,
    repository: pkg.repository,
    bugs: pkg.bugs,
  });
  assert.doesNotMatch(published, /pi-web|agegr\/pi-web|icekale\/pi-web/i);
});

test("uses TanStack commands and publication files as the final defaults", () => {
  assert.match(pkg.scripts.dev, /vite dev --configLoader runner --config vite\.tanstack\.config\.ts --host 127\.0\.0\.1 --port 30142/);
  assert.match(pkg.scripts.build, /pack-tanstack|build:tanstack:publication/);
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /next (dev|build|start)/);
  assert.ok(pkg.files.includes(".output"));
  assert.ok(!pkg.files.includes(".next"));
});

const viteConfig = await readFile(new URL("../vite.tanstack.config.ts", import.meta.url), "utf8");
const cleanupPlugin = await readFile(new URL("../src/plugins/acp-runtime-cleanup.ts", import.meta.url), "utf8");

test("registers one Nitro ACP cleanup plugin", () => {
  assert.match(viteConfig, /plugins:\s*\[\s*["']src\/plugins\/acp-runtime-cleanup\.ts["']\s*\]/);
  assert.match(cleanupPlugin, /definePlugin/);
  assert.match(cleanupPlugin, /hooks\.hook\(["']close["']/);
  assert.match(cleanupPlugin, /disposeAgentRuntime/);
});

test("requires an external production output and externalizes process-sensitive packages", () => {
  assert.match(viteConfig, /GROK_WEB_TANSTACK_OUTPUT_DIR/);
  assert.match(viteConfig, /isAbsolute/);
  assert.match(viteConfig, /ssr:\s*\{[\s\S]*external: EXTERNAL_PACKAGES/);
  assert.match(viteConfig, /noExternal: \["@lobehub\/icons"\]/);
  assert.match(viteConfig, /traceDeps: EXTERNAL_PACKAGES|traceDeps: outputMode === "standalone" \? EXTERNAL_PACKAGES/);
  assert.match(viteConfig, /output:\s*\{\s*dir: outputDir/);
  assert.doesNotMatch(viteConfig, /\.output/);
});

test("the config supports explicit standalone and publication output modes", () => {
  assert.match(viteConfig, /GROK_WEB_TANSTACK_OUTPUT_MODE/);
  assert.match(viteConfig, /standalone/);
  assert.match(viteConfig, /publication/);
  assert.match(viteConfig, /outputMode !== "standalone" && outputMode !== "publication"/);
  // Both modes externalize and copy the process-sensitive packages; the
  // publication stage drops the trace copy so npm install provides them.
  assert.match(viteConfig, /traceDeps: EXTERNAL_PACKAGES/);
  assert.match(viteConfig, /copyExternalPackages\(outputDir\)/);
  assert.match(viteConfig, /exportConditions: \["node", "import", "production", "default"\]/);
});
