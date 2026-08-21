import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const home = mkdtempSync(join(tmpdir(), "grok-web-shot-"));
writeFileSync(
  join(home, "grok-web-projects.json"),
  `${JSON.stringify({
    version: 1,
    projects: [{
      path: root,
      name: "grok-web",
      pinned: false,
      archived: false,
      removed: false,
      order: 0,
    }],
  }, null, 2)}\n`,
);

const result = spawnSync("npm", ["run", "test:e2e"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    GROK_HOME: home,
    GROK_WEB_UPDATE_SCREENSHOTS: "1",
    GROK_WEB_E2E_PORT: process.env.GROK_WEB_E2E_PORT || "30144",
  },
});

process.exit(result.status ?? 1);
