export function byId(id) {
  return document.getElementById(id);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  const data = safeJsonParse(text, null);
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) ? (data.detail || data.message) : (text || `HTTP ${res.status}`);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function setStatus(el, text, { isError = false, isBusy = false } = {}) {
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#ff6b6b' : '#64c898';
  el.dataset.busy = isBusy ? '1' : '0';

  // retrigger a tiny fade-in for better UX
  el.classList.remove('fade-in');
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight;
  el.classList.add('fade-in');
}

export async function downloadUrlAsFile(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const objectUrl = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(objectUrl);
}

