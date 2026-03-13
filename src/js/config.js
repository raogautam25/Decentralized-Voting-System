// Shared runtime configuration for browser modules.
// Prefer same-origin when the UI is served from Render, otherwise fall back
// to the currently live backend service.
const RENDER_API_BASE = 'https://decentralized-voting-system-ok5o.onrender.com';
const apiBaseOverride = window.__API_BASE__ || document.querySelector('meta[name="api-base"]')?.content;
const isRenderHostedUi = window.location.hostname.endsWith('.onrender.com');

export const API_BASE = apiBaseOverride || (isRenderHostedUi ? window.location.origin : RENDER_API_BASE);
export const FRONTEND_BASE = window.location.origin;

