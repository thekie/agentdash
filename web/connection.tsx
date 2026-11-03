import { useEffect, useState } from "react";

/** Describes the link between the browser and the server. */
export type Connection = "live" | "reconnecting" | "stopped";

const stoppedAfterMs = 10_000;

/**
 * Opens the stream of changes. Returns the state of the connection and a `revision`. The `revision`
 * grows on each change and each reconnect.
 */
export function useLiveData(): { connection: Connection; revision: number } {
  const [connection, setConnection] = useState<Connection>("live");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const source = new EventSource("/api/events");
    let stoppedTimer: ReturnType<typeof setTimeout> | undefined;
    const bumpRevision = () => setRevision((r) => r + 1);
    source.onmessage = bumpRevision;
    source.onopen = () => {
      clearTimeout(stoppedTimer);
      stoppedTimer = undefined;
      setConnection("live");
      bumpRevision();
    };
    // After a network failure, the browser retries and fires `error` for each failed retry.
    source.onerror = () => {
      stoppedTimer ??= setTimeout(() => setConnection("stopped"), stoppedAfterMs);
      setConnection((c) => (c === "stopped" ? c : "reconnecting"));
    };
    return () => {
      source.close();
      clearTimeout(stoppedTimer);
    };
  }, []);
  return { connection, revision };
}

/** Draws the state of the connection with its label. */
export function ConnectionCard({ connection }: { connection: Connection }) {
  return (
    <div className={`conn ${connection}`} role="status">
      {connection !== "stopped" && <span className="dot" aria-hidden="true" />}
      {connection === "live" && <div>Live</div>}
      {connection === "reconnecting" && (
        <div>
          Reconnecting…<small>Showing the last data we received</small>
        </div>
      )}
      {connection === "stopped" && (
        <div>
          Server stopped
          <small>
            Run <code>npx agentdash</code> to start it again
          </small>
        </div>
      )}
    </div>
  );
}
