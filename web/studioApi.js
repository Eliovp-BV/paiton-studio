import { syncServerClock } from "./creationFeedback.js";

// Session renewal retries only requests rejected before endpoint execution.
// Ambiguous network failures on writes are never automatically replayed.
export function createStudioApi(fetcher = (...args) => fetch(...args)) {
  let token = "",
    sessionRequest = null;
  async function raw(path, body, method) {
    const verb = method || (body === undefined ? "GET" : "POST");
    const controller = new AbortController();
    const timeout = ["GET", "HEAD"].includes(verb)
      ? setTimeout(() => controller.abort(), 20000)
      : null;
    try {
      const response = await fetcher("/api" + path, {
        method: verb,
        headers: {
          ...(body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
          "X-Studio-Token": token,
        },
        body:
          body === undefined
            ? undefined
            : body instanceof FormData
              ? body
              : JSON.stringify(body),
        signal: controller.signal,
      });
      syncServerClock(response.headers.get("date"));
      if (!response.ok) {
        let detail, middlewareError;
        try {
          const data = await response.json();
          middlewareError = data.error;
          detail = data.error || data.detail?.[0]?.msg || data.detail;
        } catch (error) {
          if (controller.signal.aborted) throw error;
        }
        const error = Error(
          typeof detail === "string"
            ? detail
            : "The request could not finish. Please try again.",
        );
        error.status = response.status;
        // Only these exact security-middleware failures establish that the
        // endpoint did not execute. Other authorization failures stay intact.
        error.sessionRejected =
          (response.status === 401 &&
            middlewareError === "Open Studio to begin a local session.") ||
          (response.status === 403 &&
            middlewareError === "Local session token required.");
        throw error;
      }
      // Keep the deadline active while consuming the body as well as waiting
      // for headers. Otherwise a stalled body can stop status polling forever.
      return await (response.headers
        .get("content-type")
        ?.includes("application/json")
        ? response.json()
        : response.blob());
    } catch (error) {
      if (error.status) throw error;
      throw Error(
        controller.signal.aborted || error.name === "AbortError"
          ? "Studio is taking longer than expected to respond. Check that the host is running, then retry."
          : "Cannot reach the Studio host. Check your connection and keep Studio running on that computer.",
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  async function connect() {
    if (!sessionRequest) {
      sessionRequest = raw("/session")
        .then((session) => {
          token = session.token;
          return session;
        })
        .finally(() => {
          sessionRequest = null;
        });
    }
    return sessionRequest;
  }
  async function api(path, body, method) {
    if (path === "/session") return connect();
    const requestToken = token;
    try {
      return await raw(path, body, method);
    } catch (error) {
      if (!error.sessionRejected) throw error;
      // Another simultaneous request may already have renewed the session.
      if (requestToken === token) await connect();
      return raw(path, body, method);
    }
  }
  api.connect = connect;
  return api;
}
