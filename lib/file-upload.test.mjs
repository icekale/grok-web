import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
async function loadSubject() {
  return jiti.import("./file-upload.ts");
}

test("validates upload names without accepting paths or duplicates", async () => {
  const { validateUploadFileNames } = await loadSubject();

  assert.equal(validateUploadFileNames(["one.txt", "two file.md"]), null);
  assert.match(validateUploadFileNames(["../secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["folder\\secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["same.txt", "same.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames([]), /No files/);
});

test("finds conflicts and prevents replacing directories", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  fs.mkdirSync(path.join(root, "directory"));

  assert.deepEqual(
    inspectUploadTargets(root, ["new.txt", "file.txt", "directory"]),
    {
      conflicts: ["file.txt", "directory"],
      nonReplaceable: ["directory"],
    },
  );
});

test("prevents replacing symbolic links", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  try {
    fs.symlinkSync("file.txt", path.join(root, "link.txt"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.deepEqual(
    inspectUploadTargets(root, ["link.txt"]),
    {
      conflicts: ["link.txt"],
      nonReplaceable: ["link.txt"],
    },
  );
});

test("parses only supported conflict strategies", async () => {
  const { parseUploadConflictStrategy } = await loadSubject();

  assert.equal(parseUploadConflictStrategy(null), "error");
  assert.equal(parseUploadConflictStrategy("overwrite"), "overwrite");
  assert.equal(parseUploadConflictStrategy("skip"), "skip");
  assert.equal(parseUploadConflictStrategy("rename"), null);
});

function createTempRoot(t, prefix = "pi-web-upload-atomic-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function assertOwnedTempsAreZero(directory) {
  const tempNames = fs.readdirSync(directory).filter((name) => name.endsWith(".upload"));
  assert.equal(tempNames.length > 0, true);
  for (const name of tempNames) assert.equal(fs.statSync(path.join(directory, name)).size, 0);
}

test("atomically writes non-UTF8 bytes with a private same-directory temporary file", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const destination = path.join(root, "binary.dat");
  const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41]);
  let observedTempMode;
  let observedTempDirectory;

  await replaceUploadFileAtomic(
    root,
    "binary.dat",
    bytes,
    new Set([root]),
    "overwrite",
    {
      beforeCommit: async (tempPath) => {
        observedTempMode = fs.statSync(tempPath).mode & 0o777;
        observedTempDirectory = path.dirname(tempPath);
      },
    },
  );

  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.equal(observedTempDirectory, fs.realpathSync(root));
  if (process.platform !== "win32") assert.equal(observedTempMode, 0o600);
  assert.deepEqual(fs.readdirSync(root), ["binary.dat"]);
});

test("failed replacement preserves old bytes and scrubs its temporary inode", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const destination = path.join(root, "existing.dat");
  const oldBytes = Buffer.from([0x10, 0x00, 0xff]);
  fs.writeFileSync(destination, oldBytes);

  t.mock.method(fs.promises, "rename", async () => {
    const error = new Error("injected rename failure");
    error.code = "EIO";
    throw error;
  });

  await assert.rejects(
    replaceUploadFileAtomic(root, "existing.dat", Buffer.from("new"), new Set([root])),
    /injected rename failure/,
  );
  assert.deepEqual(fs.readFileSync(destination), oldBytes);
  assertOwnedTempsAreZero(root);
});

test("an exclusive-create collision never deletes the unowned temporary path", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const tempId = "occupied";
  const tempPath = path.join(fs.realpathSync(root), `.existing.dat.${tempId}.upload`);
  const foreignBytes = Buffer.from("belongs to another operation");
  fs.writeFileSync(tempPath, foreignBytes);

  await assert.rejects(
    replaceUploadFileAtomic(
      root,
      "existing.dat",
      Buffer.from("new"),
      new Set([root]),
      "overwrite",
      { tempId: () => tempId },
    ),
    (error) => error?.code === "EEXIST",
  );
  assert.deepEqual(fs.readFileSync(tempPath), foreignBytes);
  assert.equal(fs.existsSync(path.join(root, "existing.dat")), false);
});

test("a committed rename skips cleanup that could turn success into failure", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const rename = fs.promises.rename;
  let renameCalls = 0;
  let unlinkCalls = 0;

  await replaceUploadFileAtomic(
    root,
    "committed.dat",
    Buffer.from("new"),
    new Set([root]),
    "overwrite",
    {
      tempId: () => "committed",
      rename: async (from, to) => {
        renameCalls += 1;
        await rename(from, to);
      },
      unlink: async () => {
        unlinkCalls += 1;
        throw new Error("cleanup must not run after commit");
      },
    },
  );

  assert.equal(renameCalls, 1);
  assert.equal(unlinkCalls, 0);
  assert.equal(fs.readFileSync(path.join(root, "committed.dat"), "utf8"), "new");
});

test("committed hard link remains successful when transient unlink retries fail", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const tempId = "cleanup-fails";
  const tempPath = path.join(fs.realpathSync(root), `.committed.dat.${tempId}.upload`);
  const destination = path.join(root, "committed.dat");
  let unlinkCalls = 0;

  const result = await replaceUploadFileAtomic(
    root,
    "committed.dat",
    Buffer.from("committed bytes"),
    new Set([root]),
    "error",
    {
      tempId: () => tempId,
      unlink: async () => {
        unlinkCalls += 1;
        const error = new Error("injected busy unlink");
        error.code = "EBUSY";
        throw error;
      },
    },
  );

  assert.equal(result, "uploaded");
  assert.equal(unlinkCalls, 3);
  assert.equal(fs.readFileSync(destination, "utf8"), "committed bytes");
  assert.equal(fs.readFileSync(tempPath, "utf8"), "committed bytes");
  assert.equal(fs.statSync(destination).ino, fs.statSync(tempPath).ino);
});

test("hard-link cleanup never retries after its pathname is replaced", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const tempId = "cleanup-replaced";
  const tempPath = path.join(fs.realpathSync(root), `.committed.dat.${tempId}.upload`);
  const movedLink = path.join(root, "moved-upload-link");
  let unlinkCalls = 0;

  const result = await replaceUploadFileAtomic(
    root,
    "committed.dat",
    Buffer.from("committed bytes"),
    new Set([root]),
    "error",
    {
      tempId: () => tempId,
      unlink: async (filePath) => {
        unlinkCalls += 1;
        if (unlinkCalls === 1) {
          fs.renameSync(filePath, movedLink);
          fs.writeFileSync(filePath, "unrelated");
          const error = new Error("injected busy unlink");
          error.code = "EBUSY";
          throw error;
        }
        await fs.promises.unlink(filePath);
      },
    },
  );

  assert.equal(result, "uploaded");
  assert.equal(unlinkCalls, 1);
  assert.equal(fs.readFileSync(tempPath, "utf8"), "unrelated");
  assert.equal(fs.readFileSync(movedLink, "utf8"), "committed bytes");
  assert.equal(fs.readFileSync(path.join(root, "committed.dat"), "utf8"), "committed bytes");
});

test("authorized commit remains successful when lock release fails", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  let releaseCalls = 0;

  const result = await replaceUploadFileAtomic(
    root,
    "committed.dat",
    Buffer.from("committed bytes"),
    new Set([root]),
    "overwrite",
    {
      releaseLock: async (release) => {
        releaseCalls += 1;
        await release();
        throw new Error("injected release failure");
      },
    },
  );

  assert.equal(result, "uploaded");
  assert.equal(releaseCalls, 1);
  assert.equal(fs.readFileSync(path.join(root, "committed.dat"), "utf8"), "committed bytes");
});

test("authorized commit remains successful when handle closes fail", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  let tempCloseCalls = 0;
  let parentCloseCalls = 0;

  const result = await replaceUploadFileAtomic(
    root,
    "committed.dat",
    Buffer.from("committed bytes"),
    new Set([root]),
    "overwrite",
    {
      closeTemp: async (handle) => {
        tempCloseCalls += 1;
        await handle.close();
        throw new Error("injected temp close failure");
      },
      closeParent: async (handle) => {
        parentCloseCalls += 1;
        await handle.close();
        throw new Error("injected parent close failure");
      },
    },
  );

  assert.equal(result, "uploaded");
  assert.equal(tempCloseCalls, 1);
  assert.equal(parentCloseCalls, 1);
  assert.equal(fs.readFileSync(path.join(root, "committed.dat"), "utf8"), "committed bytes");
});

test("lock release failure before a commit remains an error", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  fs.writeFileSync(path.join(root, "existing.dat"), "old");

  await assert.rejects(
    replaceUploadFileAtomic(
      root,
      "existing.dat",
      Buffer.from("new"),
      new Set([root]),
      "skip",
      {
        releaseLock: async (release) => {
          await release();
          throw new Error("injected pre-commit release failure");
        },
      },
    ),
    /injected pre-commit release failure/,
  );
  assert.equal(fs.readFileSync(path.join(root, "existing.dat"), "utf8"), "old");
});

test("rejects directory and symbolic-link destinations without changing them", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const directory = path.join(root, "directory");
  const target = path.join(root, "target.txt");
  const link = path.join(root, "link.txt");
  fs.mkdirSync(directory);
  fs.writeFileSync(target, "old");
  try {
    fs.symlinkSync("target.txt", link);
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  await assert.rejects(
    replaceUploadFileAtomic(root, "directory", Buffer.from("new"), new Set([root])),
    /directory or symbolic link/i,
  );
  await assert.rejects(
    replaceUploadFileAtomic(root, "link.txt", Buffer.from("new"), new Set([root])),
    /directory or symbolic link/i,
  );
  assert.equal(fs.statSync(directory).isDirectory(), true);
  assert.equal(fs.readlinkSync(link), "target.txt");
  assert.equal(fs.readFileSync(target, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(root).sort(), ["directory", "link.txt", "target.txt"]);
});

test("rejects destinations outside allowed roots", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const outside = createTempRoot(t, "pi-web-upload-outside-");

  await assert.rejects(
    replaceUploadFileAtomic(outside, "file.txt", Buffer.from("new"), new Set([root])),
    /access denied/i,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a retargeted parent alias aborts with only a zero-byte owned temp", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const realDirectory = path.join(root, "real");
  const linkedDirectory = path.join(root, "linked");
  const outside = createTempRoot(t, "pi-web-upload-retarget-");
  fs.mkdirSync(realDirectory);
  try {
    fs.symlinkSync(realDirectory, linkedDirectory, "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  await assert.rejects(
    replaceUploadFileAtomic(
      linkedDirectory,
      "race.dat",
      Buffer.from("must stay inside"),
      new Set([root]),
      "overwrite",
      {
        beforeCommit: async () => {
          fs.unlinkSync(linkedDirectory);
          fs.symlinkSync(outside, linkedDirectory, "dir");
        },
      },
    ),
    /upload directory changed/i,
  );

  assert.equal(fs.existsSync(path.join(outside, "race.dat")), false);
  assert.deepEqual(fs.readdirSync(outside), []);
  const tempName = fs.readdirSync(realDirectory).find((name) => name.endsWith(".upload"));
  assert.equal(typeof tempName, "string");
  assert.equal(fs.statSync(path.join(realDirectory, tempName)).size, 0);
});

test("concurrent error writes serialize so exactly one reports a conflict", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const writes = ["first", "second"].map((value) =>
    replaceUploadFileAtomic(
      root,
      "exclusive.txt",
      Buffer.from(value),
      new Set([root]),
      "error",
    )
  );

  const results = await Promise.allSettled(writes);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.equal(rejection?.reason?.name, "UploadConflictError");
  assert.equal(["first", "second"].includes(fs.readFileSync(path.join(root, "exclusive.txt"), "utf8")), true);
  assert.deepEqual(fs.readdirSync(root), ["exclusive.txt"]);
});

test("repeated skip decisions under the lock create no temporary files", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const destination = path.join(root, "existing.txt");
  fs.writeFileSync(destination, "old");

  for (let index = 0; index < 5; index += 1) {
    const result = await replaceUploadFileAtomic(
      root,
      "existing.txt",
      Buffer.from(`new-${index}`),
      new Set([root]),
      "skip",
    );
    assert.equal(result, "skipped");
  }

  assert.equal(fs.readFileSync(destination, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(root), ["existing.txt"]);
});

test("skip rechecks a destination created immediately before commit", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const destination = path.join(root, "late.txt");

  const result = await replaceUploadFileAtomic(
    root,
    "late.txt",
    Buffer.from("new"),
    new Set([root]),
    "skip",
    {
      beforeCommit: async () => {
        fs.writeFileSync(destination, "old");
      },
    },
  );

  assert.equal(result, "skipped");
  assert.equal(fs.readFileSync(destination, "utf8"), "old");
  assertOwnedTempsAreZero(root);
});

for (const strategy of ["error", "skip"]) {
  test(`${strategy} never overwrites a non-locking creator at commit`, async (t) => {
    const { replaceUploadFileAtomic } = await loadSubject();
    const root = createTempRoot(t);
    const destination = path.join(root, "raced.txt");
    const link = fs.promises.link;
    let linkCalls = 0;

    const operation = replaceUploadFileAtomic(
      root,
      "raced.txt",
      Buffer.from("upload"),
      new Set([root]),
      strategy,
      {
        link: async (from, to) => {
          linkCalls += 1;
          fs.writeFileSync(to, "creator", { flag: "wx" });
          await link(from, to);
        },
      },
    );

    if (strategy === "error") {
      await assert.rejects(operation, (error) => error?.name === "UploadConflictError");
    } else {
      assert.equal(await operation, "skipped");
    }
    assert.equal(linkCalls, 1);
    assert.equal(fs.readFileSync(destination, "utf8"), "creator");
    assertOwnedTempsAreZero(root);
  });
}

test("rename-time parent swap leaves only a zero-byte escaped artifact", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const parent = path.join(root, "parent");
  const movedParent = path.join(root, "moved-parent");
  const outside = createTempRoot(t, "pi-web-upload-rename-race-");
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, "replace.txt"), "original");
  const rename = fs.promises.rename;
  try {
    fs.symlinkSync(outside, path.join(root, "symlink-check"), "dir");
    fs.unlinkSync(path.join(root, "symlink-check"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  await assert.rejects(
    replaceUploadFileAtomic(
      parent,
      "replace.txt",
      Buffer.from("escaped"),
      new Set([root]),
      "overwrite",
      {
        rename: async (from, to) => {
          fs.renameSync(parent, movedParent);
          fs.symlinkSync(outside, parent, "dir");
          await rename(path.join(movedParent, path.basename(from)), to);
        },
      },
    ),
    /escaped authorized directory/i,
  );

  assert.equal(fs.statSync(path.join(outside, "replace.txt")).size, 0);
  assert.equal(fs.readFileSync(path.join(movedParent, "replace.txt"), "utf8"), "original");
});

test("escaped cleanup does not delete an unrelated post-commit replacement", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const parent = path.join(root, "parent");
  const movedParent = path.join(root, "moved-parent");
  const outside = createTempRoot(t, "pi-web-upload-inode-race-");
  const outsideDestination = path.join(outside, "replace.txt");
  const escapedArtifact = path.join(outside, "escaped-artifact");
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, "replace.txt"), "original");
  const rename = fs.promises.rename;
  try {
    fs.symlinkSync(outside, path.join(root, "symlink-check"), "dir");
    fs.unlinkSync(path.join(root, "symlink-check"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  await assert.rejects(
    replaceUploadFileAtomic(
      parent,
      "replace.txt",
      Buffer.from("escaped"),
      new Set([root]),
      "overwrite",
      {
        rename: async (from, to) => {
          fs.renameSync(parent, movedParent);
          fs.symlinkSync(outside, parent, "dir");
          await rename(path.join(movedParent, path.basename(from)), to);
        },
        afterCommit: async () => {
          fs.linkSync(outsideDestination, escapedArtifact);
          fs.unlinkSync(outsideDestination);
          fs.writeFileSync(outsideDestination, "unrelated");
        },
      },
    ),
    /escaped authorized directory/i,
  );

  assert.equal(fs.readFileSync(outsideDestination, "utf8"), "unrelated");
  assert.equal(fs.statSync(escapedArtifact).size, 0);
  assert.equal(fs.readFileSync(path.join(movedParent, "replace.txt"), "utf8"), "original");
});

test("hard-link authorization failure leaves only zero-byte owned links", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const realDirectory = path.join(root, "real");
  const linkedDirectory = path.join(root, "linked");
  const outside = createTempRoot(t, "pi-web-upload-link-auth-");
  fs.mkdirSync(realDirectory);
  try {
    fs.symlinkSync(realDirectory, linkedDirectory, "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  await assert.rejects(
    replaceUploadFileAtomic(
      linkedDirectory,
      "linked.txt",
      Buffer.from("must not remain hidden"),
      new Set([root]),
      "error",
      {
        afterCommit: async () => {
          fs.unlinkSync(linkedDirectory);
          fs.symlinkSync(outside, linkedDirectory, "dir");
        },
      },
    ),
    /escaped authorized directory/i,
  );

  assert.equal(fs.statSync(path.join(realDirectory, "linked.txt")).size, 0);
  const tempName = fs.readdirSync(realDirectory).find((name) => name.endsWith(".upload"));
  assert.equal(typeof tempName, "string");
  assert.equal(fs.statSync(path.join(realDirectory, tempName)).size, 0);
});

test("parent swap never unlinks an unrelated stale temp pathname", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const parent = path.join(root, "parent");
  const movedParent = path.join(root, "moved-parent");
  const tempName = ".race.txt.fixed.upload";
  fs.mkdirSync(parent);

  await assert.rejects(
    replaceUploadFileAtomic(
      parent,
      "race.txt",
      Buffer.from("secret upload bytes"),
      new Set([root]),
      "overwrite",
      {
        tempId: () => "fixed",
        beforeCommit: async () => {
          fs.renameSync(parent, movedParent);
          fs.mkdirSync(parent);
          fs.writeFileSync(path.join(parent, tempName), "unrelated");
        },
      },
    ),
    /upload directory changed/i,
  );

  assert.equal(fs.readFileSync(path.join(parent, tempName), "utf8"), "unrelated");
  assert.equal(fs.statSync(path.join(movedParent, tempName)).size, 0);
});

test("unexpected link failure scrubs moved inode without unlinking stale temp path", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const parent = path.join(root, "parent");
  const movedParent = path.join(root, "moved-parent");
  const tempName = ".race.txt.fixed.upload";
  fs.mkdirSync(parent);

  await assert.rejects(
    replaceUploadFileAtomic(
      parent,
      "race.txt",
      Buffer.from("secret upload bytes"),
      new Set([root]),
      "error",
      {
        tempId: () => "fixed",
        link: async () => {
          fs.renameSync(parent, movedParent);
          fs.mkdirSync(parent);
          fs.writeFileSync(path.join(parent, tempName), "unrelated");
          const error = new Error("injected link failure");
          error.code = "EACCES";
          throw error;
        },
      },
    ),
    /injected link failure/,
  );

  assert.equal(fs.readFileSync(path.join(parent, tempName), "utf8"), "unrelated");
  assert.equal(fs.statSync(path.join(movedParent, tempName)).size, 0);
});

test("lock marker stays inside a writable upload directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX directory permissions are required for this test");
    return;
  }
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const readOnlyParent = path.join(root, "read-only");
  const uploadDirectory = path.join(readOnlyParent, "upload");
  fs.mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(readOnlyParent, 0o500);
  const startedAt = Date.now();

  try {
    await replaceUploadFileAtomic(
      uploadDirectory,
      "created.txt",
      Buffer.from("created"),
      new Set([root]),
      "error",
    );
  } finally {
    fs.chmodSync(readOnlyParent, 0o700);
  }

  assert.equal(fs.readFileSync(path.join(uploadDirectory, "created.txt"), "utf8"), "created");
  assert.equal(Date.now() - startedAt < 1_000, true);
  assert.deepEqual(fs.readdirSync(uploadDirectory), ["created.txt"]);
});

test("replacement preserves executable mode and new files use normal umask mode", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const executable = path.join(root, "script.sh");
  const created = path.join(root, "created.txt");
  fs.writeFileSync(executable, "old", { mode: 0o755 });
  fs.chmodSync(executable, 0o755);

  await replaceUploadFileAtomic(
    root,
    "script.sh",
    Buffer.from("new"),
    new Set([root]),
    "overwrite",
  );
  await replaceUploadFileAtomic(
    root,
    "created.txt",
    Buffer.from("new"),
    new Set([root]),
    "overwrite",
  );

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(executable).mode & 0o777, 0o755);
    assert.equal(fs.statSync(created).mode & 0o777, 0o666 & ~process.umask());
  }
});

test("concurrent replacements leave one complete payload and no temporary files", async (t) => {
  const { replaceUploadFileAtomic } = await loadSubject();
  const root = createTempRoot(t);
  const destination = path.join(root, "shared.dat");
  fs.writeFileSync(destination, "old");
  const payloads = Array.from(
    { length: 12 },
    (_, index) => Buffer.alloc(4096 + index, index + 1),
  );

  await Promise.all(payloads.map((bytes) =>
    replaceUploadFileAtomic(root, "shared.dat", bytes, new Set([root]))
  ));

  const result = fs.readFileSync(destination);
  assert.equal(payloads.some((bytes) => bytes.equals(result)), true);
  assert.deepEqual(fs.readdirSync(root), ["shared.dat"]);
});
