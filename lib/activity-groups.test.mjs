import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityGroupKind, groupActivityBlocks } from "./activity-groups.ts";

describe("activityGroupKind", () => {
  it("classifies search/bash/edit/read without mistaking search_replace for search", () => {
    assert.equal(activityGroupKind("grep"), "search");
    assert.equal(activityGroupKind("codebase_search"), "search");
    assert.equal(activityGroupKind("run_terminal_command"), "bash");
    assert.equal(activityGroupKind("search_replace"), "edit");
    assert.equal(activityGroupKind("write"), "edit");
    assert.equal(activityGroupKind("read_file"), "read");
    assert.equal(activityGroupKind("web_fetch"), "other");
  });
});

describe("groupActivityBlocks", () => {
  it("collapses consecutive same-kind tools and leaves mixed/single tools alone", () => {
    const items = [
      { block: { type: "thinking" }, originalIndex: 0 },
      { block: { type: "toolCall", toolName: "grep" }, originalIndex: 1 },
      { block: { type: "toolCall", toolName: "grep" }, originalIndex: 2 },
      { block: { type: "toolCall", toolName: "read_file" }, originalIndex: 3 },
      { block: { type: "toolCall", toolName: "bash" }, originalIndex: 4 },
    ];
    const grouped = groupActivityBlocks(items);
    assert.equal(grouped[0].type, "single");
    assert.equal(grouped[1].type, "group");
    assert.equal(grouped[1].kind, "search");
    assert.equal(grouped[1].items.length, 2);
    assert.equal(grouped[2].type, "single");
    assert.equal(grouped[3].type, "single");
  });
});
