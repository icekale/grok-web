import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { retainUnpersistedUserMessages, userMessageKey } = await createJiti(import.meta.url).import("./prompt-recovery.ts");

function textMessage(content) {
  return { role: "user", content, timestamp: 1 };
}

test("builds stable keys for matching optimistic text messages", () => {
  assert.equal(userMessageKey(textMessage("repeat this")), userMessageKey(textMessage("repeat this")));
  assert.notEqual(userMessageKey(textMessage("first")), userMessageKey(textMessage("second")));
});

test("includes attached images in optimistic message keys", () => {
  const submitted = {
    role: "user",
    content: [
      { type: "text", text: "inspect" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
    timestamp: 1,
  };
  const differentImage = {
    ...submitted,
    content: [
      { type: "text", text: "inspect" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BAUG" } },
    ],
  };
  assert.notEqual(userMessageKey(submitted), userMessageKey(differentImage));
});

test("keeps a live user message that disk has not persisted yet", () => {
  const live = [textMessage("hello from a new chat")];
  assert.deepEqual(retainUnpersistedUserMessages([], live), live);
  assert.deepEqual(retainUnpersistedUserMessages(live, live), live);
});

test("does not append a non-user trailing live message", () => {
  const persisted = [textMessage("kept")];
  assert.deepEqual(
    retainUnpersistedUserMessages(persisted, [{ role: "assistant", content: "nope" }]),
    persisted,
  );
});

test("keeps a live user even when an aborted assistant already followed it", () => {
  const liveUser = textMessage("hello from a new chat");
  const aborted = { role: "assistant", content: "", stopReason: "aborted" };
  assert.deepEqual(
    retainUnpersistedUserMessages([], [liveUser, aborted]),
    [liveUser, aborted],
  );
});
