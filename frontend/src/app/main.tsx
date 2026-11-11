import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { TriageApp } from "./TriageApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TriageApp />
  </StrictMode>,
);
