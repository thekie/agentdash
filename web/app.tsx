import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { DashboardSummary, DashboardView, WidgetView } from "../src/web-api.ts";

const currentPath = () => decodeURIComponent(location.pathname).replace(/^\/|\/$/g, "");
const subscribeToHistory = (onChange: () => void) => {
  addEventListener("popstate", onChange);
  return () => removeEventListener("popstate", onChange);
};

function navigate(path: string, options: { replace?: boolean } = {}) {
  history[options.replace ? "replaceState" : "pushState"](null, "", `/${path}`);
  dispatchEvent(new PopStateEvent("popstate"));
}

interface LinkProps {
  path: string;
  className?: string | undefined;
  style?: CSSProperties;
  current?: boolean;
  children: ReactNode;
}

function Link(props: LinkProps) {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    navigate(props.path);
  };
  return (
    <a
      href={`/${props.path}`}
      className={props.className}
      style={props.style}
      aria-current={props.current ? "page" : undefined}
      onClick={onClick}
    >
      {props.children}
    </a>
  );
}

/** `missing` stands for a 404, `undefined` for a read that has not finished. */
function useJson<T>(url: string): T | "missing" | undefined {
  const [state, setState] = useState<{ url: string; value: T | "missing" }>();
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
  }, [url]);
  return state?.url === url ? state.value : undefined;
}

const relative = new Intl.RelativeTimeFormat("en", { style: "narrow", numeric: "auto" });
const units = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
] as const;

/** Returns how long ago `iso` was, such as "2h ago" or "just now". */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = (now - Date.parse(iso)) / 1000;
  if (seconds < 60) return "just now";
  const [unit, size] = units.find(([, size]) => seconds >= size) ?? units[2];
  return relative.format(-Math.floor(seconds / size), unit);
}

function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time className={className} dateTime={iso} title={new Date(iso).toLocaleString()}>
      {timeAgo(iso)}
    </time>
  );
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

function Sidebar({ tree, path }: { tree: DashboardSummary[]; path: string }) {
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

function Widget({ widget }: { widget: WidgetView }) {
  const children = widget.children.map((child) => <Widget key={child.id} widget={child} />);
  if (widget.type === "columns") return <div className="cols">{children}</div>;
  if (widget.type === "section") {
    return (
      <section className="sec">
        {widget.title && <h2>{widget.title}</h2>}
        <div className="stack">{children}</div>
      </section>
    );
  }
  return (
    <section className="w" aria-label={widget.title ?? widget.type}>
      <div className="wh">
        <h2>{widget.title ?? widget.type}</h2>
        <RelativeTime className="ts" iso={widget.updatedAt} />
      </div>
      <p className="kind">{widget.type}</p>
    </section>
  );
}

function DashboardPage({ tree, path }: { tree: DashboardSummary[]; path: string }) {
  const dashboard = useJson<DashboardView>(`/api/dashboards/${encodeURI(path)}`);
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
      <div className="stack">
        {dashboard.widgets.map((w) => (
          <Widget key={w.id} widget={w} />
        ))}
      </div>
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

function EmptyState() {
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
      <p className="listen" role="status">
        <span className="dot" aria-hidden="true" />
        Listening on {location.host}.
      </p>
    </div>
  );
}

/** Renders the web UI: the empty state without Dashboards, otherwise the Dashboard at the URL. */
export function App() {
  const path = useSyncExternalStore(subscribeToHistory, currentPath);
  const tree = useJson<DashboardSummary[]>("/api/tree");
  const dashboards = tree === "missing" ? undefined : tree;
  const first = dashboards?.[0];
  useEffect(() => {
    if (path === "" && first) navigate(first.path, { replace: true });
  }, [path, first]);
  if (!dashboards) return null;
  if (!first) return <EmptyState />;
  return (
    <div className="app">
      <Sidebar tree={dashboards} path={path} />
      <main>{path && <DashboardPage tree={dashboards} path={path} />}</main>
    </div>
  );
}
