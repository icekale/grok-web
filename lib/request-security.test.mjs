import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-request-security-"));
const previousGrokHome = process.env.GROK_HOME;
process.env.GROK_HOME = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  if (previousGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousGrokHome;
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  moduleCache: false,
});

async function loadSubject() {
  return jiti.import("./request-security.ts");
}

test("allows same-origin and non-browser API requests", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "sec-fetch-site": "same-origin",
    },
  })), true);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { host: "localhost:30141" },
  })), true);
});

test("allows LAN same-origin requests when Next.js uses an internal localhost URL", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://192.168.32.7:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), true);
});

test("allows IPv6 and an explicitly configured hostname", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const ipv6 = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "[::1]:30141",
      origin: "http://[::1]:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  const configured = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "pi-web.internal:30141",
      origin: "http://pi-web.internal:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(ipv6), true);
  assert.equal(isApiRequestAllowed(configured, ["pi-web.internal"]), true);
});

test("rejects cross-origin browser API requests", async () => {
  const { isApiRequestAllowed, shouldCheckApiRequestOrigin } = await loadSubject();
  const post = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
  });
  const crossSiteGet = new Request("http://localhost:30141/api/sessions", {
    headers: { host: "localhost:30141", "sec-fetch-site": "cross-site" },
  });
  assert.equal(shouldCheckApiRequestOrigin(post), true);
  assert.equal(isApiRequestAllowed(post), false);
  assert.equal(shouldCheckApiRequestOrigin(crossSiteGet), true);
  assert.equal(isApiRequestAllowed(crossSiteGet), false);
});

test("does not globally trust opaque iframe or alternate loopback origins", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const previewUrl = "http://localhost:30141/api/files/tmp/test.docx?type=preview";
  const opaqueIframe = new Request(previewUrl, {
    headers: {
      host: "localhost:30141",
      origin: "null",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
    },
  });
  const alternateLoopback = new Request(previewUrl, {
    headers: {
      host: "localhost:30141",
      origin: "http://127.0.0.1:30141",
      "sec-fetch-site": "cross-site",
    },
  });

  assert.equal(isApiRequestAllowed(opaqueIframe), false);
  assert.equal(isApiRequestAllowed(alternateLoopback), false);
});

test("allows only user-initiated session export document navigations from a PWA", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const navigationHeaders = {
    host: "127.0.0.1:30141",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };

  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: navigationHeaders },
  )), true);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions",
    { headers: navigationHeaders },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: { ...navigationHeaders, "sec-fetch-dest": "empty" } },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    {
      headers: {
        ...navigationHeaders,
        "sec-fetch-user": "",
      },
    },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { method: "POST", headers: navigationHeaders },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: { ...navigationHeaders, host: "attacker.example:30141" } },
  )), false);
});

test("rejects an origin that does not match the external request host", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://attacker.example",
      "sec-fetch-site": "same-site",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects DNS rebinding even when browser headers say same-origin", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/skills/install", {
    method: "POST",
    headers: {
      host: "attacker.example:30141",
      origin: "http://attacker.example:30141",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects missing, malformed, and unconfigured Host headers", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test")), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "localhost@attacker.example:30141" },
  })), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "pi-web.internal:30141" },
  })), false);
});

test("rejects browser origins with the same hostname but a different effective port", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/sessions", {
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30142",
      "sec-fetch-site": "same-site",
    },
  })), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/sessions", {
    headers: {
      host: "localhost:30141",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
  })), false);
});

test("still rejects when Origin hostname differs from Host even with port stripped", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/sessions", {
    headers: {
      host: "localhost:30141",
      origin: "http://127.0.0.1",
      "sec-fetch-site": "same-site",
    },
  })), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/sessions", {
    headers: {
      host: "127.0.0.1:30141",
      origin: "http://attacker.example",
      "sec-fetch-site": "same-site",
    },
  })), false);
});

test("rejects browser origins with a different scheme", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("https://localhost:30141/api/agent/new", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects Origin credentials", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    headers: {
      host: "localhost:30141",
      origin: "http://user:password@localhost:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects Origin paths, queries, and fragments", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  for (const origin of [
    "http://localhost:30141/path",
    "http://localhost:30141?query=1",
    "http://localhost:30141#fragment",
  ]) {
    const request = new Request("http://localhost:30141/api/test", {
      headers: {
        host: "localhost:30141",
        origin,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(isApiRequestAllowed(request), false, origin);
  }
});

test("rejects non-http Origin schemes before tuple comparison", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  const request = new Request("ftp://localhost:30141/api/test", {
    headers: {
      host: "localhost:30141",
      origin: "ftp://localhost:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestOriginAllowed(request), false);
});

test("allows equivalent explicit and implicit default ports", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  for (const [url, host, origin] of [
    ["http://localhost/api/test", "localhost:80", "http://localhost"],
    ["https://localhost/api/test", "localhost:443", "https://localhost"],
    ["http://[::1]/api/test", "[::1]:80", "http://[::1]"],
  ]) {
    const request = new Request(url, {
      headers: { host, origin, "sec-fetch-site": "same-origin" },
    });
    assert.equal(isApiRequestAllowed(request), true, `${origin} vs ${host}`);
  }
});

test("unions file-configured hosts with the environment allow-list", async () => {
  const { writeRemoteAccessConfig } = await jiti.import("./remote-access-config.ts");
  assert.equal(writeRemoteAccessConfig({
    allowedHosts: ["pi.example.com"],
    password: "twelve chars!",
    loopbackRequest: true,
  }).ok, true);
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "pi.example.com",
      origin: "http://pi.example.com",
      "sec-fetch-site": "same-origin",
    },
  })), true);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "attacker.example" },
  })), false);
});

test("loopback helper treats localhost and loopback IPs as local", async () => {
  const { isLoopbackApiRequest } = await loadSubject();
  assert.equal(isLoopbackApiRequest(new Request("http://localhost:30141/", {
    headers: { host: "localhost:30141" },
  }), "127.0.0.1"), true);
  assert.equal(isLoopbackApiRequest(new Request("http://127.0.0.1:30141/", {
    headers: { host: "127.0.0.1:30141" },
  }), "::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackApiRequest(new Request("http://pi.example.com/", {
    headers: { host: "pi.example.com" },
  }), "127.0.0.1"), false);
  assert.equal(isLoopbackApiRequest(new Request("http://127.0.0.1:30141/", {
    headers: { host: "127.0.0.1:30141" },
  })), false);
  assert.equal(isLoopbackApiRequest(new Request("http://127.0.0.1:30141/", {
    headers: { host: "127.0.0.1:30141" },
  }), "192.168.1.50"), false);
});

test("recognizes JSON request content types", async () => {
  const { hasJsonContentType } = await loadSubject();
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "application/json; charset=utf-8" },
  })), true);
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "application/problem+json" },
  })), true);
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "text/plain" },
  })), false);
});
