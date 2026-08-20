import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "grok-web-tanstack-security-"));
const previousGrokHome = process.env.GROK_HOME;
const previousPassword = process.env.GROK_WEB_PASSWORD;
process.env.GROK_HOME = agentDir;
delete process.env.GROK_WEB_PASSWORD;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  if (previousGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousGrokHome;
  if (previousPassword === undefined) delete process.env.GROK_WEB_PASSWORD;
  else process.env.GROK_WEB_PASSWORD = previousPassword;
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  moduleCache: false,
});

const cases = [
  {
    name: "rejects an untrusted API host as JSON",
    request: new Request("http://localhost:30141/api/sessions", {
      headers: { host: "attacker.example:30141", origin: "http://attacker.example:30141" },
    }),
    status: 403,
    contentType: "application/json",
    body: { error: "Untrusted API request" },
  },
  {
    name: "rejects an untrusted root host as text",
    request: new Request("http://localhost:30141/", {
      headers: { host: "attacker.example:30141" },
    }),
    status: 403,
    contentType: "text/plain",
    body: "Untrusted request",
  },
];

function basicAuthorization(password, username = "grok") {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function remoteRequest(authorization, forwardedFor) {
  return new Request("http://app.example.com/api/sessions", {
    headers: {
      host: "app.example.com",
      ...(authorization ? { authorization } : {}),
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
    },
  });
}

test("request security rejects untrusted hosts with the legacy response matrix", async () => {
  const { getRequestSecurityRejection } = await jiti.import("./request-security.ts");
  for (const c of cases) {
    const response = await getRequestSecurityRejection(c.request);
    assert.ok(response, `${c.name}: expected a rejection response`);
    assert.equal(response.status, c.status, c.name);
    if (c.contentType === "text/plain") {
      assert.ok(
        response.headers.get("content-type")?.startsWith("text/plain"),
        `${c.name}: expected a text content type`,
      );
    } else {
      assert.equal(response.headers.get("content-type"), c.contentType, c.name);
    }
    assert.deepEqual(
      c.contentType === "application/json" ? await response.json() : await response.text(),
      c.body,
      c.name,
    );
  }
});

test("request security requires Basic Auth on non-loopback hosts when a password is set", async () => {
  const { getRequestSecurityRejection } = await jiti.import("./request-security.ts");
  process.env.GROK_WEB_PASSWORD = "correct horse battery staple";
  process.env.GROK_WEB_ALLOWED_HOSTS = "app.example.com";
  try {
    const remote = await getRequestSecurityRejection(new Request("http://app.example.com/api/sessions", {
      headers: { host: "app.example.com" },
    }));
    assert.equal(remote.status, 401);
    assert.equal(remote.headers.get("cache-control"), "no-store");
    assert.equal(
      remote.headers.get("www-authenticate"),
      'Basic realm="Grok Web", charset="UTF-8"',
    );
    assert.equal(await remote.text(), "Authentication required");

    const loopback = await getRequestSecurityRejection(new Request("http://127.0.0.1:30142/api/sessions", {
      headers: { host: "127.0.0.1:30142" },
    }), "127.0.0.1");
    assert.equal(loopback, undefined);

    const forgedHost = await getRequestSecurityRejection(new Request("http://192.168.1.8:30142/api/sessions", {
      headers: { host: "127.0.0.1:30142" },
    }), "192.168.1.50");
    assert.equal(forgedHost.status, 401);

    const missingPeer = await getRequestSecurityRejection(new Request("http://127.0.0.1:30142/api/sessions", {
      headers: { host: "127.0.0.1:30142" },
    }));
    assert.equal(missingPeer.status, 401);

    const proxied = await getRequestSecurityRejection(new Request("http://app.example.com/api/sessions", {
      headers: { host: "app.example.com" },
    }), "127.0.0.1");
    assert.equal(proxied.status, 401);
  } finally {
    delete process.env.GROK_WEB_PASSWORD;
    delete process.env.GROK_WEB_ALLOWED_HOSTS;
  }
});

test("request security allows trusted roots and APIs", async () => {
  const { getRequestSecurityRejection } = await jiti.import("./request-security.ts");
  const trusted = [
    new Request("http://localhost:30141/", { headers: { host: "localhost:30141" } }),
    new Request("http://localhost:30141/api/sessions", {
      headers: { host: "localhost:30141", origin: "http://localhost:30141" },
    }),
  ];
  for (const request of trusted) {
    assert.equal(await getRequestSecurityRejection(request), undefined);
  }
});

test("request security accepts valid Basic Auth", async () => {
  const { getRequestSecurityRejection } = await jiti.import("./request-security.ts");
  process.env.GROK_WEB_PASSWORD = "correct horse battery staple";
  try {
    const authorization = `Basic ${Buffer.from("grok:correct horse battery staple").toString("base64")}`;
    const request = new Request("http://localhost:30141/", {
      headers: { host: "localhost:30141", authorization },
    });
    assert.equal(await getRequestSecurityRejection(request), undefined);
  } finally {
    delete process.env.GROK_WEB_PASSWORD;
  }
});

test("failed authentication is limited per actual peer after five failures", async () => {
  const {
    AUTH_FAILURE_LIMIT,
    createFailedAuthRateLimiter,
    getRequestSecurityRejection,
  } = await jiti.import("./request-security.ts");
  let now = 1_000;
  const limiter = createFailedAuthRateLimiter({ now: () => now });
  process.env.GROK_WEB_PASSWORD = "correct horse battery staple";
  process.env.GROK_WEB_ALLOWED_HOSTS = "app.example.com";
  try {
    for (let attempt = 0; attempt < AUTH_FAILURE_LIMIT; attempt += 1) {
      const response = await getRequestSecurityRejection(
        remoteRequest(basicAuthorization("wrong"), `198.51.100.${attempt}`),
        "192.0.2.10",
        limiter,
      );
      assert.equal(response.status, 401);
      assert.equal(
        response.headers.get("www-authenticate"),
        'Basic realm="Grok Web", charset="UTF-8"',
      );
    }

    const limited = await getRequestSecurityRejection(
      remoteRequest(basicAuthorization("wrong"), "203.0.113.200"),
      "192.0.2.10",
      limiter,
    );
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("www-authenticate"), null);
    assert.equal(limited.headers.get("retry-after"), "60");

    const otherPeer = await getRequestSecurityRejection(
      remoteRequest(basicAuthorization("wrong")),
      "192.0.2.11",
      limiter,
    );
    assert.equal(otherPeer.status, 401);
    now += 1;
  } finally {
    delete process.env.GROK_WEB_PASSWORD;
    delete process.env.GROK_WEB_ALLOWED_HOSTS;
  }
});

test("successful authentication resets failures and expired limits allow retries", async () => {
  const { createFailedAuthRateLimiter, getRequestSecurityRejection } =
    await jiti.import("./request-security.ts");
  let now = 5_000;
  const limiter = createFailedAuthRateLimiter({
    now: () => now,
    threshold: 2,
    ttlMs: 1_000,
  });
  process.env.GROK_WEB_PASSWORD = "correct horse battery staple";
  process.env.GROK_WEB_ALLOWED_HOSTS = "app.example.com";
  try {
    const reject = (password) => getRequestSecurityRejection(
      remoteRequest(basicAuthorization(password)),
      "192.0.2.20",
      limiter,
    );
    assert.equal((await reject("wrong-1")).status, 401);
    assert.equal(await reject("correct horse battery staple"), undefined);
    assert.equal((await reject("wrong-2")).status, 401);
    assert.equal((await reject("wrong-3")).status, 401);
    assert.equal((await reject("wrong-4")).status, 429);

    now += 1_000;
    assert.equal((await reject("wrong-after-expiry")).status, 401);
  } finally {
    delete process.env.GROK_WEB_PASSWORD;
    delete process.env.GROK_WEB_ALLOWED_HOSTS;
  }
});

test("concurrent attempts reserve the same peer threshold atomically", async () => {
  const { createFailedAuthRateLimiter, getRequestSecurityRejection } =
    await jiti.import("./request-security.ts");
  const limiter = createFailedAuthRateLimiter({
    now: () => 8_000,
    threshold: 2,
  });
  process.env.GROK_WEB_PASSWORD = "correct horse battery staple";
  process.env.GROK_WEB_ALLOWED_HOSTS = "app.example.com";
  try {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) => getRequestSecurityRejection(
        remoteRequest(basicAuthorization(`wrong-${index}`)),
        "192.0.2.30",
        limiter,
      )),
    );
    assert.deepEqual(
      responses.map((response) => response?.status).sort(),
      [401, 401, 429, 429, 429, 429],
    );
  } finally {
    delete process.env.GROK_WEB_PASSWORD;
    delete process.env.GROK_WEB_ALLOWED_HOSTS;
  }
});

test("active blocked peers are never evicted at capacity", async () => {
  const { createFailedAuthRateLimiter, getRequestSecurityRejection } =
    await jiti.import("./request-security.ts");
  let now = 10_000;
  const limiter = createFailedAuthRateLimiter({
    now: () => now,
    maxPeers: 1,
    threshold: 1,
    ttlMs: 1_000,
  });
  process.env.GROK_WEB_PASSWORD = "correct horse battery staple";
  process.env.GROK_WEB_ALLOWED_HOSTS = "app.example.com";
  try {
    const reject = (peer) => getRequestSecurityRejection(
      remoteRequest(basicAuthorization("wrong")),
      peer,
      limiter,
    );
    assert.equal((await reject("192.0.2.40")).status, 401);
    assert.equal((await reject("192.0.2.41")).status, 429);
    assert.equal((await reject("192.0.2.40")).status, 429);

    now += 1_000;
    assert.equal((await reject("192.0.2.41")).status, 401);
    assert.equal(limiter.size, 1);
  } finally {
    delete process.env.GROK_WEB_PASSWORD;
    delete process.env.GROK_WEB_ALLOWED_HOSTS;
  }
});

test("equivalent IPv4 and IPv6 peer spellings share limits", async () => {
  const { createFailedAuthRateLimiter, getRequestSecurityRejection } =
    await jiti.import("./request-security.ts");
  const limiter = createFailedAuthRateLimiter({
    now: () => 15_000,
    threshold: 1,
  });
  process.env.GROK_WEB_PASSWORD = "correct horse battery staple";
  process.env.GROK_WEB_ALLOWED_HOSTS = "app.example.com";
  try {
    const reject = (peer) => getRequestSecurityRejection(
      remoteRequest(basicAuthorization("wrong")),
      peer,
      limiter,
    );
    assert.equal((await reject("192.0.2.50")).status, 401);
    assert.equal((await reject("::ffff:192.0.2.50")).status, 429);

    assert.equal((await reject("2001:0DB8:0000:0000:0000:0000:0000:0051")).status, 401);
    assert.equal((await reject("2001:db8::51")).status, 429);
  } finally {
    delete process.env.GROK_WEB_PASSWORD;
    delete process.env.GROK_WEB_ALLOWED_HOSTS;
  }
});

test("normal request activity purges expired peer entries", async () => {
  const { createFailedAuthRateLimiter } = await jiti.import("./request-security.ts");
  let now = 20_000;
  const limiter = createFailedAuthRateLimiter({
    now: () => now,
    maxPeers: 10,
    ttlMs: 100,
  });
  const expired = limiter.reserve("192.0.2.60");
  assert.equal(expired.allowed, true);
  if (expired.allowed) expired.complete(false);
  assert.equal(limiter.size, 1);

  now += 100;
  const current = limiter.reserve("192.0.2.61");
  assert.equal(current.allowed, true);
  assert.equal(limiter.size, 1);
  if (current.allowed) current.complete(false);
});

test("unknown peers accumulate failures with reset and TTL expiry", async () => {
  const { createFailedAuthRateLimiter, getRequestSecurityRejection } =
    await jiti.import("./request-security.ts");
  let now = 25_000;
  const limiter = createFailedAuthRateLimiter({
    now: () => now,
    threshold: 2,
    ttlMs: 100,
  });
  process.env.GROK_WEB_PASSWORD = "correct horse battery staple";
  process.env.GROK_WEB_ALLOWED_HOSTS = "app.example.com";
  try {
    const reject = (password) => getRequestSecurityRejection(
      remoteRequest(basicAuthorization(password)),
      undefined,
      limiter,
    );
    assert.equal((await reject("wrong-1")).status, 401);
    assert.equal((await reject("wrong-2")).status, 401);
    assert.equal((await reject("wrong-3")).status, 429);

    now += 100;
    assert.equal((await reject("wrong-after-expiry")).status, 401);
    assert.equal(await reject("correct horse battery staple"), undefined);
    assert.equal((await reject("wrong-after-reset-1")).status, 401);
    assert.equal((await reject("wrong-after-reset-2")).status, 401);
    assert.equal((await reject("wrong-after-reset-3")).status, 429);
  } finally {
    delete process.env.GROK_WEB_PASSWORD;
    delete process.env.GROK_WEB_ALLOWED_HOSTS;
  }
});

test("cached valid unknown credentials bypass only expensive-work saturation", async () => {
  const {
    createFailedAuthRateLimiter,
    getRequestSecurityRejection,
  } = await jiti.import("./request-security.ts");
  const { writeRemoteAccessConfig } = await jiti.import("./remote-access-config.ts");
  assert.equal(writeRemoteAccessConfig({
    allowedHosts: [],
    password: "correct horse battery staple",
    loopbackRequest: true,
  }).ok, true);
  process.env.GROK_WEB_ALLOWED_HOSTS = "app.example.com";
  const limiter = createFailedAuthRateLimiter({
    now: () => 26_000,
    maxUnknownInFlight: 1,
  });
  try {
    assert.equal(
      await getRequestSecurityRejection(
        remoteRequest(basicAuthorization("correct horse battery staple")),
        undefined,
        limiter,
      ),
      undefined,
    );

    const occupied = limiter.reserve(undefined, { expensive: true });
    assert.equal(occupied.allowed, true);
    assert.equal(
      await getRequestSecurityRejection(
        remoteRequest(basicAuthorization("correct horse battery staple")),
        undefined,
        limiter,
      ),
      undefined,
    );
    assert.equal((
      await getRequestSecurityRejection(
        remoteRequest(basicAuthorization("wrong")),
        undefined,
        limiter,
      )
    ).status, 429);
    if (occupied.allowed) occupied.complete(false);
  } finally {
    delete process.env.GROK_WEB_ALLOWED_HOSTS;
    assert.equal(
      writeRemoteAccessConfig({ allowedHosts: [], password: null, loopbackRequest: true }).ok,
      true,
    );
  }
});

test("cached valid unknown credentials bypass a locked failure bucket without verification", async () => {
  const {
    createFailedAuthRateLimiter,
    getRequestSecurityRejection,
  } = await jiti.import("./request-security.ts");
  const { writeRemoteAccessConfig } = await jiti.import("./remote-access-config.ts");
  assert.equal(writeRemoteAccessConfig({
    allowedHosts: [],
    password: "correct horse battery staple",
    loopbackRequest: true,
  }).ok, true);
  process.env.GROK_WEB_ALLOWED_HOSTS = "app.example.com";
  const authorization = basicAuthorization("correct horse battery staple");
  try {
    assert.equal(
      await getRequestSecurityRejection(
        remoteRequest(authorization),
        undefined,
        createFailedAuthRateLimiter({ threshold: 1 }),
      ),
      undefined,
    );

    const limiter = createFailedAuthRateLimiter({
      now: () => 26_500,
      threshold: 1,
    });
    assert.equal((
      await getRequestSecurityRejection(
        remoteRequest(basicAuthorization("wrong")),
        undefined,
        limiter,
      )
    ).status, 401);
    assert.equal(
      await getRequestSecurityRejection(
        remoteRequest(authorization),
        undefined,
        limiter,
        async () => {
          throw new Error("cached credential must not invoke verifier");
        },
      ),
      undefined,
    );
  } finally {
    delete process.env.GROK_WEB_ALLOWED_HOSTS;
    assert.equal(
      writeRemoteAccessConfig({ allowedHosts: [], password: null, loopbackRequest: true }).ok,
      true,
    );
  }
});

test("rejected verifiers release known and unknown reservations", async () => {
  const { createFailedAuthRateLimiter, getRequestSecurityRejection } =
    await jiti.import("./request-security.ts");
  process.env.GROK_WEB_PASSWORD = "correct horse battery staple";
  process.env.GROK_WEB_ALLOWED_HOSTS = "app.example.com";
  const rejectingVerifier = async () => {
    throw new Error("verification failed");
  };
  try {
    const knownLimiter = createFailedAuthRateLimiter({
      now: () => 27_000,
      threshold: 2,
    });
    await assert.rejects(
      getRequestSecurityRejection(
        remoteRequest(basicAuthorization("wrong")),
        "192.0.2.80",
        knownLimiter,
        rejectingVerifier,
      ),
      /verification failed/,
    );
    assert.equal((
      await getRequestSecurityRejection(
        remoteRequest(basicAuthorization("wrong")),
        "192.0.2.80",
        knownLimiter,
        async () => false,
      )
    ).status, 401);

    const unknownLimiter = createFailedAuthRateLimiter({
      now: () => 27_000,
      maxUnknownInFlight: 1,
    });
    await assert.rejects(
      getRequestSecurityRejection(
        remoteRequest(basicAuthorization("wrong")),
        undefined,
        unknownLimiter,
        rejectingVerifier,
      ),
      /verification failed/,
    );
    assert.equal(
      await getRequestSecurityRejection(
        remoteRequest(basicAuthorization("correct horse battery staple")),
        undefined,
        unknownLimiter,
        async () => true,
      ),
      undefined,
    );
  } finally {
    delete process.env.GROK_WEB_PASSWORD;
    delete process.env.GROK_WEB_ALLOWED_HOSTS;
  }
});

test("request security bypasses static PWA assets like the former proxy matcher", async () => {
  const { getRequestSecurityRejection } = await jiti.import("./request-security.ts");
  process.env.GROK_WEB_PASSWORD = "correct horse battery staple";
  try {
    const untrustedHost = "attacker.example:30141";
    for (const pathname of [
      "/sw.js",
      "/manifest.webmanifest",
      "/offline.html",
      "/icons/icon-192.png",
      "/_build/app.js",
    ]) {
      const request = new Request(`http://localhost:30141${pathname}`, {
        headers: { host: untrustedHost },
      });
      assert.equal(
        await getRequestSecurityRejection(request),
        undefined,
        `${pathname} must bypass the security bridge`,
      );
    }
  } finally {
    delete process.env.GROK_WEB_PASSWORD;
  }
});

test("request security rejects browser origins with a different scheme", async () => {
  const { getRequestSecurityRejection } = await jiti.import("./request-security.ts");
  const response = await getRequestSecurityRejection(new Request("https://localhost:30141/api/agent/new", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Untrusted API request" });
});

test("request security rejects browser origins with a different effective port", async () => {
  const { getRequestSecurityRejection } = await jiti.import("./request-security.ts");
  const response = await getRequestSecurityRejection(new Request("http://localhost:30141/api/agent/new", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30142",
      "sec-fetch-site": "same-site",
      "content-type": "application/json",
    },
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Untrusted API request" });
});

test("middleware forwards the actual peer address into request security", async () => {
  const { runRequestSecurityMiddleware } = await jiti.import("../src/request-peer.server.ts");
  process.env.GROK_WEB_PASSWORD = "correct horse battery staple";
  try {
    const request = new Request("http://127.0.0.1:30142/api/sessions", {
      headers: { host: "127.0.0.1:30142" },
    });
    let nextCalls = 0;
    const next = () => {
      nextCalls += 1;
      return new Response(null, { status: 204 });
    };

    const remote = await runRequestSecurityMiddleware(request, "192.0.2.70", next);
    assert.equal(remote.status, 401);
    assert.equal(nextCalls, 0);

    const loopback = await runRequestSecurityMiddleware(request, "::ffff:127.0.0.1", next);
    assert.equal(loopback.status, 204);
    assert.equal(nextCalls, 1);
  } finally {
    delete process.env.GROK_WEB_PASSWORD;
  }
});

test("middleware extracts the socket peer from a real TanStack request context", async () => {
  const { requestHandler } = await import("@tanstack/react-start/server");
  const { runRequestSecurityFromContext } = await jiti.import("../src/request-peer.server.ts");
  const handler = requestHandler((request) => runRequestSecurityFromContext(
    request,
    () => new Response(null, { status: 204 }),
  ));
  process.env.GROK_WEB_PASSWORD = "correct horse battery staple";
  try {
    const loopback = new Request("http://127.0.0.1:30142/api/sessions", {
      headers: {
        host: "127.0.0.1:30142",
        "x-forwarded-for": "192.0.2.90",
      },
    });
    loopback.context = { clientAddress: "::ffff:127.0.0.1" };
    assert.equal((await handler(loopback)).status, 204);

    const remote = new Request("http://127.0.0.1:30142/api/sessions", {
      headers: {
        host: "127.0.0.1:30142",
        "x-forwarded-for": "127.0.0.1",
      },
    });
    remote.context = { clientAddress: "192.0.2.90" };
    assert.equal((await handler(remote)).status, 401);
  } finally {
    delete process.env.GROK_WEB_PASSWORD;
  }
});

test("global middleware registers request security before filtered server-function CSRF", async () => {
  const startSource = await readFile(new URL("../src/start.ts", import.meta.url), "utf8");
  assert.match(startSource, /requestMiddleware/);
  assert.match(startSource, /handlerType === "serverFn"/);
  const securityIndex = startSource.indexOf("requestSecurityMiddleware");
  const csrfIndex = startSource.indexOf("serverFunctionCsrfMiddleware");
  assert.ok(securityIndex >= 0 && csrfIndex > securityIndex, "security middleware must precede CSRF middleware");
  assert.match(startSource, /request-peer\.server/);
  assert.doesNotMatch(startSource, /@tanstack\/react-start\/server|getRequestIP/);
  const peerSource = await readFile(new URL("../src/request-peer.server.ts", import.meta.url), "utf8");
  assert.match(peerSource, /getRequestIP/);
  assert.match(peerSource, /xForwardedFor:\s*false/);
});
