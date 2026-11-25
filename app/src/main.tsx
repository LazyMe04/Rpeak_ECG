import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LocaleProvider, storedLang } from "./lib/i18n";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

// StrictMode is deliberately off: its double-invoked effects would fetch each
// 4 MB segment twice in development, which on this laptop is the difference
// between a snappy reload and a visible stall.
createRoot(root).render(
  <ErrorBoundary
    what="the app"
    lang={storedLang()}
    variant="full"
    // A render error cannot be retried by remounting a broken tree; a full
    // page load is the only thing that genuinely resets the app's state.
    onRetry={() => window.location.reload()}
  >
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </ErrorBoundary>,
);
