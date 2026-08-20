import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import lockfile from "proper-lockfile";
import { isFilePathAllowed } from "./file-access";
import { samePath } from "./paths";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!fileName || fileName === "." || fileName === ".." || fileName.includes("\0")) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
      return `File names must not contain a path: ${fileName}`;
    }
    if (seen.has(fileName)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(fileName);
  }

  return null;
}

export function inspectUploadTargets(directory: string, fileNames: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];

  for (const fileName of fileNames) {
    const destination = path.join(directory, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    conflicts.push(fileName);
    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

const TRANSIENT_UNLINK_ERRORS = new Set(["EACCES", "EBUSY", "EINTR", "EPERM"]);

interface AtomicUploadOperations {
  tempId?: () => string;
  link?: (from: string, to: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  unlink?: (filePath: string) => Promise<void>;
  releaseLock?: (release: () => Promise<void>) => Promise<void>;
  closeTemp?: (handle: fs.promises.FileHandle) => Promise<void>;
  closeParent?: (handle: fs.promises.FileHandle) => Promise<void>;
  beforeCommit?: (tempPath: string) => Promise<void>;
  afterCommit?: (destination: string) => Promise<void>;
}

export class UploadConflictError extends Error {
  readonly nonReplaceable: boolean;

  constructor(nonReplaceable: boolean) {
    super("File already exists");
    this.name = "UploadConflictError";
    this.nonReplaceable = nonReplaceable;
  }
}

interface AuthorizedUploadParent {
  requestedPath: string;
  canonicalPath: string;
  handle: fs.promises.FileHandle;
  stat: fs.Stats;
  realRoots: Set<string>;
}

class UploadParentChangedError extends Error {
  constructor(cause?: unknown) {
    super("Upload directory changed during write", cause === undefined ? undefined : { cause });
  }
}

async function openAuthorizedUploadParent(
  directory: string,
  fileName: string,
  allowedRoots: Set<string>,
): Promise<AuthorizedUploadParent> {
  const validationError = validateUploadFileNames([fileName]);
  if (validationError) throw new Error(validationError);

  const requestedPath = path.resolve(directory);
  if (!isFilePathAllowed(path.join(requestedPath, fileName), allowedRoots)) {
    throw new Error("Access denied");
  }

  const canonicalPath = await fs.promises.realpath(requestedPath);
  const realRoots = new Set<string>();
  for (const root of allowedRoots) {
    try {
      realRoots.add(await fs.promises.realpath(root));
    } catch {
      // Ignore stale allowed roots.
    }
  }
  if (!isFilePathAllowed(path.join(canonicalPath, fileName), realRoots)) {
    throw new Error("Access denied");
  }

  const handle = await fs.promises.open(
    canonicalPath,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error("Upload target is not a directory");
    return { requestedPath, canonicalPath, handle, stat, realRoots };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertUploadParentUnchanged(parent: AuthorizedUploadParent): Promise<void> {
  try {
    const [currentRealPath, currentStat] = await Promise.all([
      fs.promises.realpath(parent.requestedPath),
      fs.promises.stat(parent.requestedPath),
    ]);
    if (
      !samePath(currentRealPath, parent.canonicalPath)
      || currentStat.dev !== parent.stat.dev
      || currentStat.ino !== parent.stat.ino
    ) {
      throw new UploadParentChangedError();
    }
  } catch (error) {
    if (error instanceof UploadParentChangedError) throw error;
    throw new UploadParentChangedError(error);
  }
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function committedDestinationIsAuthorized(
  parent: AuthorizedUploadParent,
  destination: string,
  committedStat: fs.Stats,
): Promise<boolean> {
  try {
    const [actualPath, currentStat] = await Promise.all([
      fs.promises.realpath(destination),
      fs.promises.lstat(destination),
    ]);
    await assertUploadParentUnchanged(parent);
    return sameInode(currentStat, committedStat)
      && samePath(path.dirname(actualPath), parent.canonicalPath)
      && isFilePathAllowed(actualPath, parent.realRoots);
  } catch {
    return false;
  }
}

export async function replaceUploadFileAtomic(
  directory: string,
  fileName: string,
  bytes: Uint8Array,
  allowedRoots: Set<string>,
  strategy: UploadConflictStrategy = "overwrite",
  operations: AtomicUploadOperations = {},
): Promise<"uploaded" | "skipped"> {
  const parent = await openAuthorizedUploadParent(directory, fileName, allowedRoots);
  const destination = path.join(parent.canonicalPath, fileName);
  const tempPath = path.join(parent.canonicalPath, `.${fileName}.${(operations.tempId ?? randomUUID)()}.upload`);
  let releaseLock: (() => Promise<void>) | undefined;
  let tempHandle: fs.promises.FileHandle | undefined;
  let ownsTemp = false;
  let committed = false;
  let hardLinkCommitted = false;
  let commitAuthorized = false;
  let committedStat: fs.Stats | undefined;
  let failure: unknown;
  let result: "uploaded" | "skipped" | undefined;

  try {
    await assertUploadParentUnchanged(parent);
    releaseLock = await lockfile.lock(parent.canonicalPath, {
      realpath: false,
      lockfilePath: path.join(parent.canonicalPath, ".grok-web-upload.lock"),
      retries: { retries: 8, factor: 2, minTimeout: 10, maxTimeout: 100, randomize: true },
      stale: 30_000,
    });
    await assertUploadParentUnchanged(parent);

    let destinationStat: fs.Stats | undefined;
    try {
      destinationStat = await fs.promises.lstat(destination);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    if (destinationStat) {
      const nonReplaceable = !destinationStat.isFile() || destinationStat.isSymbolicLink();
      if (strategy === "skip") {
        result = "skipped";
      } else if (strategy === "error") {
        throw new UploadConflictError(nonReplaceable);
      } else if (nonReplaceable) {
        throw new Error("Cannot replace a directory or symbolic link");
      }
    }

    if (result !== "skipped") {
      tempHandle = await fs.promises.open(
        tempPath,
        fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | fs.constants.O_WRONLY
          | (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      ownsTemp = true;
      await tempHandle.writeFile(bytes);
      await tempHandle.sync();
      await operations.beforeCommit?.(tempPath);
      await assertUploadParentUnchanged(parent);

      const finalMode = destinationStat
        ? destinationStat.mode & 0o777
        : 0o666 & ~process.umask();
      await tempHandle.chmod(finalMode);
      await tempHandle.sync();
      committedStat = await tempHandle.stat();
      await assertUploadParentUnchanged(parent);

      if (strategy === "overwrite") {
        // Keep the handle open across rename so the committed inode remains
        // identifiable even if the parent path is swapped during the call.
        await (operations.rename ?? fs.promises.rename)(tempPath, destination);
        committed = true;
        result = "uploaded";
      } else {
        try {
          await (operations.link ?? fs.promises.link)(tempPath, destination);
          committed = true;
          hardLinkCommitted = true;
          result = "uploaded";
        } catch (error) {
          if (errnoCode(error) !== "EEXIST") throw error;
          let nonReplaceable = false;
          try {
            const current = await fs.promises.lstat(destination);
            nonReplaceable = !current.isFile() || current.isSymbolicLink();
          } catch {
            // The creator may remove its entry again; still report the
            // no-overwrite collision rather than retrying destructively.
          }
          if (strategy === "error") throw new UploadConflictError(nonReplaceable);
          result = "skipped";
        }
      }

      if (committed) {
        await operations.afterCommit?.(destination);
        if (!await committedDestinationIsAuthorized(parent, destination, committedStat)) {
          await tempHandle.truncate(0);
          await tempHandle.sync();
          await (operations.closeTemp ?? ((handle) => handle.close()))(tempHandle);
          tempHandle = undefined;
          throw new Error("Committed upload escaped authorized directory");
        }
        commitAuthorized = true;
      }
    }
  } catch (error) {
    failure = error;
  }

  if (tempHandle) {
    if (!commitAuthorized) {
      try {
        await tempHandle.truncate(0);
        await tempHandle.sync();
      } catch (containmentError) {
        failure = containmentError;
      }
    }
    try {
      await (operations.closeTemp ?? ((handle) => handle.close()))(tempHandle);
      tempHandle = undefined;
    } catch (error) {
      if (!commitAuthorized) failure ??= error;
    }
  }
  // Security tradeoff: Node has no unlinkat/conditional-unlink API. On any
  // failed or non-committed operation, leave a zero-byte orphan rather than
  // unlinking a stale pathname that may now belong to another file.
  if (ownsTemp && hardLinkCommitted && commitAuthorized) {
    const unlink = operations.unlink ?? fs.promises.unlink;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        try {
          await assertUploadParentUnchanged(parent);
          if (!committedStat || !sameInode(await fs.promises.lstat(tempPath), committedStat)) break;
        } catch {
          break;
        }
      }
      try {
        await unlink(tempPath);
        ownsTemp = false;
        break;
      } catch (error) {
        const code = errnoCode(error);
        if (code === "ENOENT") {
          ownsTemp = false;
          break;
        }
        if (!code || !TRANSIENT_UNLINK_ERRORS.has(code)) break;
      }
    }
  }
  if (releaseLock) {
    try {
      await (operations.releaseLock ?? ((release) => release()))(releaseLock);
    } catch (error) {
      if (!commitAuthorized) failure ??= error;
    }
  }
  try {
    await (operations.closeParent ?? ((handle) => handle.close()))(parent.handle);
  } catch (error) {
    if (!commitAuthorized) failure ??= error;
  }

  if (failure) throw failure;
  return result ?? "uploaded";
}
