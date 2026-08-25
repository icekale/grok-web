import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("renders a Codex-style new-session home", () => {
  assert.match(source, /chat\.homeTitle/);
  assert.match(source, /className="new-session-home/);
  assert.match(source, /onDismiss=\{dismissNotice\}/);
  assert.doesNotMatch(source, /HOME_STARTERS/);
  assert.doesNotMatch(source, /insertIfEmpty\(`\/skill:\$\{skill\}/);
  assert.doesNotMatch(source, /chat\.homeExplore/);
  assert.match(source, /workspaceHint=\{isEmptyNew \? homeCwdLabel : null\}/);
  assert.doesNotMatch(source, /maxWidth: 820/);
  assert.doesNotMatch(source, /margin: "0 auto -14px"/);
});

test("process details use a compact result row and stay collapsed", () => {
  assert.match(source, /className="chat-process-summary"/);
  assert.match(source, /defaultExpanded = false/);
  assert.match(source, /chat\.processRunning/);
  assert.match(source, /chat\.processCompleted/);
  assert.match(source, /chat\.processErrors/);
});

test("process groups keep tool and thinking details collapsed until opened", () => {
  assert.match(source, /defaultToolDetailsExpanded/);
  assert.match(source, /defaultThinkingDetailsExpanded/);
  assert.match(source, /defaultToolDetailsExpanded: false/);
  assert.match(source, /defaultThinkingDetailsExpanded: false/);
});

test("a live turn folds process blocks while keeping streamed answer blocks visible", () => {
  assert.match(source, /splitFinalAssistantBlocks\(message, \{ isStreaming: true \}/);
  assert.match(source, /const streamingDisplay = useMemo/);
  assert.match(source, /processMessage: split\.processBlocks/);
  assert.match(source, /answerMessage: split\.answerBlocks/);
  assert.match(source, /<ProcessDetailsGroup[\s\S]*?\n\s+active\n/);
  assert.doesNotMatch(source, /defaultToolDetailsExpanded=\{true\}/);
});

test("a live turn does not unroll persisted tool cards into the transcript", () => {
  const start = source.indexOf("const isLiveTail");
  const block = source.slice(start, start + 900);
  assert.match(block, /rendered\.push\(renderMessage\(userIdx\)\)/);
  assert.doesNotMatch(block, /for \(let renderIdx = userIdx; renderIdx < endIdx/);
});

test("notice shelf animation does not lock toast height", () => {
  const start = css.indexOf("@keyframes notice-shelf-in");
  const end = css.indexOf("@keyframes notice-shelf-out");
  assert.ok(start >= 0 && end > start);
  const block = css.slice(start, end);
  assert.doesNotMatch(block, /height:\s*60px/);
  assert.doesNotMatch(block, /max-height:\s*60px/);
});
