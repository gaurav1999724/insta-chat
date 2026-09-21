"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 4000;

// No WebSocket/SSE infra exists in this project (spec: kept proportional
// to what's actually needed) — this polls `router.refresh()` on an
// interval instead, which re-runs this route's Server Components
// (including the message list and the composer's `initialDraft`/
// `initialAutoSend` props) with fresh data, without a full page reload or
// losing any client-side state elsewhere on the page. Paused while the
// tab isn't visible so backgrounding this page doesn't keep hitting the
// database for nothing.
export function ConversationLiveRefresh() {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [router]);

  return null;
}
