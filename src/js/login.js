import { API_BASE, FRONTEND_BASE } from './config.js';
import { fetchJson } from './utils.js';

const loginForm = document.getElementById('loginForm');

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const voter_id = document.getElementById('voter-id')?.value?.trim();
  const password = document.getElementById('password')?.value?.trim();
  if (!voter_id || !password) return;

  const token = voter_id;
  const headers = { Authorization: `Bearer ${token}` };

  try {
    const data = await fetchJson(
      `${API_BASE}/login?voter_id=${encodeURIComponent(voter_id)}&password=${encodeURIComponent(password)}`,
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
    }
  } catch (error) {
    console.error('Login failed:', error?.message || error);
  }
});
