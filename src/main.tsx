import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "@/app/App";
import { liveCatchesUp } from "@/lib/liveState";
import { cachedTheme } from "@/lib/settings";
import "@/styles/index.css";

/* Paint the last-used theme before anything loads. */
document.documentElement.dataset.theme = cachedTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    /* While the live socket is on, it does the catching up itself (lib/liveSocket.ts). */
    queries: { retry: 1, refetchOnWindowFocus: () => !liveCatchesUp(), refetchOnReconnect: () => !liveCatchesUp() },
  },
});

const container = document.getElementById("root");
if (!container) throw new Error("#root missing from index.html");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
