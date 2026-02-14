import { API_BASE } from './config.js';
import { safeJsonParse } from './utils.js';

class VoterDashboard {
  constructor() {
    this.stream = null;
    this.scanTimer = null;
    this.lastDetectedToken = null;
    this.onVoteDayImage = null;
    this.detectQr = null;
    this.jsQrAvailable = false;
    this.html5Qr = null;
    this.scannerMode = null;
    this.lastScanAt = 0;
    this.verifiedVoter = null;
    this.qrDetected = false;
    this.captureDone = false;
    this.confirmed = false;
    this.activeQrToken = '';
    this.voteObserver = null;
    this.autoVerifying = false;
    this.init();
  }

  init() {
    // Handle BFCache: if user navigates back/forward, the DOM can be restored with old voter info.
    // Force reload to guarantee a clean "Start QR Scan" state for the next voter.
    window.addEventListener('pageshow', (ev) => {
      if (ev && ev.persisted) window.location.reload();
    });

    // If there is no active voter session token, never reuse previously verified voter details.
    // This is critical for booth-mode: after auto-logout, the next voter must start from QR scan.
    this.forceFreshStartIfNoVoterSession();

    this.clearStaleVerificationIfNeeded();
    this.loadVerifiedState();
    this.setupEventListeners();
    this.setupLogout();
    this.setupQrDetector();
    this.setupVoteGuard();
    this.updateActionButtons();
    this.applyVoteGuard();
  }

  forceFreshStartIfNoVoterSession() {
    const token = (localStorage.getItem('jwtTokenVoter') || '').trim();

    // Also accept Authorization query param as an active session indicator.
    let hasAuthParam = false;
    try {
      const u = new URL(window.location.href);
      const auth = (u.searchParams.get('Authorization') || '').trim();
      hasAuthParam = auth.startsWith('Bearer ') && auth.length > 20;
    } catch {
      // ignore
    }

    if (token || hasAuthParam) return;

    // No active voter session => wipe any stale verification state.
    this.verifiedVoter = null;
    this.qrDetected = false;
    this.captureDone = false;
    this.confirmed = false;
    this.activeQrToken = '';
    this.onVoteDayImage = null;
    this.lastDetectedToken = null;
    this.autoVerifying = false;

    localStorage.removeItem('verifiedVoter');
    localStorage.removeItem('selectedCandidate');
    this.resetVerificationUi();
  }

  clearStaleVerificationIfNeeded() {
    const txStatus = localStorage.getItem('txStatus');
    const voteCompleted = localStorage.getItem('lastVoteCompleted');
    // Previous voting cycle finished; force fresh QR verification.
    if (txStatus === 'confirmed' || txStatus === 'failed' || voteCompleted === '1') {
      // Reset in-memory session flags too (important when the page isn't fully reloaded
      // or when UI elements keep their disabled state).
      this.verifiedVoter = null;
      this.qrDetected = false;
      this.captureDone = false;
      this.confirmed = false;
      this.activeQrToken = '';
      this.onVoteDayImage = null;
      this.lastDetectedToken = null;
      this.autoVerifying = false;

      localStorage.removeItem('verifiedVoter');
      localStorage.removeItem('selectedCandidate');
      localStorage.removeItem('currentTxHash');
      localStorage.removeItem('txConfirmations');
      localStorage.removeItem('blockNumber');
      localStorage.removeItem('voteSubmittedTime');
      localStorage.removeItem('txError');
      localStorage.removeItem('txStatus');
      localStorage.removeItem('lastVoteCompleted');

      // Also reset visible UI immediately (even before user clicks "Start QR Scan").
      this.resetVerificationUi();
    }
  }

  resetVerificationUi() {
    try {
      const manual = document.getElementById('manualQrToken');
      if (manual) manual.value = '';

      const details = document.getElementById('scannedVoterDetails');
      if (details) details.innerHTML = '';

      const msg = document.getElementById('verifyMsg');
      if (msg) {
        msg.textContent = 'Press "Start QR Scan" to begin.';
        msg.style.color = '#d9e7ff';
      }
    } catch {
      // ignore
    }
  }

  loadVerifiedState() {
    const raw = localStorage.getItem('verifiedVoter');
    const parsed = raw ? safeJsonParse(raw, null) : null;
    if (parsed) {
      try {
        this.verifiedVoter = parsed;
        this.confirmed = true;
        this.qrDetected = true;
        this.captureDone = true;
        this.activeQrToken = this.verifiedVoter.qr_token || '';
        document.getElementById('manualQrToken').value = this.activeQrToken;
        this.setMsg('verifyMsg', `Verified: ${this.verifiedVoter.full_name} (${this.verifiedVoter.voter_id})`);
        this.renderScannedVoter(this.verifiedVoter);
      } catch {
        localStorage.removeItem('verifiedVoter');
      }
    }
  }

  setupEventListeners() {
    document.getElementById('startQrScan')?.addEventListener('click', () => this.startQrScan());
    document.getElementById('captureOnVoteDay')?.addEventListener('click', () => this.captureOnVoteDayImageDelayed());
    document.getElementById('confirmScannedVoter')?.addEventListener('click', () => this.confirmScannedVoter());

    $(document).on('click', '.vote-btn', (e) => {
      const btn = e.currentTarget || e.target;
      const candidateId = Number($(btn).data('candidate-id'));
      if (!this.verifiedVoter) {
        this.setMsg('verifyMsg', 'Pehle voter QR verify karo.', true);
        return;
      }
      this.proceedToVoteConfirmation(candidateId, btn);
    });
  }

  setupQrDetector() {
    if ('BarcodeDetector' in window) {
      this.detectQr = new BarcodeDetector({ formats: ['qr_code'] });
    }
    this.jsQrAvailable = typeof window.jsQR === 'function';
  }

  async startQrScan() {
    try {
      this.qrDetected = false;
      this.captureDone = false;
      this.confirmed = false;
      this.activeQrToken = '';
      this.onVoteDayImage = null;
      this.lastDetectedToken = null;
      this.verifiedVoter = null;
      this.autoVerifying = false;
      localStorage.removeItem('verifiedVoter');
      document.getElementById('manualQrToken').value = '';
      this.updateActionButtons();
      this.applyVoteGuard();

      if (this.scanTimer) {
        clearInterval(this.scanTimer);
      }

      if (window.Html5Qrcode) {
        try {
          await this.startHtml5QrScanner();
        } catch {
          this.scannerMode = null;
        }
      }

      if (this.scannerMode !== 'html5-qrcode') {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const video = document.getElementById('qrVideo');
        video.srcObject = this.stream;
      }

      if (this.scannerMode === 'html5-qrcode') {
        this.setMsg('verifyMsg', 'QR auto scan started (html5-qrcode).');
      } else if (this.detectQr) {
        this.scannerMode = 'barcode-detector';
        this.scanTimer = setInterval(() => this.scanFrame(), 700);
        this.setMsg('verifyMsg', 'QR auto scan started (BarcodeDetector).');
      } else if (this.jsQrAvailable) {
        this.scannerMode = 'jsqr';
        this.scanTimer = setInterval(() => this.scanFrameWithJsQr(), 700);
        this.setMsg('verifyMsg', 'QR auto scan started (jsQR fallback for Brave).');
      } else {
        this.setMsg('verifyMsg', 'QR auto scan unsupported. Manual token paste karke confirm karo.', true);
      }
    } catch (e) {
      this.setMsg('verifyMsg', `Camera error: ${e.message}`, true);
    }
  }

  async startHtml5QrScanner() {
    const scannerId = 'qrReader';
    const reader = document.getElementById(scannerId);
    if (!reader) return;

    if (!this.html5Qr) {
      this.html5Qr = new window.Html5Qrcode(scannerId);
    }

    const state = this.html5Qr.getState();
    const scanningState = (window.Html5QrcodeScannerState && window.Html5QrcodeScannerState.SCANNING) || 2;
    if (state === scanningState) {
      this.scannerMode = 'html5-qrcode';
      return;
    }

    const config = {
      fps: 12,
      qrbox: { width: 220, height: 220 },
      aspectRatio: 1.333334,
      disableFlip: false,
    };

    await this.html5Qr.start(
      { facingMode: 'environment' },
      config,
      async (decodedText) => {
        const now = Date.now();
        if (now - this.lastScanAt < 1500) return;
        this.lastScanAt = now;

        const token = String(decodedText || '').trim();
        if (!token || token === this.lastDetectedToken) return;
        this.lastDetectedToken = token;
        document.getElementById('manualQrToken').value = token;
        await this.handleTokenDetected(token);
      },
      () => {
        // ignore frame-level decode misses
      }
    );

    this.scannerMode = 'html5-qrcode';
  }

  async scanFrame() {
    if (!this.detectQr) return;
    const video = document.getElementById('qrVideo');
    if (!video || video.readyState < 2) return;
    try {
      const barcodes = await this.detectQr.detect(video);
      if (barcodes && barcodes.length > 0) {
        const token = barcodes[0].rawValue;
        if (token && token !== this.lastDetectedToken) {
          this.lastDetectedToken = token;
          document.getElementById('manualQrToken').value = token;
          await this.handleTokenDetected(token);
        }
      }
    } catch {
      // ignore frame-level errors
    }
  }

  async scanFrameWithJsQr() {
    if (!this.jsQrAvailable) return;
    const video = document.getElementById('qrVideo');
    const canvas = document.getElementById('qrCanvas');
    if (!video || !canvas || video.readyState < 2) return;

    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const w = canvas.width || 260;
      const h = canvas.height || 180;
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        const token = String(code.data).trim();
        if (token && token !== this.lastDetectedToken) {
          this.lastDetectedToken = token;
          document.getElementById('manualQrToken').value = token;
          await this.handleTokenDetected(token);
        }
      }
    } catch {
      // ignore frame-level errors
    }
  }

  async handleTokenDetected(token) {
    if (this.autoVerifying) return;
    const ok = await this.fetchVoterByQr(token);
    if (!ok) return;
    this.autoVerifying = true;
    this.qrDetected = true;
    this.activeQrToken = token;
    this.updateActionButtons();
    this.setMsg('verifyMsg', 'QR detected. Auto verifying...');
    await this.stopScanner();
    await this.startCapturePreview();
    const confirmed = await this.autoCaptureAndConfirm();
    if (!confirmed) {
      this.autoVerifying = false;
      this.setMsg('verifyMsg', 'Auto verify failed. Capture + Confirm buttons use karo.', true);
    }
    this.updateActionButtons();
  }

  async stopScanner() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    if (this.html5Qr && this.html5Qr.getState) {
      const scanningState = (window.Html5QrcodeScannerState && window.Html5QrcodeScannerState.SCANNING) || 2;
      if (this.html5Qr.getState() === scanningState) {
        try {
          await this.html5Qr.stop();
        } catch {
          // ignore stop errors
        }
      }
      try {
        this.html5Qr.clear();
      } catch {
        // ignore clear errors
      }
    }

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    this.scannerMode = null;
  }

  async startCapturePreview() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = document.getElementById('qrVideo');
      video.srcObject = this.stream;
    } catch (e) {
      this.setMsg('verifyMsg', `Camera preview error: ${e.message}`, true);
    }
  }

  async fetchVoterByQr(token) {
    try {
      const res = await fetch(`${API_BASE}/voter/by-qr?qr_token=${encodeURIComponent(token)}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'QR invalid');
      }
      this.renderScannedVoter(data);
      return true;
    } catch (e) {
      this.setMsg('verifyMsg', `QR fetch failed: ${e.message}`, true);
      return false;
    }
  }

  renderScannedVoter(voter) {
    const box = document.getElementById('scannedVoterDetails');
    const photoSrc = voter.photo_path ? `${API_BASE}/${voter.photo_path}` : '';
    box.innerHTML = `
      <p><b>Name:</b> ${voter.full_name || ''}</p>
      <p><b>Voter ID:</b> ${voter.voter_id || ''}</p>
      <p><b>Role:</b> ${voter.role || ''}</p>
      ${photoSrc ? `<img src="${photoSrc}" alt="voter-photo" style="width:100px;height:100px;object-fit:cover;border:1px solid #555;">` : ''}
    `;
  }

  captureOnVoteDayImage() {
    if (!this.qrDetected) {
      this.setMsg('verifyMsg', 'Pehle QR scan karo.', true);
      return;
    }

    const video = document.getElementById('qrVideo');
    const canvas = document.getElementById('qrCanvas');
    if (!video || video.readyState < 2) {
      this.setMsg('verifyMsg', 'Camera preview ready nahi hai.', true);
      return;
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    this.onVoteDayImage = canvas.toDataURL('image/jpeg', 0.9);
    this.captureDone = true;
    this.updateActionButtons();
    this.setMsg('verifyMsg', 'On-vote-day image captured.');
  }

  async captureOnVoteDayImageDelayed() {
    if (!this.qrDetected) {
      this.setMsg('verifyMsg', 'Pehle QR scan karo.', true);
      return;
    }
    this.setMsg('verifyMsg', 'Hold still... capturing in 2 seconds.');
    await new Promise((r) => setTimeout(r, 2000));
    this.captureOnVoteDayImage();
  }

  async autoCaptureAndConfirm() {
    const video = document.getElementById('qrVideo');
    const maxWaitMs = 2500;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (video && video.readyState >= 2) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!video || video.readyState < 2) return false;

    await this.captureOnVoteDayImageDelayed();
    if (!this.onVoteDayImage) return false;
    await this.confirmScannedVoter();
    return !!this.verifiedVoter;
  }

  async confirmScannedVoter() {
    const qrToken = this.activeQrToken || document.getElementById('manualQrToken')?.value?.trim();
    if (!qrToken) {
      this.setMsg('verifyMsg', 'QR token missing.', true);
      return;
    }
    if (!this.onVoteDayImage) {
      this.setMsg('verifyMsg', 'On-vote-day image capture karo.', true);
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/voter/confirm-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qr_token: qrToken, image_data: this.onVoteDayImage }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Confirm failed');
      }

      this.verifiedVoter = {
        voter_id: data.voter_id,
        full_name: data.full_name,
        role: data.role,
        qr_token: qrToken,
        on_vote_day_image: this.onVoteDayImage,
        on_vote_day_image_path: data.on_vote_day_image_path,
      };
      localStorage.setItem('verifiedVoter', JSON.stringify(this.verifiedVoter));
      this.confirmed = true;
      this.autoVerifying = false;
      this.updateActionButtons();
      this.applyVoteGuard();
      this.setMsg('verifyMsg', `Verified: ${data.full_name} (${data.voter_id})`);
      this.renderScannedVoter(data);
    } catch (e) {
      this.setMsg('verifyMsg', `Confirm failed: ${e.message}`, true);
    }
  }

  proceedToVoteConfirmation(candidateId, btnEl) {
    // Do not depend on table structure; use dataset (set by App.loadCandidates from DB).
    const btn = btnEl || document.querySelector(`button[data-candidate-id="${candidateId}"]`);
    const candidateName = (btn?.dataset?.candidateName || '').trim() || 'Unknown';
    const candidateParty = (btn?.dataset?.candidateParty || '').trim() || 'Unknown';
    const candidateData = {
      id: candidateId,
      name: candidateName,
      party: candidateParty,
      verified_voter_id: this.verifiedVoter?.voter_id || '',
    };
    localStorage.setItem('selectedCandidate', JSON.stringify(candidateData));
    window.location.href = './vote.html';
  }

  setupLogout() {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => this.logout());
    }
  }

  logout() {
    this.stopScanner();

    localStorage.removeItem('jwtTokenVoter');
    localStorage.removeItem('jwtTokenAdmin');
    localStorage.removeItem('selectedCandidate');
    localStorage.removeItem('currentTxHash');
    localStorage.removeItem('txStatus');
    localStorage.removeItem('verifiedVoter');
    window.location.href = './login.html';
  }

  updateActionButtons() {
    const startBtn = document.getElementById('startQrScan');
    const captureBtn = document.getElementById('captureOnVoteDay');
    const confirmBtn = document.getElementById('confirmScannedVoter');

    if (startBtn) startBtn.disabled = this.confirmed || this.autoVerifying;
    if (captureBtn) captureBtn.disabled = this.autoVerifying || !this.qrDetected || this.captureDone || this.confirmed;
    if (confirmBtn) confirmBtn.disabled = this.autoVerifying || !this.captureDone || this.confirmed;
  }

  setupVoteGuard() {
    const box = document.getElementById('boxCandidate');
    if (!box) return;
    this.voteObserver = new MutationObserver(() => this.applyVoteGuard());
    this.voteObserver.observe(box, { childList: true, subtree: true });
  }

  applyVoteGuard() {
    const notVerified = !this.verifiedVoter;
    document.querySelectorAll('.vote-btn').forEach((btn) => {
      if (!btn.dataset.baseDisabled) {
        btn.dataset.baseDisabled = btn.disabled ? '1' : '0';
      }
      btn.disabled = btn.dataset.baseDisabled === '1' || notVerified;
      btn.title = notVerified ? 'QR verification required before voting.' : '';
    });
  }

  setMsg(id, text, isError = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#ff7b7b' : '#64c898';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new VoterDashboard();
});
