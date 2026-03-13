const apiBaseOverride = window.__API_BASE__ || document.querySelector('meta[name="api-base"]')?.content;
const API_BASE = String(apiBaseOverride || window.location.origin).replace(/\/+$/, '');
const FRONTEND_BASE = String(window.location.origin).replace(/\/+$/, '');

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  const data = safeJsonParse(text, null);
  if (!res.ok) {
    const message = (data && (data.detail || data.message))
      ? (data.detail || data.message)
      : (text || `HTTP ${res.status}`);
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function setStatus(el, text, { isError = false, isBusy = false } = {}) {
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#ff6b6b' : '#64c898';
  el.dataset.busy = isBusy ? '1' : '0';
  el.classList.remove('fade-in');
  // Force reflow so the fade-in retriggers after repeated updates.
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight;
  el.classList.add('fade-in');
}

const loginForm = document.getElementById('loginForm');
const loginStatus = document.getElementById('login-status');
const submitButton = loginForm?.querySelector('button[type="submit"]');

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const voter_id = document.getElementById('voter-id')?.value?.trim();
  const password = document.getElementById('password')?.value?.trim();
  if (!voter_id || !password) {
    setStatus(loginStatus, 'Please enter username and password.', { isError: true });
    return;
  }

  const username = voter_id;
  const token = username;
  const headers = { Authorization: `Bearer ${token}` };

  try {
    if (submitButton) submitButton.disabled = true;
    setStatus(loginStatus, 'Signing in...', { isBusy: true });

    const data = await fetchJson(
      `${API_BASE}/login?username=${encodeURIComponent(username)}&voter_id=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      { method: 'GET', headers }
    );

    if (data.role === 'admin') {
      localStorage.setItem('jwtTokenAdmin', data.token);
      window.location.replace(`${FRONTEND_BASE}/admin.html?Authorization=Bearer ${data.token}`);
      return;
    }
    if (data.role === 'user') {
      localStorage.setItem('jwtTokenVoter', data.token);
      // Single voting screen: vote.html hosts QR verification + EVM UI.
      window.location.replace(`${FRONTEND_BASE}/vote.html?Authorization=Bearer ${data.token}`);
      return;
    }

    setStatus(loginStatus, 'Login succeeded, but no role was returned.', { isError: true });
  } catch (error) {
    console.error('Login failed:', error?.message || error);
    const message = error?.message === 'Failed to fetch'
      ? `Unable to reach the login API at ${API_BASE}. Check deployment URL and CORS.`
      : error?.status === 503
        ? 'Backend is reachable, but login is unavailable because MongoDB is not connected on the server.'
        : (error?.message || 'Login failed. Please try again.');
    setStatus(loginStatus, message, { isError: true });
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});
