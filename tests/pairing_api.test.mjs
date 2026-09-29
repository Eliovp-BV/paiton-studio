import test from "node:test";
import assert from "node:assert/strict";
import { createStudioApi } from "../web/studioApi.js";
const json = (value, status = 200) => Response.json(value, { status });
const pairRequired = () =>
  json(
    {
      error: "Pair this browser on the Studio host.",
      pairing_required: true,
      network_enabled: true,
    },
    401,
  );
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("pairing rejection opens the gate without replaying a write", async () => {
  let writes = 0,
    paired = false,
    gates = 0;
  const api = createStudioApi(async (path, request) => {
    if (path === "/api/session") return pairRequired();
    if (path === "/api/session/pair") {
      assert.equal(request.method, "POST");
      paired = true;
      return json({ token: "paired-session" });
    }
    writes++;
    if (!paired) return pairRequired();
    assert.equal(request.headers["X-Studio-Token"], "paired-session");
    return json({ accepted: true });
  });
  api.onPairingRequired = (error) => {
    gates++;
    assert.equal(error.networkEnabled, true);
  };
  await assert.rejects(api.connect(), (error) => error.pairingRequired);
  await assert.rejects(
    api("/jobs", { prompt: "Keep this unsent" }),
    (error) => error.pairingRequired,
  );
  assert.equal(writes, 1);
  assert.equal(gates, 2);
  await api.pair("one-time-code", "Browser");
  assert.equal(writes, 1);
  assert.deepEqual(await api("/jobs", { prompt: "Send manually" }), {
    accepted: true,
  });
  assert.equal(writes, 2);
});

test("a stale rejection cannot reopen the gate after successful pairing", async () => {
  const pending = deferred();
  let gates = 0;
  const api = createStudioApi(async (path) =>
    path === "/api/session/pair"
      ? json({ token: "new-token" })
      : pending.promise,
  );
  api.onPairingRequired = () => gates++;
  const request = api("/status");
  const rejected = assert.rejects(request, (error) => error.pairingRequired);
  await api.pair("one-time", "Browser");
  pending.resolve(pairRequired());
  await rejected;
  assert.equal(gates, 0);
});

test("a late session response cannot replace a newly paired token", async () => {
  const pending = deferred();
  const api = createStudioApi(async (path, request) => {
    if (path === "/api/session") return pending.promise;
    if (path === "/api/session/pair") return json({ token: "new-token" });
    assert.equal(request.headers["X-Studio-Token"], "new-token");
    return json({ ok: true });
  });
  const old = api.connect();
  await api.pair("one-time", "Browser");
  pending.resolve(json({ token: "old-token" }));
  await old;
  await api("/status");
});

test("a delayed remote session read preserves the newly paired browser cookie", async () => {
  const pending = deferred();
  let cookie = "old-session",
    gates = 0;
  function delivered(response) {
    // Browser cookies change before fetch resolves to application JavaScript.
    const header = response.headers.get("set-cookie");
    if (header)
      cookie = header.split(";", 1)[0].slice("studio_session=".length);
    return response;
  }
  const api = createStudioApi(async (path, request) => {
    if (path === "/api/session") {
      await pending.promise;
      // The matching backend regression requires remote reads to omit Set-Cookie.
      return delivered(json({ token: "old-session", local_owner: false }));
    }
    if (path === "/api/session/pair")
      return delivered(
        Response.json(
          { token: "new-session", local_owner: false },
          {
            headers: {
              "Set-Cookie":
                "studio_session=new-session; HttpOnly; SameSite=strict",
            },
          },
        ),
      );
    if (cookie !== "new-session") return pairRequired();
    if (request.headers["X-Studio-Token"] !== cookie)
      return json({ error: "Local session token required." }, 403);
    return json({ ok: true });
  });
  api.onPairingRequired = () => gates++;
  const old = api.connect();
  await api.pair("fresh-pairing-code", "Browser");
  pending.resolve();
  await old;
  assert.equal(cookie, "new-session");
  assert.deepEqual(await api("/status"), { ok: true });
  assert.equal(gates, 0);
});
