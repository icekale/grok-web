import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("CI runs deterministic ACP browser E2E and uploads only redacted evidence", () => {
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /npm run test:e2e:acp/);
  assert.match(workflow, /path: \.artifacts\/e2e\//);
  assert.doesNotMatch(workflow, /test:e2e:live/);
  assert.doesNotMatch(workflow, /GROK_WEB_LIVE_E2E_HOME/);
});
