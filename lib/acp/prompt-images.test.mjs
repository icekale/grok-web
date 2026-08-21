import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAcpPrompt, parsePromptImages } from "./prompt-images.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

test("parses prompt image payloads and ignores junk", () => {
  assert.deepEqual(
    parsePromptImages([{ type: "image", data: png, mimeType: "image/png" }, { mimeType: "text/plain" }]),
    [{ data: png, mimeType: "image/png" }],
  );
});

test("builds ACP image content blocks from the prompt-image fixture", () => {
  const fixture = JSON.parse(readFileSync(join(fixtures, "prompt-image.json"), "utf8"));
  const promptBlocks = Array.isArray(fixture) ? fixture : fixture.prompt;
  const text = promptBlocks.find((block) => block?.type === "text")?.text ?? "";
  const prompt = buildAcpPrompt(text, parsePromptImages(promptBlocks));
  const images = prompt.filter((block) => block.type !== "text");
  assert.ok(images.length > 0);
  for (const block of images) {
    assert.equal(block.type, "image");
    assert.equal(typeof block.mimeType, "string");
    assert.match(block.mimeType, /^image\//);
    assert.equal(typeof block.data, "string");
    assert.ok(block.data.length > 0);
    assert.equal("path" in block, false);
    assert.equal("resource" in block, false);
  }
});
