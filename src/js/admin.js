import { API_BASE, FRONTEND_BASE } from './config.js';
import { byId, fetchJson, setStatus, downloadUrlAsFile } from './utils.js';

const MINIMUM_AGE_YEARS = 18;

function calculateAgeFromIso(isoDate) {
  if (!isoDate) return 0;
  const dob = new Date(`${isoDate}T00:00:00`);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDelta = today.getMonth() - dob.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < dob.getDate())) {
    age -= 1;
  }
  return age;
}

function todayIso() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

class AdminTools {
  constructor() {
    this.stream = null;
    this.photoData = null;
    this.reportTimer = null;
    this.qrImageDataUrl = null;
    this.nominationBound = false;
    this.electionStateTimer = null;
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
    byId('regPhotoUpload')?.addEventListener('change', (event) => this.handlePhotoUpload(event));
    byId('registerVoterBtn')?.addEventListener('click', () => this.registerVoter());
    byId('saveQrBtn')?.addEventListener('click', () => this.saveGeneratedQr());
    byId('downloadVoteAuditBtn')?.addEventListener('click', () => this.downloadVoteAuditReport());
    byId('clearDatabaseBtn')?.addEventListener('click', () => this.clearDatabaseData());
    byId('emergencyStopBtn')?.addEventListener('click', () => this.emergencyStopElection());
    byId('restartElectionBtn')?.addEventListener('click', () => this.restartElection());
    this.initNominationFrame();
    this.startLiveReport();
    this.refreshElectionState();
    this.startElectionStatePolling();
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

  async handlePhotoUpload(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.photoData = String(reader.result || '');
      if (byId('cardPhoto')) byId('cardPhoto').src = this.photoData;
      setStatus(byId('registerMsg'), 'Photo uploaded successfully.');
    };
    reader.onerror = () => {
      setStatus(byId('registerMsg'), 'Photo upload failed.', { isError: true });
    };
    reader.readAsDataURL(file);
  }

  async registerVoter() {
    const payload = {
      full_name: byId('regFullName')?.value?.trim(),
      date_of_birth: byId('regDateOfBirth')?.value?.trim(),
      photo_data: this.photoData,
    };

    if (!payload.full_name || !payload.date_of_birth) {
      setStatus(byId('registerMsg'), 'Full name and date of birth are required.', { isError: true });
      return;
    }
    const dateOfBirth = new Date(`${payload.date_of_birth}T00:00:00`);
    if (Number.isNaN(dateOfBirth.getTime()) || payload.date_of_birth >= todayIso()) {
      setStatus(byId('registerMsg'), 'Date of birth must be a valid past date.', { isError: true });
      return;
    }
    if (calculateAgeFromIso(payload.date_of_birth) < MINIMUM_AGE_YEARS) {
      setStatus(byId('registerMsg'), `Voter must be at least ${MINIMUM_AGE_YEARS} years old.`, { isError: true });
      return;
    }
    if (!payload.photo_data) {
      setStatus(byId('registerMsg'), 'Upload or capture a voter photo first.', { isError: true });
      return;
    }

    try {
      byId('regGeneratedVoterId').value = '';
      setStatus(byId('registerMsg'), 'Saving voter...', { isBusy: true });
      const data = await fetchJson(`${API_BASE}/admin/voters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      byId('regGeneratedVoterId').value = data.voter_id || '';
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
    byId('cardDob').textContent = data.date_of_birth || '';
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

  async emergencyStopElection() {
    const ok = window.confirm('This will immediately stop election activity and disable voting endpoints. Continue?');
    if (!ok) return;
    try {
      setStatus(byId('electionControlMsg'), 'Stopping election...', { isBusy: true });
      const data = await fetchJson(`${API_BASE}/admin/election/stop`, { method: 'POST' });
      this.renderElectionState(data);
      setStatus(byId('electionControlMsg'), `Election status: ${data.status}`, { isBusy: false });
    } catch (e) {
      setStatus(byId('electionControlMsg'), `Emergency stop failed: ${e.message}`, { isError: true, isBusy: false });
    }
  }

  async restartElection() {
    const resetResults = window.confirm(
      'Click OK to restart and clear backend vote audit/report data for a reconduct election.\nClick Cancel to reopen without clearing stored backend vote data.'
    );
    try {
      setStatus(byId('electionControlMsg'), 'Restarting election...', { isBusy: true });
      const data = await fetchJson(`${API_BASE}/admin/election/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset_results: resetResults }),
      });
      this.renderElectionState(data);
      setStatus(byId('electionControlMsg'), `Election status: ${data.status}. ${data.note || ''}`, { isBusy: false });
    } catch (e) {
      setStatus(byId('electionControlMsg'), `Restart failed: ${e.message}`, { isError: true, isBusy: false });
    }
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
      this.refreshElectionState();
      // Reset UI fragments
      byId('liveReportBody').innerHTML = '';
    } catch (e) {
      setStatus(byId('liveReportMsg'), `Clear error: ${e.message}`, { isError: true, isBusy: false });
    }
  }

  startElectionStatePolling() {
    if (this.electionStateTimer) clearInterval(this.electionStateTimer);
    this.electionStateTimer = setInterval(() => this.refreshElectionState(), 5000);
  }

  renderElectionState(state) {
    const node = byId('electionStateSummary');
    if (!node) return;

    const startText = state?.start_ts ? new Date(Number(state.start_ts) * 1000).toLocaleString() : 'Not set';
    const endText = state?.end_ts ? new Date(Number(state.end_ts) * 1000).toLocaleString() : 'Not set';
    const status = String(state?.status || 'running');
    const reconductCount = Number(state?.reconduct_count || 0);

    node.dataset.state = status;
    node.innerHTML = `
      <strong>Status:</strong> ${status.toUpperCase()}
      <span>Start: ${startText}</span>
      <span>End: ${endText}</span>
      <span>Reconducts: ${reconductCount}</span>
    `;
  }

  async refreshElectionState() {
    try {
      const data = await fetchJson(`${API_BASE}/election/dates`);
      this.renderElectionState(data);
    } catch (e) {
      const node = byId('electionStateSummary');
      if (!node) return;
      node.dataset.state = 'unknown';
      node.textContent = `Unable to load election state: ${e.message}`;
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
