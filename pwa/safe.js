// pwa/safe.js — tiny escaping helper for the few places that must build HTML.
// Untrusted text (project names, model text, user messages) is normally rendered
// with textContent. When a template string is unavoidable this is the boundary.

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Reject javascript:, data: and other non-http(s) links from model output. */
export function safeHref(value) {
  const raw = String(value || '').trim();
  return /^https?:\/\//i.test(raw) ? raw : '#';
}
