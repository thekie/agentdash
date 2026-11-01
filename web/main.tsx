import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");
createRoot(root).render(<h1>agentdash</h1>);
