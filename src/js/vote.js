import { API_BASE } from './config.js';
import { fetchJson, safeJsonParse } from './utils.js';

class VoteConfirmation {
  constructor() {
    this.candidateData = null;
    this.verifiedVoter = null;
    this.stream = null;
    this.preVoteImage = null; // captured at candidate press (per request)
    this.voteWindowTimer = null;
    this.voteWindowRemaining = 0;
    this.votingInProgress = false;
    this.readyCheckInProgress = false;
    this.liveGateCaptured = false; // auto capture (5s) after OK
    this.identityOk = false;
    this.qrAlreadyVoted = false;
    this.lastQrChecked = '';
    this.checkingQrVote = false;
    this.candidates = [];
    this.verifyPoll = null;
    this.electionState = { status: 'running', start_ts: 0, end_ts: 0 };
    this.electionStateTimer = null;
    this.init();
  }

  init() {
    // If the browser restores this page from BFCache (back/forward), force a hard reload
    // so we don't show previous voter's DOM state to the next voter.
    window.addEventListener('pageshow', (ev) => {
      if (ev && ev.persisted) window.location.reload();
    });

    this.showLastTransactionSummary();
    // Single-screen flow: do not carry selection across refreshes.
    localStorage.removeItem('selectedCandidate');
    this.candidateData = null;
    this.verifiedVoter = safeJsonParse(localStorage.getItem('verifiedVoter'), null);

    this.resetUiToStart();
    this.showConfirmationPage();
    this.setupEventListeners();
    this.startCamera();
    this.loadCandidatesAndRenderEvm();
    this.startVerificationWatcher();
    this.refreshElectionState();
    this.startElectionStatePolling();
    this.applyActionGuard();
  }

  resetUiToStart() {
    this.clearVoteWindowTimer();
    this.voteWindowRemaining = 0;

    // Clear any stale UI fragments (in case of partial reloads / cached DOM).
    const okBtn = document.getElementById('okVerifiedBtn');
    if (okBtn) {
      okBtn.disabled = true;
      okBtn.textContent = 'OK (Ready)';
    }

    const msg = document.getElementById('message');
    if (msg) msg.innerHTML = '';

    // Remove confirm button if it was injected previously.
    const finalBtn = document.getElementById('finalVoteBtn');
    if (finalBtn) finalBtn.remove();

    // Clear selection LEDs/rows
    document.querySelectorAll('.evm-row').forEach((r) => r.classList.remove('is-selected'));
    document.querySelectorAll('.evm-led').forEach((l) => l.classList.remove('is-on'));

    this.identityOk = false;
    this.liveGateCaptured = false;
    this.qrAlreadyVoted = false;
    this.lastQrChecked = '';
    this.checkingQrVote = false;
    this.preVoteImage = null;
    this.votingInProgress = false;
    this.readyCheckInProgress = false;

    this.setEvmStatus('Press "Start QR Scan" to begin verification for the next voter.');
  }

  clearVoteWindowTimer() {
    if (this.voteWindowTimer) {
      clearInterval(this.voteWindowTimer);
      this.voteWindowTimer = null;
    }
  }

  showLastTransactionSummary() {
    const raw = localStorage.getItem('lastTxSummary');
    if (!raw) return;
    const s = safeJsonParse(raw, null);
    if (!s || !s.tx_hash) return;

    const msg = document.getElementById('message');
    const tx = String(s.tx_hash || '');
    const block = String(s.block_number || '');
    const cand = String(s.candidate_name || '').trim();
    const party = String(s.party || '').trim();
    const when = String(s.vote_submitted_time || '').trim();

    if (msg) {
      const verifyHref = tx ? `./verify-vote.html?txHash=${encodeURIComponent(tx)}` : './verify-vote.html';
      msg.innerHTML = `
        <div style="padding:10px 12px;border-radius:10px;border:1px solid rgba(100,200,150,0.35);background:rgba(100,200,150,0.12);">
          <p style="margin:0;color:#c7ffd8;font-weight:700;">Last Vote Confirmed</p>
          <p style="margin:6px 0 0 0;color:#e6fff0;font-size:13px;">
            ${cand ? `<b>${cand}</b>${party ? ` (${party})` : ''}<br/>` : ''}
            Tx: <span style="word-break:break-all;">${tx}</span>${block ? `<br/>Block: ${block}` : ''}${when ? `<br/>Time: ${when}` : ''}
            <br/><a href="${verifyHref}" style="color:#9cd1ff;">Verify this vote</a>
          </p>
        </div>
      `;
    }

    // Auto-clear so next voter doesn't see stale data for too long.
    setTimeout(() => {
      try { localStorage.removeItem('lastTxSummary'); } catch { /* ignore */ }
      const m = document.getElementById('message');
      if (m) m.innerHTML = '';
    }, 8000);
  }

  setupEventListeners() {
    const cancelBtn = document.getElementById('cancelVoteBtn');
    const okBtn = document.getElementById('okVerifiedBtn');

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.cancelVote());
    }
    if (okBtn) {
      okBtn.addEventListener('click', () => this.onOkVerified());
    }
  }

  startElectionStatePolling() {
    if (this.electionStateTimer) clearInterval(this.electionStateTimer);
    this.electionStateTimer = setInterval(() => this.refreshElectionState(), 5000);
  }

  isElectionStopped() {
    return String(this.electionState?.status || '').toLowerCase() === 'stopped';
  }

  updateElectionStatusUi() {
    const banner = document.getElementById('electionStatusBanner');
    if (!banner) return;

    const startText = this.electionState?.start_ts
      ? new Date(Number(this.electionState.start_ts) * 1000).toLocaleString()
      : 'Not set';
    const endText = this.electionState?.end_ts
      ? new Date(Number(this.electionState.end_ts) * 1000).toLocaleString()
      : 'Not set';

    if (this.isElectionStopped()) {
      banner.dataset.state = 'stopped';
      banner.textContent = 'Election is currently stopped by the administrator. Voting and QR verification are disabled.';
      this.setEvmStatus('Election stopped. Wait for the administrator to restart the election.');
      return;
    }

    banner.dataset.state = 'running';
    banner.textContent = `Election is active. Start: ${startText} | End: ${endText}`;
  }

  async refreshElectionState() {
    try {
      this.electionState = await fetchJson(`${API_BASE}/election/dates`);
    } catch {
      this.electionState = this.electionState || { status: 'running', start_ts: 0, end_ts: 0 };
    } finally {
      this.updateElectionStatusUi();
      this.applyActionGuard();
    }
  }

  async startCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: true });
      let video = document.getElementById('voteCaptureVideo');
      if (!video) {
        video = document.createElement('video');
        video.id = 'voteCaptureVideo';
        video.width = 250;
        video.height = 180;
        video.autoplay = true;
        video.playsInline = true;
        document.getElementById('voteContainer')?.appendChild(video);
      }
      video.srcObject = this.stream;

      let canvas = document.getElementById('voteCaptureCanvas');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'voteCaptureCanvas';
        canvas.width = 250;
        canvas.height = 180;
        canvas.style.display = 'none';
        document.getElementById('voteContainer')?.appendChild(canvas);
      }

      // Initial disable until verification + photo.
      this.applyActionGuard();
    } catch (e) {
      this.showVoteError(`Camera unavailable: ${e.message}`);
    }
  }

  async verifyReadyFace(liveImageData) {
    if (!(this.verifiedVoter && this.verifiedVoter.qr_token)) {
      throw new Error('Please scan QR first.');
    }

    return fetchJson(`${API_BASE}/voter/ready-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        qr_token: this.verifiedVoter.qr_token,
        image_data: liveImageData,
      }),
    });
  }

  onOkVerified() {
    if (this.isElectionStopped()) {
      this.showVoteError('Election is currently stopped by the administrator.');
      return;
    }
    if (!this.verifiedVoter) {
      this.showVoteError('Please scan QR first.');
      return;
    }
    if (this.qrAlreadyVoted) {
      this.showVoteError('This QR voter has already voted. Use a new QR.');
      return;
    }
    if (this.identityOk) return;
    this.identityOk = true;
    this.readyCheckInProgress = true;

    const okBtn = document.getElementById('okVerifiedBtn');
    if (okBtn) {
      okBtn.disabled = true;
      okBtn.textContent = 'Ready (Capturing...)';
    }

    this.setEvmStatus('Ready for live photo. Auto capture in 5 seconds...');
    const messageContainer = document.getElementById('message');
    if (messageContainer) {
      messageContainer.innerHTML = '<p style="color:#87ceeb;">Hold still. Live photo will capture in 5 seconds, then face match check will run.</p>';
      messageContainer.classList.add('show', 'info');
    }

    setTimeout(async () => {
      const snap = this.captureCurrentFrame();
      if (!snap) {
        this.identityOk = false;
        this.readyCheckInProgress = false;
        if (okBtn) {
          okBtn.disabled = false;
          okBtn.textContent = 'OK (Ready)';
        }
        this.showVoteError('Live photo capture failed. Please try OK again.');
        return;
      }

      try {
        const readyCheck = await this.verifyReadyFace(snap);
        this.liveGateCaptured = true;
        this.readyCheckInProgress = false;
        this.verifiedVoter = {
          ...this.verifiedVoter,
          ready_check_image: snap,
          ready_check_score: readyCheck.face_similarity_score,
        };
        localStorage.setItem('verifiedVoter', JSON.stringify(this.verifiedVoter));

        this.setEvmStatus(
          `Face matched (${readyCheck.face_similarity_score}). Now press a BLUE button to select candidate.`
        );
        if (messageContainer) {
          messageContainer.innerHTML = `<p style="color:#90ee90;">Face matched with voter card image. Score: <b>${readyCheck.face_similarity_score}</b>. You can vote now.</p>`;
          messageContainer.classList.add('show', 'info');
        }
        if (okBtn) {
          okBtn.disabled = true;
          okBtn.textContent = 'Ready';
        }
        this.applyActionGuard();
      } catch (error) {
        this.identityOk = false;
        this.liveGateCaptured = false;
        this.readyCheckInProgress = false;
        if (okBtn) {
          okBtn.disabled = false;
          okBtn.textContent = 'OK (Ready)';
        }
        this.showVoteError(error?.message || 'Live face verification failed. Please try again.');
      }
    }, 5000);
  }

  showConfirmationPage() {
    const voteContainer = document.getElementById('voteContainer');

    if (voteContainer) voteContainer.classList.add('active');

    document.getElementById('pageTitle').textContent = 'Vote';
  }

  startVerificationWatcher() {
    this.applyActionGuard();
    if (this.verifyPoll) clearInterval(this.verifyPoll);
    this.verifyPoll = setInterval(() => {
      const v = safeJsonParse(localStorage.getItem('verifiedVoter'), null);
      const was = Boolean(this.verifiedVoter);
      this.verifiedVoter = v;
      if (!was && v) {
        this.setEvmStatus(`QR verified: ${v.full_name} (${v.voter_id}). Tap OK (Ready).`);
      }

      const qr = (this.verifiedVoter && this.verifiedVoter.qr_token) ? String(this.verifiedVoter.qr_token) : '';
      if (qr && qr !== this.lastQrChecked && !this.checkingQrVote) {
        this.refreshQrVoteStatus(qr).catch(() => {});
      }
      this.applyActionGuard();
    }, 600);
  }

  async refreshQrVoteStatus(qrToken) {
    this.checkingQrVote = true;
    try {
      this.lastQrChecked = String(qrToken || '');

      if (!window.App) {
        this.qrAlreadyVoted = false;
        return;
      }

      if (!window.App.voting || !window.App.account) {
        try {
          await window.App.eventStart();
        } catch {
          // ignore
        }
      }

      if (typeof window.App.readCheckVoteByQr === 'function') {
        const voted = await window.App.readCheckVoteByQr(String(qrToken));
        this.qrAlreadyVoted = Boolean(voted);
      } else {
        this.qrAlreadyVoted = false;
      }

      if (this.qrAlreadyVoted) {
        this.setEvmStatus('This QR voter has already voted. Use a new QR for next voter.');
      }
    } finally {
      this.checkingQrVote = false;
      this.applyActionGuard();
    }
  }

  applyActionGuard() {
    const verified = Boolean(this.verifiedVoter && this.verifiedVoter.qr_token);
    const okBtn = document.getElementById('okVerifiedBtn');
    if (okBtn) okBtn.disabled = this.isElectionStopped() || !verified || this.identityOk || this.qrAlreadyVoted || this.readyCheckInProgress;

    // EVM buttons locked until: QR verified + user OK + live auto capture done.
    const canSelect = !this.isElectionStopped() && verified && !this.qrAlreadyVoted && this.identityOk && this.liveGateCaptured;
    document.querySelectorAll('.evm-btn').forEach((b) => {
      b.disabled = !canSelect;
      b.title = canSelect ? '' : (this.isElectionStopped()
        ? 'Election is stopped by the administrator.'
        : 'Complete QR verification and OK (Ready) first.');
    });
  }

  async loadCandidatesAndRenderEvm() {
    const rowsEl = document.getElementById('evmRows');
    if (!rowsEl) return;

    try {
      const data = await fetchJson(`${API_BASE}/candidates`);
      this.candidates = (data && data.items) ? data.items : [];
    } catch {
      this.candidates = [];
    }

    rowsEl.innerHTML = '';
    if (!this.candidates || this.candidates.length === 0) {
      rowsEl.innerHTML = '<div style="padding:12px;color:#111827;font-weight:700;">No candidates available.</div>';
      this.setEvmStatus('No candidates found in DB.');
      return;
    }

    for (let i = 0; i < this.candidates.length; i++) {
      const c = this.candidates[i];
      const id = Number(c.candidate_id);
      const name = String(c.name || '').trim();
      const party = String(c.party || '').trim();

      const row = document.createElement('div');
      row.className = 'evm-row';
      row.dataset.candidateId = String(id);

      row.innerHTML = `
        <div class="evm-left">
          <div class="evm-serial">${i + 1}</div>
          <div class="evm-cand">
            <div class="evm-name"></div>
            <div class="evm-party"></div>
          </div>
          <div class="evm-symbol-box" aria-hidden="true">SYM</div>
        </div>
        <div class="evm-right">
          <span class="evm-led" aria-hidden="true"></span>
          <button class="evm-btn" type="button">Vote</button>
        </div>
      `;

      row.querySelector('.evm-name').textContent = name || 'Unknown';
      row.querySelector('.evm-party').textContent = party || '';
      this.renderPartySymbol(row.querySelector('.evm-symbol-box'), c);

      const btn = row.querySelector('.evm-btn');
      btn.dataset.candidateId = String(id);
      btn.dataset.candidateName = name;
      btn.dataset.candidateParty = party;
      btn.addEventListener('click', () => this.onCandidatePressed(btn));

      rowsEl.appendChild(row);
    }

    // No preselect in single-screen flow.
  }

  setEvmStatus(text) {
    const el = document.getElementById('evmStatusMsg');
    if (!el) return;
    el.textContent = text || '';
  }

  renderPartySymbol(node, candidate) {
    if (!node) return;

    const imagePath = String(candidate?.party_symbol_image || '').trim();
    const symbol = String(candidate?.symbol || '').trim();
    const party = String(candidate?.party || '').trim();

    node.innerHTML = '';
    if (imagePath) {
      const img = document.createElement('img');
      img.src = `${API_BASE}/${imagePath.replace(/^\/+/, '')}`;
      img.alt = `${party || 'Party'} symbol`;
      img.className = 'evm-symbol-image';
      node.appendChild(img);
      return;
    }

    const fallback = (symbol || party || 'SYM').slice(0, 3).toUpperCase();
    node.textContent = fallback;
  }

  onCandidatePressed(btn) {
    if (this.isElectionStopped()) {
      this.showVoteError('Election is currently stopped by the administrator.');
      return;
    }
    if (!(this.verifiedVoter && this.verifiedVoter.qr_token)) {
      this.showVoteError('Please scan QR first.');
      return;
    }
    if (this.qrAlreadyVoted) {
      this.showVoteError('This QR voter has already voted. Use a new QR.');
      return;
    }
    if (!(this.identityOk && this.liveGateCaptured)) {
      this.showVoteError('Tap OK (Ready) and wait for live photo capture first.');
      return;
    }

    const id = Number(btn?.dataset?.candidateId);
    const name = String(btn?.dataset?.candidateName || '').trim();
    const party = String(btn?.dataset?.candidateParty || '').trim();
    if (!id) return;

    // Capture vote image in background immediately (stored to DB as BLOB via /vote/audit).
    const snap = this.captureCurrentFrame();
    if (!snap) {
      this.showVoteError('Photo capture failed. Allow camera and try again.');
      return;
    }
    this.preVoteImage = snap;

    // Visual selection: one active LED only.
    document.querySelectorAll('.evm-row').forEach((r) => r.classList.remove('is-selected'));
    document.querySelectorAll('.evm-led').forEach((l) => l.classList.remove('is-on'));

    const row = btn.closest('.evm-row');
    const led = row?.querySelector('.evm-led');
    row?.classList.add('is-selected');
    led?.classList.add('is-on');

    // Press animation
    btn.classList.add('is-pressed');
    setTimeout(() => btn.classList.remove('is-pressed'), 140);

    // Update candidateData used for voting/audit.
    this.candidateData = {
      id,
      name: name || 'Unknown',
      party: party || 'Unknown',
      verified_voter_id: this.verifiedVoter?.voter_id || '',
    };
    localStorage.setItem('selectedCandidate', JSON.stringify(this.candidateData));

    // Confirmation prompt
    const ok = window.confirm(`Confirm vote?\n\nCandidate: ${this.candidateData.name}\nParty: ${this.candidateData.party}`);
    if (!ok) {
      this.setEvmStatus('Cancelled. Select a candidate.');
      return;
    }

    this.setEvmStatus(`Selected: ${this.candidateData.name}. Tap "Vote Confirm" within 30 seconds.`);
    this.startVoteWindow();
  }

  captureCurrentFrame() {
    const video = document.getElementById('voteCaptureVideo');
    const canvas = document.getElementById('voteCaptureCanvas');
    if (!video || !canvas) return null;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  }

  startVoteWindow() {
    const messageContainer = document.getElementById('message');
    this.voteWindowRemaining = 30;

    if (!document.getElementById('finalVoteBtn')) {
      const btn = document.createElement('button');
      btn.id = 'finalVoteBtn';
      btn.className = 'btn btn-success';
      btn.type = 'button';
      btn.textContent = 'Vote Confirm (30)';
      btn.disabled = false;
      btn.addEventListener('click', () => this.submitVote());
      document.querySelector('.button-group')?.appendChild(btn);
    }

    const finalBtn = document.getElementById('finalVoteBtn');
    finalBtn.disabled = false;
    finalBtn.textContent = `Vote Confirm (${this.voteWindowRemaining})`;

    if (messageContainer) {
      messageContainer.innerHTML = `<p style="color:#87ceeb;">Candidate: <b>${this.candidateData.name}</b> (${this.candidateData.party}). 30 sec ke andar confirm karo.</p>`;
      messageContainer.classList.add('show', 'info');
    }

    this.clearVoteWindowTimer();
    this.voteWindowTimer = setInterval(() => {
      if (this.votingInProgress) {
        return;
      }

      this.voteWindowRemaining -= 1;
      if (this.voteWindowRemaining <= 0) {
        this.clearVoteWindowTimer();
        finalBtn.disabled = true;
        finalBtn.textContent = 'Vote Window Closed';
        if (messageContainer) {
          messageContainer.innerHTML = '<p style="color:#ff7b7b;">30 sec window khatam. Candidate dubara select karo.</p>';
        }
        // reset selection so user must re-confirm
        localStorage.removeItem('selectedCandidate');
        this.candidateData = null;
        document.querySelectorAll('.evm-row').forEach((r) => r.classList.remove('is-selected'));
        document.querySelectorAll('.evm-led').forEach((l) => l.classList.remove('is-on'));
      } else {
        finalBtn.textContent = `Vote Confirm (${this.voteWindowRemaining})`;
      }
    }, 1000);
  }

  async submitVote() {
    if (this.votingInProgress) return;
    if (this.voteWindowRemaining <= 0) {
      this.showVoteError('Vote window expire ho chuka hai. Confirm Vote dubara dabao.');
      return;
    }
    if (!this.verifiedVoter) {
      this.showVoteError('Please scan QR first.');
      return;
    }
    if (!this.candidateData || !this.candidateData.id) {
      this.showVoteError('Please select a candidate.');
      return;
    }
    if (!this.preVoteImage) {
      this.showVoteError('Vote image missing. Select candidate again.');
      return;
    }

    const candidateSnapshot = { ...this.candidateData };
    const verifiedVoterSnapshot = { ...this.verifiedVoter };
    const preVoteImageSnapshot = this.preVoteImage;

    this.votingInProgress = true;
    this.clearVoteWindowTimer();

    const finalBtn = document.getElementById('finalVoteBtn');
    if (finalBtn) {
      finalBtn.disabled = true;
      finalBtn.textContent = 'Processing...';
    }

    this.setEvmStatus(`Submitting vote for ${candidateSnapshot.name}. Please wait for blockchain confirmation.`);
    const messageContainer = document.getElementById('message');
    if (messageContainer) {
      messageContainer.innerHTML = `
        <p style="color:#87ceeb;">
          Transaction submit ho rahi hai. Wallet confirm ho chuki hai to page band mat karo.
        </p>
      `;
      messageContainer.classList.add('show', 'info');
    }

    try {
      await this.refreshElectionState();
      if (this.isElectionStopped()) {
        throw new Error('Election is currently stopped by the administrator.');
      }

      localStorage.setItem('txStatus', 'pending');
      localStorage.setItem('txConfirmations', '0');

      if (!window.App || !window.App.voteByCandidateId) {
        throw new Error('Wallet/contract initialize nahi hua. Page refresh karke try karo.');
      }
      if (!window.App.voting || !window.App.account) {
        await window.App.eventStart();
      }

      const txRes = await window.App.voteByCandidateId(candidateSnapshot.id);
      const txInfo = this.extractTxInfo(txRes);
      if (!txInfo.txHash) {
        // Some providers return a PromiEvent or a Truffle "result" object; if we still
        // can't find a tx hash, we cannot track confirmation reliably.
        throw new Error('Transaction hash missing. Ensure MetaMask/Ganache is connected and try again.');
      }

      localStorage.setItem('currentTxHash', txInfo.txHash);
      if (txInfo.blockNumber) localStorage.setItem('blockNumber', String(txInfo.blockNumber));
      localStorage.setItem('txStatus', txInfo.blockNumber ? 'mined' : 'pending');
      localStorage.setItem('txConfirmations', txInfo.blockNumber ? '1' : '0');
      localStorage.setItem('voteSubmittedTime', new Date().toISOString());

      const auditPayload = this.buildAuditPayload(
        txInfo.txHash,
        candidateSnapshot,
        verifiedVoterSnapshot,
        preVoteImageSnapshot
      );
      localStorage.setItem('pendingVoteAudit', JSON.stringify(auditPayload));
      try {
        await this.saveVoteAudit(auditPayload);
      } catch (e) {
        // Do not block successful on-chain vote; loading page will retry sync.
        console.warn('Vote audit sync deferred:', e?.message || e);
      }
      window.location.href = './loading.html';
    } catch (error) {
      localStorage.setItem('txStatus', 'failed');
      localStorage.setItem('txError', error?.message || 'Vote failed');
      this.showVoteError(error?.message || 'Vote submission failed');
      if (finalBtn) {
        finalBtn.disabled = false;
        finalBtn.textContent = 'Vote Confirm';
      }
    } finally {
      this.votingInProgress = false;
    }
  }

  extractTxInfo(txRes) {
    // Supports multiple return shapes:
    // - web3 receipt: { transactionHash, blockNumber, ... }
    // - tx hash string: "0x..."
    // - truffle-contract result: { tx, receipt: { transactionHash, blockNumber, ... }, ... }
    // - nested receipt: { receipt: { transactionHash } }
    const out = { txHash: '', blockNumber: '' };

    if (!txRes) return out;

    if (typeof txRes === 'string') {
      out.txHash = txRes;
      return out;
    }

    const directHash = txRes.transactionHash || txRes.hash;
    if (directHash) out.txHash = String(directHash);

    const directBlock = txRes.blockNumber;
    if (directBlock) out.blockNumber = String(directBlock);

    if (!out.txHash && txRes.tx) out.txHash = String(txRes.tx);

    const r = txRes.receipt || txRes.result?.receipt;
    if (r) {
      if (!out.txHash && r.transactionHash) out.txHash = String(r.transactionHash);
      if (!out.blockNumber && r.blockNumber) out.blockNumber = String(r.blockNumber);
    }

    return out;
  }

  buildAuditPayload(txHash, candidateData, verifiedVoter, preVoteImage) {
    return {
      voter_id: verifiedVoter.voter_id,
      candidate_id: candidateData.id,
      candidate_name: candidateData.name,
      party: candidateData.party,
      tx_hash: txHash,
      pre_vote_image: preVoteImage,
      on_vote_day_image: verifiedVoter.on_vote_day_image || null,
    };
  }

  async saveVoteAudit(payload) {
    const res = await fetch(`${API_BASE}/vote/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'Vote audit save failed');
    }
    localStorage.removeItem('pendingVoteAudit');
  }

  showVoteError(errorMessage) {
    this.setEvmStatus(errorMessage);
    const messageContainer = document.getElementById('message');
    if (messageContainer) {
      messageContainer.innerHTML = `<p style="color:#ff7b7b;">${String(errorMessage || 'Error')}</p>`;
      messageContainer.classList.add('show', 'info');
    }
  }

  cancelVote() {
    this.clearVoteWindowTimer();
    localStorage.removeItem('selectedCandidate');
    localStorage.removeItem('currentTxHash');
    localStorage.removeItem('txStatus');
    localStorage.removeItem('txError');
    // Keep verifiedVoter; allow re-selection without re-scan if user cancels.
    window.location.href = './vote.html';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new VoteConfirmation();
});
