import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type QueryOutcome = { kind: "result"; value: unknown } | { kind: "no-service" | "cancelled" | "timeout" | "protocol-error" };

/** The response offer is synchronous even when the offered result is asynchronous. */
export function queryUsage(pi: ExtensionAPI, session: ExtensionContext["sessionManager"], sessionId: string,
  providerId: string, controller: AbortController, timeoutMs = 15_000): Promise<QueryOutcome> {
  return new Promise(resolve => {
    const signal = controller.signal;
    if (signal.aborted) { resolve({ kind: "cancelled" }); return; }
    let open = true, accepted = false, settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: QueryOutcome) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ kind: "cancelled" });
    signal.addEventListener("abort", onAbort, { once: true });
    deadline = setTimeout(() => { finish({ kind: "timeout" }); controller.abort(); }, timeoutMs);
    try {
      pi.events.emit("usage:query:v1", {
        session, sessionId, providerId, refresh: true, signal,
        respond(offered: unknown) {
          // Even a rejected duplicate or late promise must have its rejection observed.
          const promise = Promise.resolve(offered);
          if (!open || accepted || settled || signal.aborted) { void promise.catch(() => {}); return false; }
          accepted = true;
          void promise.then(value => finish({ kind: "result", value }), () => finish({ kind: "protocol-error" }));
          return true;
        },
      });
    } catch {
      finish({ kind: "protocol-error" });
      controller.abort();
    } finally { open = false; }
    if (!accepted && !settled) { finish({ kind: "no-service" }); controller.abort(); }
  });
}
