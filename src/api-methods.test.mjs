import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getApiMethodRejection, matchApiRoutePattern } from "./api-methods.ts";

describe("API route method guard", () => {
  it("lets static /new and /running win over /api/agent/$id", () => {
    const newGet = getApiMethodRejection(new Request("http://127.0.0.1/api/agent/new"));
    assert.equal(newGet?.status, 405);
    assert.equal(newGet?.headers.get("Allow"), "POST");

    const runningPost = getApiMethodRejection(new Request("http://127.0.0.1/api/agent/running", { method: "POST" }));
    assert.equal(runningPost?.status, 405);
    assert.equal(runningPost?.headers.get("Allow"), "GET");

    const sessionGet = getApiMethodRejection(new Request("http://127.0.0.1/api/agent/abc-session"));
    assert.equal(sessionGet, undefined);
  });

  it("keeps more specific nested agent routes ahead of $id", () => {
    assert.equal(matchApiRoutePattern("/api/agent/new", "/api/agent/new"), true);
    assert.equal(matchApiRoutePattern("/api/agent/$id", "/api/agent/new"), true);
    const eventsGet = getApiMethodRejection(new Request("http://127.0.0.1/api/agent/abc/events", { method: "POST" }));
    assert.equal(eventsGet?.status, 405);
    assert.equal(eventsGet?.headers.get("Allow"), "GET");
    const runningEvents = getApiMethodRejection(new Request("http://127.0.0.1/api/agent/running/events", { method: "POST" }));
    assert.equal(runningEvents?.status, 405);
    assert.equal(runningEvents?.headers.get("Allow"), "GET");
  });
});
