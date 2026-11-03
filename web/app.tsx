import { useEffect, useState, useSyncExternalStore } from "react";
import type { DashboardSummary, DashboardView, WidgetView } from "../src/web-api.ts";
import { type Connection, ConnectionCard, useLiveData } from "./connection.tsx";
import { Link, navigate } from "./link.tsx";
import { RelativeTime } from "./time.tsx";
import { Widgets } from "./widgets.tsx";

const currentPath = () => decodeURIComponent(location.pathname).replace(/^\/|\/$/g, "");
const subscribeToHistory = (onChange: () => void) => {
  addEventListener("popstate", onChange);
  return () => removeEventListener("popstate", onChange);
};

/**
 * `missing` stands for a 404, `undefined` for a first read of `url` that has not finished. A new
 * `revision` reads again and keeps the last value until the answer arrives.
 */
function useJson<T>(url: string, revision: number): T | "missing" | undefined {
  const [state, setState] = useState<{ url: string; value: T | "missing" }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` only triggers another read.
  useEffect(() => {
    let isCurrent = true;
    void fetch(url).then(async (response) => {
      if (response.status !== 404 && !response.ok) throw new Error(`${url}: ${response.status}`);
      const value: T | "missing" = response.ok ? await response.json() : "missing";
      if (isCurrent) setState({ url, value });
    });
    return () => {
      isCurrent = false;
    };
  }, [url, revision]);
  return state?.url === url ? state.value : undefined;
}

function latestChange(dashboard: DashboardView): string {
  const times = (widgets: WidgetView[]): string[] =>
    widgets.flatMap((w) => [w.updatedAt, ...times(w.children)]);
  const all = [dashboard.updatedAt, ...times(dashboard.widgets)];
  return new Date(Math.max(...all.map((t) => Date.parse(t)))).toISOString();
}

const Mark = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
    <rect width="28" height="28" rx="9" fill="var(--ink)" />
    <rect x="7" y="12.5" width="9" height="3" rx="1.5" fill="var(--panel)" />
    <circle cx="20" cy="14" r="2.2" fill="var(--accent)" />
  </svg>
);

interface SidebarProps {
  tree: DashboardSummary[];
  path: string;
  connection: Connection;
}

function Sidebar({ tree, path, connection }: SidebarProps) {
  return (
    <nav className="side" aria-label="Dashboards">
      <div className="brand">
        <Mark />
        agentdash
      </div>
      <p className="lbl">Areas</p>
      <div className="nav">
        {tree.map((d) => {
          const depth = d.path.split("/").length - 1;
          return (
            <Link
              key={d.id}
              path={d.path}
              className={depth ? undefined : "area"}
              style={{ paddingLeft: 12 + depth * 22 }}
              current={d.path === path}
            >
              <span aria-hidden="true">{d.icon ?? "📄"}</span>
              <span>{d.title}</span>
            </Link>
          );
        })}
      </div>
      <ConnectionCard connection={connection} />
    </nav>
  );
}

function Breadcrumbs({ tree, dashboard }: { tree: DashboardSummary[]; dashboard: DashboardView }) {
  const slugs = dashboard.path.split("/");
  const parents = slugs
    .slice(0, -1)
    .map((_, i) => tree.find((d) => d.path === slugs.slice(0, i + 1).join("/")))
    .filter((d) => d !== undefined);
  if (parents.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb">
      <ol className="crumbs">
        {parents.map((d) => (
          <li key={d.id}>
            <Link path={d.path}>
              <span aria-hidden="true">{d.icon}</span>
              {d.title}
            </Link>
          </li>
        ))}
        <li aria-current="page">{dashboard.title}</li>
      </ol>
    </nav>
  );
}

interface DashboardPageProps {
  tree: DashboardSummary[];
  path: string;
  revision: number;
}

function DashboardPage({ tree, path, revision }: DashboardPageProps) {
  const dashboard = useJson<DashboardView>(`/api/dashboards/${encodeURI(path)}`, revision);
  if (dashboard === undefined) return null;
  if (dashboard === "missing") {
    return (
      <div className="page">
        <h1>No such Dashboard</h1>
        <p className="desc">
          It does not exist or was archived.{" "}
          <Link path={tree[0]?.path ?? ""}>Open the first Area</Link>
        </p>
      </div>
    );
  }
  return (
    <div className="page">
      <Breadcrumbs tree={tree} dashboard={dashboard} />
      <header className="head">
        <div>
          <h1>
            <span className="ic52" aria-hidden="true">
              {dashboard.icon ?? "📄"}
            </span>
            {dashboard.title}
          </h1>
          {dashboard.description && <p className="desc">{dashboard.description}</p>}
        </div>
        <span className="pill">
          Updated <RelativeTime iso={latestChange(dashboard)} />
        </span>
      </header>
      <Widgets widgets={dashboard.widgets} />
    </div>
  );
}

function Command({ text }: { text: string }) {
  const [isCopied, setIsCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1500);
    });
  };
  return (
    <div className="cmd">
      <pre>{text}</pre>
      <button type="button" onClick={copy}>
        {isCopied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function EmptyState({ connection }: { connection: Connection }) {
  const url = `${location.origin}/mcp`;
  const desktop = { mcpServers: { agentdash: { command: "npx", args: ["mcp-remote", url] } } };
  return (
    <div className="empty">
      <div className="brand">
        <Mark />
        agentdash
      </div>
      <div className="card">
        <h1>No dashboards yet</h1>
        <p className="lead">
          Your Agents write this page. Connect one, then ask it something like{" "}
          <b>“Build me a Finance area with my monthly budget.”</b>
        </p>
        <section className="client">
          <h2>
            Claude Code <span>run in a terminal</span>
          </h2>
          <Command text={`claude mcp add --transport http agentdash ${url}`} />
        </section>
        <p className="or">or</p>
        <section className="client">
          <h2>
            Claude Desktop <span>add to claude_desktop_config.json, then restart</span>
          </h2>
          <Command text={JSON.stringify(desktop, null, 2)} />
        </section>
      </div>
      {connection === "live" ? (
        <p className="listen" role="status">
          <span className="dot" aria-hidden="true" />
          Listening on {location.host}. This page fills in by itself.
        </p>
      ) : (
        <ConnectionCard connection={connection} />
      )}
    </div>
  );
}

/** Renders the web UI: the empty state without Dashboards, otherwise the Dashboard at the URL. */
export function App() {
  const path = useSyncExternalStore(subscribeToHistory, currentPath);
  const { connection, revision } = useLiveData();
  const tree = useJson<DashboardSummary[]>("/api/tree", revision);
  const dashboards = tree === "missing" ? undefined : tree;
  const first = dashboards?.[0];
  const isEmpty = dashboards?.length === 0;
  useEffect(() => {
    if (isEmpty && path !== "") navigate("", { replace: true });
    if (path === "" && first) navigate(first.path, { replace: true });
  }, [path, first, isEmpty]);
  if (!dashboards) return null;
  if (!first) return <EmptyState connection={connection} />;
  return (
    <div className="app">
      <Sidebar tree={dashboards} path={path} connection={connection} />
      <main>{path && <DashboardPage tree={dashboards} path={path} revision={revision} />}</main>
    </div>
  );
}
