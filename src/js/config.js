// Shared runtime configuration for browser modules.
// Prefer same-origin unless an explicit runtime override is provided.
const apiBaseOverride = window.__API_BASE__ || document.querySelector('meta[name="api-base"]')?.content;
export const API_BASE = String(apiBaseOverride || window.location.origin).replace(/\/+$/, '');
export const FRONTEND_BASE = String(window.location.origin).replace(/\/+$/, '');

