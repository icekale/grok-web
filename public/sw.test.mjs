import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const listeners = new Map();
globalThis.self = {
  location: {
    href: "https://pi.test/sw.js?v=test",
    origin: "https://pi.test",
  },
  addEventListener: (type, listener) => listeners.set(type, listener),
  clients: null,
};

await import("./sw.js");

function dispatchNotificationClick(data) {
  let pending;
  let closed = false;
  listeners.get("notificationclick")({
    notification: {
      data,
      close: () => { closed = true; },
    },
    waitUntil: (promise) => { pending = promise; },
  });
  return { pending, wasClosed: () => closed };
}

test("notification click focuses an existing client at the session URL", async () => {
  const calls = [];
  const focusedClient = {
    url: "https://pi.test/?session=session-1",
    focus: async () => { calls.push("focus"); },
    navigate: async () => assert.fail("exact client should not navigate"),
  };
  self.clients = {
    matchAll: async () => [focusedClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.equal(event.wasClosed(), true);
  assert.deepEqual(calls, ["focus"]);
});

test("notification click navigates an existing client to the session", async () => {
  const calls = [];
  const navigatedClient = {
    focus: async () => { calls.push("focus"); },
  };
  const existingClient = {
    url: "https://pi.test/?session=other-session",
    navigate: async (url) => {
      calls.push(["navigate", url]);
      return navigatedClient;
    },
    focus: async () => assert.fail("the navigated client should be focused"),
  };
  self.clients = {
    matchAll: async () => [existingClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.deepEqual(calls, [
    ["navigate", "https://pi.test/?session=session-1"],
    "focus",
  ]);
});

test("notification click opens a window and rejects cross-origin targets", async () => {
  const opened = [];
  self.clients = {
    matchAll: async () => [],
    openWindow: async (url) => { opened.push(url); },
  };

  const event = dispatchNotificationClick({ url: "https://example.com/redirect" });
  await event.pending;

  assert.deepEqual(opened, ["https://pi.test/"]);
});

test("service worker cache prefix is grok-web", async () => {
  const swSource = await readFile(new URL("./sw.js", import.meta.url), "utf8");
  assert.match(swSource, /CACHE_PREFIX = "grok-web"/);
  assert.doesNotMatch(swSource, /CACHE_PREFIX = "pi-web"/);
});

test("service worker cache names include the build id from its registration URL", async () => {
  const swSource = await readFile(new URL("./sw.js", import.meta.url), "utf8");
  assert.match(swSource, /new URL\(self\.location\.href\)\.searchParams\.get\("v"\)/);
  assert.match(swSource, /CACHE_VERSION/);
});
test("service worker precaches the Grok mark used by the offline page", async () => {
  const swSource = await readFile(new URL("./sw.js", import.meta.url), "utf8");
  assert.match(swSource, /\/icons\/favicon\.svg/);
});

test("service worker cache name drops leftover Pi icon caches", async () => {
  const swSource = await readFile(new URL("./sw.js", import.meta.url), "utf8");
  assert.match(swSource, /CACHE_GENERATION = "grok-mark-2"/);
  assert.match(swSource, /key\.startsWith\("pi-web-"\)/);
  assert.match(swSource, /caches\.match\(OFFLINE_URL,\s*\{\s*cacheName:\s*STATIC_CACHE\s*\}\)/);
});

test("service worker treats emitted /assets as static and drops Next markers", async () => {
  const swSource = await readFile(new URL("./sw.js", import.meta.url), "utf8");
  assert.match(swSource, /startsWith\("\/assets\/"\)/);
  assert.doesNotMatch(swSource, /_next\/static/);
});

test("runtime cache recognizes emitted production assets", async () => {
  const swSource = await readFile(new URL("./sw.js", import.meta.url), "utf8");
  assert.match(swSource, /url\.pathname\.startsWith\("\/assets\/"\)/);
  assert.doesNotMatch(swSource, /url\.pathname\.startsWith\("\/_build\/"\)/);
});
