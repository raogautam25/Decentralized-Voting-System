import { API_BASE, FRONTEND_BASE } from './config.js';
import { byId, fetchJson, setStatus, downloadUrlAsFile } from './utils.js';

class AdminTools {
  constructor() {
    this.stream = null;
    this.photoData = null;
    this.reportTimer = null;
    this.qrImageDataUrl = null;
    this.nominationBound = false;
    this.init();
  }

  getAdminJwt() {
    // Primary source: localStorage from login flow.
    let token = (localStorage.getItem('jwtTokenAdmin') || '').trim();

    // Fallback: query param on admin.html itself (Express authorizer uses this too).
    if (!token) {
      try {
        const u = new URL(window.location.href);
        const auth = (u.searchParams.get('Authorization') || '').trim();
        if (auth.startsWith('Bearer ')) {
          token = auth.slice('Bearer '.length).trim();
          if (token) localStorage.setItem('jwtTokenAdmin', token);
        }
      } catch {
        // ignore
      }
    }

    return token;
  }

  init() {
    byId('startAdminCam')?.addEventListener('click', () => this.startCamera());
    byId('captureAdminPhoto')?.addEventListener('click', () => this.capturePhoto());
    byId('registerVoterBtn')?.addEventListener('click', () => this.registerVoter());
    byId('saveQrBtn')?.addEventListener('click', () => this.saveGeneratedQr());
    byId('downloadVoteAuditBtn')?.addEventListener('click', () => this.downloadVoteAuditReport());
    byId('clearDatabaseBtn')?.addEventListener('click', () => this.clearDatabaseData());
    this.initNominationFrame();
    this.startLiveReport();
  }

  async startCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const video = byId('adminCam');
      video.srcObject = this.stream;
    } catch (e) {
      setStatus(byId('registerMsg'), `Camera start failed: ${e.message}`, { isError: true });
    }
  }

  capturePhoto() {
    const video = byId('adminCam');
    const canvas = byId('adminCanvas');
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    this.photoData = canvas.toDataURL('image/jpeg', 0.9);
    setStatus(byId('registerMsg'), 'Photo captured.');
  }

  async registerVoter() {
    const payload = {
      voter_id: byId('regVoterId')?.value?.trim(),
      full_name: byId('regFullName')?.value?.trim(),
      password: byId('regPassword')?.value?.trim(),
      role: byId('regRole')?.value || 'user',
      photo_data: this.photoData,
    };

    if (!payload.voter_id || !payload.full_name || !payload.password) {
      setStatus(byId('registerMsg'), 'Voter ID, full name, password are required.', { isError: true });
      return;
    }
    if (!payload.photo_data) {
      setStatus(byId('registerMsg'), 'Capture photo first.', { isError: true });
      return;
    }

    try {
      setStatus(byId('registerMsg'), 'Saving voter...', { isBusy: true });
      const data = await fetchJson(`${API_BASE}/admin/voters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      this.renderCard(data, payload.photo_data);
      setStatus(byId('registerMsg'), `Voter saved: ${data.voter_id}`, { isBusy: false });
    } catch (e) {
      setStatus(byId('registerMsg'), `Save failed: ${e.message}`, { isError: true, isBusy: false });
    }
  }

  renderCard(data, photoData) {
    byId('voterCard').style.display = 'block';
    byId('cardName').textContent = data.full_name || '';
    byId('cardVoterId').textContent = data.voter_id || '';
    byId('cardRole').textContent = (data.role || 'user').toUpperCase();
    byId('cardPhoto').src = photoData;
    byId('cardQrToken').textContent = data.qr_token || '';

    const qrContainer = byId('cardQr');
    qrContainer.innerHTML = '';
    // qr library is loaded via CDN on admin page
    // eslint-disable-next-line no-undef
    new QRCode(qrContainer, {
      text: data.qr_token,
      width: 152,
      height: 152,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.H,
    });
    this.qrImageDataUrl = null;

    // qrcodejs may render either canvas or img; normalize for download.
    setTimeout(() => {
      const qrCanvas = qrContainer.querySelector('canvas');
      const qrImg = qrContainer.querySelector('img');
      if (qrCanvas) {
        this.qrImageDataUrl = qrCanvas.toDataURL('image/png');
      } else if (qrImg?.src) {
        this.qrImageDataUrl = qrImg.src;
      }
    }, 80);
  }

  saveGeneratedQr() {
    if (!this.qrImageDataUrl) {
      setStatus(byId('registerMsg'), 'Generate card first, then save QR.', { isError: true });
      return;
    }
    const voterId = byId('cardVoterId')?.textContent?.trim() || 'voter';
    const a = document.createElement('a');
    a.href = this.qrImageDataUrl;
    a.download = `qr_${voterId}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus(byId('registerMsg'), 'QR saved successfully.');
  }

  async downloadVoteAuditReport() {
    try {
      setStatus(byId('liveReportMsg'), 'Downloading report...', { isBusy: true });
      await downloadUrlAsFile(
        `${API_BASE}/admin/vote-audit/export`,
        `vote_audit_report_${new Date().toISOString().slice(0, 10)}.csv`
      );
      setStatus(byId('liveReportMsg'), 'Vote audit report downloaded.', { isBusy: false });
    } catch (e) {
      setStatus(byId('liveReportMsg'), `Download error: ${e.message}`, { isError: true, isBusy: false });
    }
  }

  async clearDatabaseData() {
    const ok = window.confirm(
      'This will DELETE ALL data from the database (voters, candidates, votes, audit, reports) and remove saved images.\n\nType YES in the next prompt to continue.'
    );
    if (!ok) return;
    const typed = window.prompt('Type YES to confirm database wipe:');
    if (typed !== 'YES') {
      setStatus(byId('liveReportMsg'), 'Cancelled.', { isError: true });
      return;
    }

    try {
      setStatus(byId('liveReportMsg'), 'Clearing database...', { isBusy: true });
      const data = await fetchJson(`${API_BASE}/admin/database/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_key: 'CLEAR_ALL' }),
      });
      setStatus(byId('liveReportMsg'), `Cleared: ${data.cleared_tables?.join(', ') || 'done'}`, { isBusy: false });
      // Reset UI fragments
      byId('liveReportBody').innerHTML = '';
    } catch (e) {
      setStatus(byId('liveReportMsg'), `Clear error: ${e.message}`, { isError: true, isBusy: false });
    }
  }

  startLiveReport() {
    this.fetchLiveReport();
    this.reportTimer = setInterval(() => this.fetchLiveReport(), 4000);
  }

  async fetchLiveReport() {
    try {
      const data = await fetchJson(`${API_BASE}/vote/report`);
      const body = byId('liveReportBody');
      if (!body) return;
      body.innerHTML = '';
      if (!data.items || data.items.length === 0) {
        body.innerHTML = '<tr><td colspan="5">No votes yet</td></tr>';
      } else {
        for (const item of data.items) {
          body.innerHTML += `
            <tr>
              <td>${item.rank_position}</td>
              <td>${item.candidate_name}</td>
              <td>${item.party}</td>
              <td>${item.vote_count}</td>
              <td>${item.updated_at}</td>
            </tr>
          `;
        }
      }
      setStatus(byId('liveReportMsg'), 'Live report auto-refresh every 4s.');
    } catch (e) {
      setStatus(byId('liveReportMsg'), `Report error: ${e.message}`, { isError: true });
    }
  }

  async syncChainToDb() {
    try {
      const token = localStorage.getItem('jwtTokenAdmin') || '';
      if (!token) {
        setStatus(byId('syncMsg'), 'Admin token missing. Login again.', { isError: true });
        return;
      }
      setStatus(byId('syncMsg'), 'Sync started...', { isBusy: true });
      const data = await fetchJson(`${FRONTEND_BASE}/admin/sync-chain-to-db?Authorization=Bearer ${token}`, { method: 'POST' });
      if (!data.ok) throw new Error(data.error || 'Sync failed');
      setStatus(
        byId('syncMsg'),
        `Synced ${data.db_candidates_synced}/${data.chain_candidates} candidates from chain to DB (net ${data.network_id}).`,
        { isBusy: false }
      );
    } catch (e) {
      setStatus(byId('syncMsg'), `Sync error: ${e.message}`, { isError: true, isBusy: false });
    }
  }

  initNominationFrame() {
    const frame = byId('nominationFrame');
    if (!frame) return;

    const token = this.getAdminJwt();
    if (!token) {
      setStatus(byId('nominationMsg'), 'Admin token missing. Login again.', { isError: true });
      return;
    }

    const auth = encodeURIComponent(`Bearer ${token}`);
    frame.src = `${FRONTEND_BASE}/candidate-nomination.html?Authorization=${auth}&v=20260214a`;
    setStatus(byId('nominationMsg'), 'Nomination form ready.');

    if (!this.nominationBound) {
      window.addEventListener('message', (ev) => this.onNominationMessage(ev));
      this.nominationBound = true;
    }
  }

  async onNominationMessage(ev) {
    const msg = ev?.data || {};
    if (!msg || msg.type !== 'NOMINATION_ADD_CANDIDATE') return;

    const requestId = msg.requestId || '';
    const payload = msg.payload || {};
    const name = String(payload.name || '').trim();
    const party = String(payload.party || '').trim();
    const symbol = String(payload.symbol || '').trim();

    const reply = (out) => {
      try {
        ev.source?.postMessage({ type: 'NOMINATION_ADD_CANDIDATE_RESULT', requestId, ...out }, ev.origin);
      } catch {
        // ignore
      }
    };

    if (!name || !party) {
      reply({ ok: false, error: 'Name and party are required for on-chain candidate.' });
      return;
    }

    try {
      // Use the already-initialized Web3 + contract instance from app.bundle.js.
      if (!window.App) {
        throw new Error('Blockchain app not initialized. Refresh admin page.');
      }
      if (!window.App.voting || !window.App.account) {
        // Ensure provider + contract are ready (MetaMask prompt may appear).
        await window.App.eventStart();
      }
      if (!window.App.voting || !window.App.account) {
        throw new Error('Wallet/contract not ready. Ensure MetaMask is connected to Ganache (chain id 1337).');
      }

      // Truffle-contract wrapper path
      if (window.App.voting.addCandidate?.estimateGas) {
        const gas = await window.App.voting.addCandidate.estimateGas(name, party, { from: window.App.account });
        await window.App.voting.addCandidate(name, party, { from: window.App.account, gas });
      } else if (window.App.voting.methods?.addCandidate) {
        // web3 Contract path
        const method = window.App.voting.methods.addCandidate(name, party);
        const gas = await method.estimateGas({ from: window.App.account });
        await method.send({ from: window.App.account, gas });
      } else {
        throw new Error('Contract method addCandidate is unavailable. Redeploy contract and refresh.');
      }

      const newIdRaw = await window.App.readCountCandidates();
      const candidate_id = Number(newIdRaw);
      if (!candidate_id) throw new Error('Could not read candidate id after transaction.');

      await fetchJson(`${API_BASE}/admin/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate_id, name, party, symbol }),
      });

      // Refresh admin-side candidate list (best effort).
      try {
        await window.App.loadCandidates?.();
      } catch {
        // ignore
      }

      reply({ ok: true, candidate_id });
    } catch (e) {
      reply({ ok: false, error: e?.message || String(e) });
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new AdminTools();
});
