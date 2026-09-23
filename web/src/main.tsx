import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// Order matters: tokens define the variables, base consumes them, and the app
// stylesheet layers component rules on top of both.
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

const host = document.getElementById("root");
if (!host) throw new Error("#root is missing from index.html");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
