import type { CSSProperties, MouseEvent, ReactNode } from "react";

/** Opens the Dashboard at `path` without reloading the page. */
export function navigate(path: string, options: { replace?: boolean } = {}) {
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

/** Draws a link to a Dashboard that opens it in place on a plain click. */
export function Link(props: LinkProps) {
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
