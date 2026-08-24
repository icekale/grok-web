import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const PI_ICON_192_SHA256 = "768cbbf7a7528d6e7b3af8112d7cde43eb6c9c8989ad9b06be8047dae1227463";
const PI_ICON_512_SHA256 = "3a462c3c2524733c173bb05c431de737812f8219db8fa115b0025d12a347e086";
const PI_APPLE_TOUCH_SHA256 = "a3487e9bfbe49df853c51c5bdbf980bfb3bec782bfdd398a9bf333bb648b832f";
const PI_PUBLIC_FAVICON_SHA256 = "948273de9d49e1f80dbab5a8784e4e6aad97583f2a5d8554e4841dd9073c1f79";
const PI_APP_FAVICON_SHA256 = "8e6dd8676de355857a2ac2828d9d290a41b2c3e40526bc5ad83d26829b5f4124";

async function sha256(relativePath) {
  const bytes = await readFile(new URL(relativePath, import.meta.url));
  return createHash("sha256").update(bytes).digest("hex");
}

describe("offline page", () => {
  it("tells the user Grok Web is offline, not Pi Web", async () => {
    const html = await readFile(new URL("./offline.html", import.meta.url), "utf8");
    assert.match(html, /Grok Web is offline/);
    assert.match(html, /local Grok Web server/);
    assert.doesNotMatch(html, /Pi Web/);
  });

  it("uses the Grok mark, not the leftover Pi PNG", async () => {
    const html = await readFile(new URL("./offline.html", import.meta.url), "utf8");
    assert.match(html, /\/icons\/favicon\.svg/);
    assert.doesNotMatch(html, /icon-192\.png/);
  });
});

describe("PWA icons", () => {
  it("are no longer the leftover Pi raster assets", async () => {
    assert.notEqual(await sha256("./icons/icon-192.png"), PI_ICON_192_SHA256);
    assert.notEqual(await sha256("./icons/icon-512.png"), PI_ICON_512_SHA256);
    assert.notEqual(await sha256("./icons/apple-touch-icon.png"), PI_APPLE_TOUCH_SHA256);
    assert.notEqual(await sha256("./favicon.ico"), PI_PUBLIC_FAVICON_SHA256);
    assert.notEqual(await sha256("../app/favicon.ico"), PI_APP_FAVICON_SHA256);
  });
});
