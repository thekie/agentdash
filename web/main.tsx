/// <reference types="vite/client" />
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { PrototypeManySeriesSwitcher } from "./prototype-many-series.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");
createRoot(root).render(
  <>
    <App />
    <PrototypeManySeriesSwitcher />
  </>,
);
