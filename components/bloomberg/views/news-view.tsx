"use client";

// The NEWS view moved to `views/news/` (watchlist · newsfeed · social + polymarket
// column). This module stays as the import path used by the terminal layout's
// dynamic import and the prefetch hook.
export { default } from "./news/index";
