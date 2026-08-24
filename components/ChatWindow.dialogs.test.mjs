import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("standard extension requests use the shared Codex dialog", () => {
  assert.match(source, /<DialogShell[\s\S]*?size=\{request\.method === "editor" \? "editor" : "request"\}/);
  assert.match(source, /subtitle=\{t\("chat\.extensionRequest"\)\}/);
  assert.doesNotMatch(source, /background: "rgba\(0,0,0,0\.18\)"/);
});

test("request responses preserve existing protocol payloads", () => {
  assert.match(source, /onRespond\(request, \{ confirmed: true \}\)/);
  assert.match(source, /onRespond\(request, \{ value \}\)/);
  assert.match(source, /onRespond\(request, \{ value: option \}\)/);
  assert.match(source, /onRespond\(request, \{ cancelled: true \}\)/);
});

test("input and editor keyboard contracts stay intact", () => {
  assert.match(source, /request\.method === "input"[\s\S]*?e\.key === "Enter"[\s\S]*?submitValue\(\)/);
  assert.match(source, /request\.method === "editor"[\s\S]*?\(e\.metaKey \|\| e\.ctrlKey\) && e\.key === "Enter"[\s\S]*?submitValue\(\)/);
});

test("input and editor Escape use the single dialog dismiss path", () => {
  // Escape must not respond twice: the native dialog cancel would fire again
  // after an inline onRespond. The DialogShell onClose is the only cancel path.
  const inputBlock = source.slice(
    source.indexOf('request.method === "input"'),
    source.indexOf('request.method === "editor"'),
  );
  const editorBlock = source.slice(
    source.indexOf('request.method === "editor"'),
    source.indexOf("type ExtensionCustomRequest"),
  );
  assert.doesNotMatch(inputBlock, /e\.key === "Escape"[\s\S]*?onRespond/);
  assert.doesNotMatch(editorBlock, /e\.key === "Escape"[\s\S]*?onRespond/);
  assert.match(source, /onClose=\{\(\s*\) => onRespond\(request, \{ cancelled: true \}\)\}/);
});

test("select options are dense rows rather than cards", () => {
  assert.match(source, /className="codex-dialog-options"/);
  assert.match(source, /className="codex-dialog-option"/);
  assert.match(source, /className="codex-dialog-option-key"/);
  assert.match(styles, /\.codex-dialog-option\s*\{[\s\S]*?min-height:\s*40px;/);
});

test("select options answer the numbered key chips", () => {
  assert.match(source, /className="codex-dialog-options"[\s\S]*?onKeyDown=\{\(e\) => \{[\s\S]*?\^\[1-9\]\$/);
  assert.match(source, /request\.options\[Number\(e\.key\) - 1\]/);
  assert.match(source, /onRespond\(request, \{ value: option \}\)/);
});

test("custom terminal UI uses the terminal shell and preserves Ctrl+C close", () => {
  assert.match(source, /<DialogShell[\s\S]*?size="terminal"[\s\S]*?onClose=\{\(\) => onInput\(request, "\\x03"\)\}/);
  assert.match(source, /event\.key === "Escape"[\s\S]*?onInput\(request, "\\x03"\)/);
  assert.match(source, /toTerminalKeyData\(event\)/);
  assert.match(source, /asBracketedPaste\(text\)/);
});

test("streaming tool cards receive toolResults", () => {
  assert.match(source, /streamState\.streamingMessage/);
  const streamView = source.slice(
    source.indexOf("streamState.isStreaming && hasStreamingContent && streamState.streamingMessage"),
    source.indexOf('agentRunning && agentPhase?.kind === "stopping"'),
  );
  assert.match(streamView, /toolResults=\{/);
  assert.match(source, /const persisted = useMemo\(/);
  assert.match(source, /\[entryIds, messages\]/);
  assert.match(source, /if \(liveToolResults\.size === 0\) return persisted/);
  assert.match(source, /if \(!map\.has\(id\)\) map\.set\(id, result\)/);
  assert.match(source, /\[persisted, liveToolResults\]/);
  assert.doesNotMatch(source, /\[entryIds, liveToolResults, messages\]/);
});

test("keeps the live phase label while streaming content is visible", () => {
  const stopping = source.slice(
    source.indexOf('agentRunning && agentPhase?.kind === "stopping"'),
    source.indexOf("bashRunning &&"),
  );
  assert.match(stopping, /agentRunning && agentPhase && agentPhase\.kind !== "stopping"/);
  assert.doesNotMatch(stopping, /!hasStreamingContent/);
  assert.match(stopping, /phaseLabel\(agentPhase, t\)/);
});
