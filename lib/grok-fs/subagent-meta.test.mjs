import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listSubagentMetas } from "./subagent-meta.ts";

describe("listSubagentMetas", () => {
  it("reads meta.json under a parent session subagents directory", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-sub-meta-"));
    const dir = join(root, "subagents", "child-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({
      subagent_id: "child-1",
      parent_session_id: "root-1",
      child_session_id: "child-1",
      subagent_type: "explore",
      description: "look around",
      status: "completed",
      started_at: "2026-08-19T00:00:00Z",
      completed_at: "2026-08-19T00:01:00Z",
    }));
    const metas = listSubagentMetas(root);
    assert.equal(metas.length, 1);
    assert.equal(metas[0].subagentId, "child-1");
    assert.equal(metas[0].parentSessionId, "root-1");
    assert.equal(metas[0].childSessionId, "child-1");
    assert.equal(metas[0].agent, "explore");
    assert.equal(metas[0].task, "look around");
    assert.equal(metas[0].status, "completed");
  });

  it("returns an empty list when the subagents folder is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-sub-empty-"));
    assert.deepEqual(listSubagentMetas(root), []);
  });
});
