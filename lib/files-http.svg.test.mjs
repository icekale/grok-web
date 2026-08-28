import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });

function segmentsFor(filePath) {
  return filePath.replace(/^\//, "").split("/");
}

test("SVG type=read is never a scriptable image/svg+xml document", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "grok-web-svg-"));
  const svgPath = join(dir, "evil.svg");
  writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n`);
  globalThis.__piAdditionalAllowedRoots ??= new Set();
  globalThis.__piAdditionalAllowedRoots.add(dir);
  globalThis.__piAllowedRootsCache = undefined;
  t.after(() => {
    globalThis.__piAdditionalAllowedRoots.delete(dir);
    globalThis.__piAllowedRootsCache = undefined;
  });

  const { GET } = await jiti.import("./files-http.ts");
  const response = await GET(
    new Request(`http://localhost/api/files/${segmentsFor(svgPath).join("/")}?type=read`),
    { params: Promise.resolve({ path: segmentsFor(svgPath) }) },
  );

  assert.equal(response.status, 200);
  const contentType = response.headers.get("content-type") ?? "";
  assert.doesNotMatch(contentType, /image\/svg\+xml/i);
  assert.match(contentType, /text\/plain|application\/octet-stream/);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment/i);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("PNG type=read stays an image and still sends nosniff", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "grok-web-png-"));
  const pngPath = join(dir, "ok.png");
  writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  globalThis.__piAdditionalAllowedRoots ??= new Set();
  globalThis.__piAdditionalAllowedRoots.add(dir);
  globalThis.__piAllowedRootsCache = undefined;
  t.after(() => {
    globalThis.__piAdditionalAllowedRoots.delete(dir);
    globalThis.__piAllowedRootsCache = undefined;
  });

  const { GET } = await jiti.import("./files-http.ts");
  const response = await GET(
    new Request(`http://localhost/api/files/${segmentsFor(pngPath).join("/")}?type=read`),
    { params: Promise.resolve({ path: segmentsFor(pngPath) }) },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /image\/png/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
