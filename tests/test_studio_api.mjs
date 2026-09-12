import test from "node:test";
import assert from "node:assert/strict";
import { createStudioApi } from "../web/studioApi.js";

const json = (data, status = 200) => Response.json(data, { status });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("concurrent rejected requests share one renewal and retry with the new token", async () => {
  const renewed = deferred(),
    renewing = deferred();
  let sessions = 0;
  const calls = [];
  const api = createStudioApi(async (path, request) => {
    calls.push({
      path,
      token: request.headers["X-Studio-Token"],
      method: request.method,
    });
    if (path === "/api/session") {
      if (++sessions === 1) return json({ token: "old" });
      renewing.resolve();
      await renewed.promise;
      return json({ token: "new" });
    }
    if (request.headers["X-Studio-Token"] !== "new")
      return json({ error: "Open Studio to begin a local session." }, 401);
    return json({ saved: true });
  });
  await api.connect();
  const responses = Promise.all([
    api("/status"),
    api("/projects/p/jobs", { task: "image" }),
  ]);
  await renewing.promise;
  renewed.resolve();
  assert.deepEqual(await responses, [{ saved: true }, { saved: true }]);
  assert.equal(sessions, 2);
  for (const path of ["/api/status", "/api/projects/p/jobs"])
    assert.deepEqual(
      calls.filter((call) => call.path === path).map((call) => call.token),
      ["old", "new"],
    );
});

test("a renewed cookie in another tab recovers the exact stale-header middleware 403", async () => {
  let sessions = 0,
    writes = 0;
  const api = createStudioApi(async (path, request) => {
    if (path === "/api/session")
      return json({ token: ++sessions === 1 ? "old" : "new" });
    writes++;
    if (request.headers["X-Studio-Token"] === "old")
      return json({ error: "Local session token required." }, 403);
    assert.equal(request.body, JSON.stringify({ text: "Keep my draft" }));
    assert.equal(request.method, "PUT");
    return json({ revision: 2 });
  });
  await api.connect();
  assert.deepEqual(await api("/projects/p", { text: "Keep my draft" }, "PUT"), {
    revision: 2,
  });
  assert.equal(writes, 2);
  assert.equal(sessions, 2);
});

for (const status of [401, 403]) {
  test(`other authorization failures (${status}) never replay writes`, async () => {
    let calls = 0;
    const api = createStudioApi(async () => {
      calls++;
      return json({ error: "This action is not permitted." }, status);
    });
    await assert.rejects(
      api("/projects/p/jobs", { task: "image" }),
      (error) => error.status === status,
    );
    assert.equal(calls, 1);
  });
}

test("ambiguous network failure never automatically repeats a write", async () => {
  let calls = 0;
  const api = createStudioApi(async () => {
    calls++;
    throw new TypeError("Connection closed after submitting");
  });
  await assert.rejects(
    api("/projects/p/jobs", { task: "image" }),
    /Cannot reach the Studio host/,
  );
  assert.equal(calls, 1);
});

for (const contentType of ["application/json", "application/octet-stream"]) {
  test(`read deadline includes stalled ${contentType} response bodies`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const reading = deferred();
    let signal;
    const api = createStudioApi(async (path, request) => {
      signal = request.signal;
      const body = () =>
        new Promise((resolve, reject) => {
          reading.resolve();
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Stopped", "AbortError")),
            { once: true },
          );
        });
      return {
        ok: true,
        headers: new Headers({ "content-type": contentType }),
        json: body,
        blob: body,
      };
    });
    const request = api("/status");
    const rejected = assert.rejects(request, /taking longer than expected/);
    await reading.promise;
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(20001);
    await rejected;
    assert.equal(signal.aborted, true);
  });
}

test("failed renewal can be retried later and a repeated rejection is not replayed forever", async () => {
  let sessions = 0,
    calls = 0;
  const api = createStudioApi(async (path) => {
    if (path === "/api/session") {
      sessions++;
      if (sessions === 1) throw Error("Host unavailable");
      return json({ token: "new" });
    }
    calls++;
    return json({ error: "Open Studio to begin a local session." }, 401);
  });
  await assert.rejects(api.connect(), /Cannot reach/);
  await api.connect();
  await assert.rejects(api("/status"), (error) => error.status === 401);
  assert.equal(calls, 2);
  assert.equal(sessions, 3);
});
