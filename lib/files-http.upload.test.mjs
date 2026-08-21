import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const routeSource = await readFile(new URL("./files-http.ts", import.meta.url), "utf8");
const adapterSource = await readFile(new URL("../src/routes/api/files/$.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });

function segmentsFor(filePath) {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

function uploadRequest(directory, name, content, conflict = "error") {
  const form = new FormData();
  form.append("files", new File([content], name));
  return new Request(`http://localhost/api/files/${segmentsFor(directory).join("/")}?type=upload&conflict=${conflict}`, {
    method: "POST",
    headers: { host: "localhost" },
    body: form,
  });
}

function uploadBatchRequest(directory, files, conflict = "error") {
  const form = new FormData();
  for (const [name, content] of files) form.append("files", new File([content], name));
  return new Request(`http://localhost/api/files/${segmentsFor(directory).join("/")}?type=upload&conflict=${conflict}`, {
    method: "POST",
    headers: { host: "localhost" },
    body: form,
  });
}

test("files route uses standard Web request and response APIs", () => {
  assert.doesNotMatch(routeSource, /next\/server|NextRequest|NextResponse|\.nextUrl/);
  assert.match(routeSource, /Response\.json/);
  assert.match(routeSource, /new URL\(request\.url\)\.searchParams/);
});

test("TanStack files route adapts the splat to decoded path segments", () => {
  assert.match(adapterSource, /params\._splat \?\? ""\)\.split\("\/"\)/);
  assert.match(adapterSource, /postFiles\(request/);
});

test("multipart upload writes exact binary bytes; conflict and size still apply", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-tanstack-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { allowFileRoot } = await jiti.import("./file-access.ts");
  const { POST } = await jiti.import("./files-http.ts");
  allowFileRoot(root);

  const context = { params: Promise.resolve({ path: segmentsFor(root) }) };
  const bytes = Uint8Array.from([0x00, 0xff, 0xfe, 0x80, 0x41]);
  const created = await POST(uploadRequest(root, "proof.dat", bytes), context);
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { uploaded: ["proof.dat"], skipped: [], errors: [] });
  assert.deepEqual(fs.readFileSync(path.join(root, "proof.dat")), Buffer.from(bytes));

  fs.writeFileSync(path.join(root, "proof.txt"), "existing");
  const conflict = await POST(uploadRequest(root, "proof.txt", "replacement"), context);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    error: "One or more files already exist",
    conflicts: ["proof.txt"],
    nonReplaceable: [],
  });

  const oversized = new Request(`http://localhost/api/files/${segmentsFor(root).join("/")}?type=upload&conflict=error`, {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "multipart/form-data; boundary=x",
      "content-length": String(102 * 1024 * 1024),
    },
    body: "--x--\r\n",
  });
  const rejected = await POST(oversized, context);
  assert.equal(rejected.status, 413);
  assert.deepEqual(await rejected.json(), { error: "Uploads must total 100MB or less" });
});

test("overwrite and skip preserve response semantics", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-conflicts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { allowFileRoot } = await jiti.import("./file-access.ts");
  const { POST } = await jiti.import("./files-http.ts");
  allowFileRoot(root);
  fs.writeFileSync(path.join(root, "proof.txt"), "old");
  const context = { params: Promise.resolve({ path: segmentsFor(root) }) };

  const skipped = await POST(uploadRequest(root, "proof.txt", "ignored", "skip"), context);
  assert.equal(skipped.status, 200);
  assert.deepEqual(await skipped.json(), { uploaded: [], skipped: ["proof.txt"], errors: [] });
  assert.equal(fs.readFileSync(path.join(root, "proof.txt"), "utf8"), "old");

  const replaced = await POST(uploadRequest(root, "proof.txt", "new", "overwrite"), context);
  assert.equal(replaced.status, 200);
  assert.deepEqual(await replaced.json(), { uploaded: ["proof.txt"], skipped: [], errors: [] });
  assert.equal(fs.readFileSync(path.join(root, "proof.txt"), "utf8"), "new");
});

test("partial batch failures return 207 while writing valid files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-partial-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { allowFileRoot } = await jiti.import("./file-access.ts");
  const { POST } = await jiti.import("./files-http.ts");
  allowFileRoot(root);
  fs.mkdirSync(path.join(root, "directory"));
  const context = { params: Promise.resolve({ path: segmentsFor(root) }) };

  const response = await POST(uploadBatchRequest(root, [
    ["valid.dat", Uint8Array.from([0xff, 0x00, 0x7f])],
    ["directory", "cannot replace"],
  ], "overwrite"), context);

  assert.equal(response.status, 207);
  assert.deepEqual(await response.json(), {
    uploaded: ["valid.dat"],
    skipped: [],
    errors: [{ name: "directory", error: "Cannot replace a directory or symbolic link" }],
  });
  assert.deepEqual(fs.readFileSync(path.join(root, "valid.dat")), Buffer.from([0xff, 0x00, 0x7f]));
  assert.equal(fs.statSync(path.join(root, "directory")).isDirectory(), true);
});

test("error batch preflight writes nothing when any member conflicts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { allowFileRoot } = await jiti.import("./file-access.ts");
  const { POST } = await jiti.import("./files-http.ts");
  allowFileRoot(root);
  fs.writeFileSync(path.join(root, "existing.txt"), "old");
  const context = { params: Promise.resolve({ path: segmentsFor(root) }) };

  const response = await POST(uploadBatchRequest(root, [
    ["new.txt", "must not be written"],
    ["existing.txt", "must not replace"],
  ], "error"), context);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "One or more files already exist",
    conflicts: ["existing.txt"],
    nonReplaceable: [],
  });
  assert.equal(fs.existsSync(path.join(root, "new.txt")), false);
  assert.equal(fs.readFileSync(path.join(root, "existing.txt"), "utf8"), "old");
});

test("concurrent error uploads produce one success and one locked conflict", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { allowFileRoot } = await jiti.import("./file-access.ts");
  const { POST } = await jiti.import("./files-http.ts");
  allowFileRoot(root);
  const context = { params: Promise.resolve({ path: segmentsFor(root) }) };

  const responses = await Promise.all([
    POST(uploadRequest(root, "exclusive.txt", "first", "error"), context),
    POST(uploadRequest(root, "exclusive.txt", "second", "error"), context),
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(["first", "second"].includes(fs.readFileSync(path.join(root, "exclusive.txt"), "utf8")), true);
});
