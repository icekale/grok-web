#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { constants: osConstants } = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pathToFileURL } = require("url");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseLaunchOptions } = require("./pi-web-options");

const pkgDir = path.join(__dirname, "..");

const { port, hostname, openBrowser } = parseLaunchOptions();

function importLib(name) {
  const compiled = path.join(pkgDir, "lib", `${name}.mjs`);
  const source = path.join(pkgDir, "lib", `${name}.ts`);
  return import(pathToFileURL(fs.existsSync(compiled) ? compiled : source).href);
}

async function main() {
  const { assertBindAllowed, isLoopbackHost } = await importLib("bind-guard");

  let password = process.env.GROK_WEB_PASSWORD;
  try {
    const { isWebPasswordEnabled } = await importLib("web-auth");
    password = process.env.GROK_WEB_PASSWORD || isWebPasswordEnabled();
  } catch {
    // Incomplete installs (and the CLI fixture) only see the env password.
  }

  try {
    assertBindAllowed(hostname, password);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  if (!isLoopbackHost(hostname) && process.env.GROK_WEB_PASSWORD) {
    console.warn(
      `Warning: grok-web is listening on ${hostname} with Basic Auth over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
    );
  }

  const serverEntry = path.join(pkgDir, ".output", "server", "index.mjs");
  if (!fs.existsSync(serverEntry)) {
    console.error(`Grok Web server output not found: ${serverEntry}`);
    process.exit(1);
  }

  const serverArgs = [serverEntry];

  // Always run the Nitro server entry with node directly — avoids .bin symlink
  // issues and path-with-spaces problems on Windows when shell: true is used.
  const child = spawn(process.execPath, serverArgs, {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    shell: false,
    env: {
      ...process.env,
      NITRO_HOST: hostname,
      NITRO_PORT: port,
      GROK_WEB_HOSTNAME: hostname,
    },
  });

  let browserOpened = false;
  let shuttingDown = false;
  let exited = false;
  let forceExitTimer;
  const url = `http://${hostname}:${port}`;

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (openBrowser && !browserOpened && /Listening on|Server listening/.test(text)) {
      browserOpened = true;
      const isWindows = process.platform === "win32";
      const isMac = process.platform === "darwin";
      // Avoid `shell: true` to suppress Node.js DEP0190 deprecation
      // ("Passing args to a child process with shell option true can lead to
      // security vulnerabilities, as the arguments are not escaped").
      // Pass a structured argv so Node.js handles escaping instead of
      // concatenating the args into a shell command string.
      let opener;
      if (isWindows) {
        // `start` is a cmd.exe built-in, so invoke cmd directly. The empty
        // title argument is required by `start` before the target URL.
        opener = spawn(process.env.ComSpec || "cmd.exe", ["/c", "start", "", url], {
          stdio: "ignore",
          detached: true,
        });
      } else if (isMac) {
        opener = spawn("open", [url], {
          stdio: "ignore",
          detached: true,
        });
      } else {
        opener = spawn("xdg-open", [url], {
          stdio: "ignore",
          detached: true,
        });
      }

      opener.on("error", (error) => {
        console.warn(`Could not open browser automatically: ${error.message}`);
      });

      opener.unref();
    }
  });

  const exitFromChild = (code, signal) => {
    exited = true;
    if (forceExitTimer) clearTimeout(forceExitTimer);
    process.exit(code ?? (signal ? 128 + (osConstants.signals[signal] || 1) : 0));
  };

  function shutdown(signal) {
    if (shuttingDown) {
      if (!exited) child.kill("SIGKILL");
      return;
    }
    shuttingDown = true;
    child.once("exit", exitFromChild);
    child.kill(signal);
    forceExitTimer = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, 5_000);
    forceExitTimer.unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  child.on("exit", (code, signal) => {
    exited = true;
    if (!shuttingDown) exitFromChild(code, signal);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
