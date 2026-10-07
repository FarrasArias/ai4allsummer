import React from "react";
import ReactDOM from "react-dom/client";
import AuthGate from "./components/AuthGate";
import "./index.css"; // pulls in theme + layout

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AuthGate />
    </React.StrictMode>
);
