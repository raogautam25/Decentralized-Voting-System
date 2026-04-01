// Loading Page Script
// This page monitors blockchain transaction status during voting
import { API_BASE } from './config.js';
import { safeJsonParse } from './utils.js';

const rpcUrlOverride = window.__RPC_URL__ || document.querySelector('meta[name="rpc-url"]')?.content;
const RPC_URL = String(rpcUrlOverride || 'https://ethereum-sepolia-rpc.publicnode.com').trim();

class LoadingManager {
  constructor() {
    this.updateInterval = null;
    this.transactionHash = localStorage.getItem('currentTxHash');
    this.rpcUrl = RPC_URL;
    this.finalized = false;
    this.feedbackTimeoutMs = 0;
    // Ganache (local dev) does not naturally produce many empty blocks, so waiting for
    // 12 confirmations can hang the flow and prevent auto-logout for the next voter.
    // Treat "mined (1 confirmation)" as final for this project.
    this.confirmTarget = 1;
    this.init();
  }

  init() {
    // Display any stored transaction hash
    if (this.transactionHash) {
      document.getElementById('txHash').textContent = this.shortenHash(this.transactionHash);
    }

    // Start monitoring transaction
    this.startMonitoring();

    // Add retry button listener
    const retryBtn = document.getElementById('retryBtn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => this.handleRetry());
    }

    const targetEl = document.getElementById('confirmationTarget');
    if (targetEl) targetEl.textContent = String(this.confirmTarget);
  }

  startMonitoring() {
    // Poll Ganache for receipt/confirmations every 2 seconds
    this.updateInterval = setInterval(() => {
      this.checkTransactionStatus();
    }, 2000);

    // Also manually check immediately
    this.checkTransactionStatus();
  }

  readPendingAuditQueue() {
    const raw = localStorage.getItem('pendingVoteAuditQueue');
    const parsed = raw ? safeJsonParse(raw, []) : [];
    return Array.isArray(parsed) ? parsed : [];
  }

  writePendingAuditQueue(items) {
    if (!Array.isArray(items) || items.length === 0) {
      localStorage.removeItem('pendingVoteAuditQueue');
      return;
    }
    localStorage.setItem('pendingVoteAuditQueue', JSON.stringify(items));
  }

  archivePendingAuditForRetry() {
    const raw = localStorage.getItem('pendingVoteAudit');
    const payload = raw ? safeJsonParse(raw, null) : null;
    if (!payload?.tx_hash) {
      localStorage.removeItem('pendingVoteAudit');
      return;
    }

    const queue = this.readPendingAuditQueue();
    if (!queue.some((item) => item?.tx_hash && item.tx_hash === payload.tx_hash)) {
      queue.push(payload);
      this.writePendingAuditQueue(queue);
    }
    localStorage.removeItem('pendingVoteAudit');
  }

  async syncQueuedAudits() {
    const queue = this.readPendingAuditQueue();
    if (queue.length === 0) return;

    const remaining = [];
    for (const payload of queue) {
      try {
        const res = await fetch(`${API_BASE}/vote/audit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          remaining.push(payload);
          localStorage.setItem('pendingVoteAuditError', data.detail || data.message || `Vote audit sync failed (HTTP ${res.status})`);
          continue;
        }
        localStorage.removeItem('pendingVoteAuditError');
        if (data?.message) {
          localStorage.setItem('lastAuditSyncMessage', String(data.message));
        }
      } catch (error) {
        remaining.push(payload);
        localStorage.setItem('pendingVoteAuditError', error?.message || 'Pending audit sync failed');
      }
    }

    this.writePendingAuditQueue(remaining);
  }

  async checkTransactionStatus() {
    if (this.finalized) {
      return;
    }

    if (!this.transactionHash) {
      this.showError('Missing transaction hash. Please vote again.');
      clearInterval(this.updateInterval);
      return;
    }

    try {
      const receipt = await this.rpc('eth_getTransactionReceipt', [this.transactionHash]);
      if (!receipt) {
        localStorage.setItem('txStatus', 'pending');
        this.updateUI('pending', localStorage.getItem('txConfirmations') || '0');
        return;
      }

      const statusHex = receipt.status || '0x0';
      const ok = statusHex === '0x1';
      const blockHex = receipt.blockNumber || '0x0';
      localStorage.setItem('blockNumber', String(parseInt(blockHex, 16) || ''));

      if (!ok) {
        localStorage.setItem('txStatus', 'failed');
        this.updateUI('failed', '0');
        clearInterval(this.updateInterval);
        this.showError(localStorage.getItem('txError') || 'Transaction failed');
        return;
      }

      const headHex = await this.rpc('eth_blockNumber', []);
      const head = parseInt(headHex || '0x0', 16) || 0;
      const minedAt = parseInt(blockHex, 16) || 0;
      const conf = Math.max(1, head - minedAt + 1);
      localStorage.setItem('txConfirmations', String(conf));

      const final = conf >= this.confirmTarget;
      localStorage.setItem('txStatus', final ? 'confirmed' : 'confirming');
      this.updateUI(final ? 'confirmed' : 'confirming', String(Math.min(conf, this.confirmTarget)));

      if (final) {
        this.finalized = true;
        clearInterval(this.updateInterval);
        this.persistLastTransactionSummary();
        await this.syncQueuedAudits();
        await this.syncPendingAudit();
        this.updateDoneMessage();
        await this.handleOptionalFeedback();
        this.logoutForNextVoter();
        setTimeout(() => {
          // Replace history entry so browser back/forward cache doesn't resurrect old voter UI state.
          window.location.replace('./vote.html');
        }, 1200);
      }
    } catch (e) {
      // RPC not reachable, keep showing pending but don't auto-confirm.
      this.updateUI('pending', localStorage.getItem('txConfirmations') || '0');
    }
  }

  async rpc(method, params) {
    if (window.ethereum?.request) {
      try {
        return await window.ethereum.request({ method, params });
      } catch {
        // fall through to explicit RPC URL
      }
    }

    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'RPC error');
    return data.result;
  }

  updateDoneMessage() {
    const msg = document.getElementById('loadingMessage');
    const info = document.getElementById('loadingInfo');
    const short = this.transactionHash ? this.shortenHash(this.transactionHash) : '';
    const auditMessage = localStorage.getItem('lastAuditSyncMessage') || '';
    const auditError = localStorage.getItem('pendingVoteAuditError') || '';
    if (msg) msg.textContent = `Vote confirmed${short ? ` (Tx ${short})` : ''}.`;
    if (info) {
      if (auditError) {
        info.textContent = `Vote confirmed on-chain. Backend audit sync is pending: ${auditError}`;
      } else if (auditMessage) {
        info.textContent = `${auditMessage} Optional feedback is available. Submit or skip to continue.`;
      } else {
        info.textContent = 'Optional feedback is available. Submit or skip to continue.';
      }
    }
  }

  persistLastTransactionSummary() {
    try {
      const voteSubmittedTime = localStorage.getItem('voteSubmittedTime') || '';
      const blockNumber = localStorage.getItem('blockNumber') || '';
      const txHash = localStorage.getItem('currentTxHash') || this.transactionHash || '';

      const auditRaw = localStorage.getItem('pendingVoteAudit');
      const audit = auditRaw ? safeJsonParse(auditRaw, null) : null;

      const summary = {
        tx_hash: txHash,
        block_number: blockNumber,
        vote_submitted_time: voteSubmittedTime,
        voter_id: audit?.voter_id || '',
        candidate_id: audit?.candidate_id || '',
        candidate_name: audit?.candidate_name || '',
        party: audit?.party || '',
      };

      localStorage.setItem('lastTxSummary', JSON.stringify(summary));
    } catch {
      // ignore
    }
  }

  logoutForNextVoter() {
    this.archivePendingAuditForRetry();

    // Enforce one voter session per vote.
    // Keep admin token intact; only wipe voter session + vote flow state.
    localStorage.removeItem('jwtTokenVoter');

    localStorage.removeItem('verifiedVoter');
    localStorage.removeItem('selectedCandidate');

    localStorage.removeItem('currentTxHash');
    localStorage.removeItem('txConfirmations');
    localStorage.removeItem('blockNumber');
    localStorage.removeItem('voteSubmittedTime');
    localStorage.removeItem('txError');
    localStorage.removeItem('txStatus');
    localStorage.removeItem('pendingVoteFeedback');
    localStorage.removeItem('pendingVoteAuditError');

    // Used by voter.js to force fresh verification if the user navigates back.
    localStorage.setItem('lastVoteCompleted', '1');
  }

  async syncPendingAudit() {
    const raw = localStorage.getItem('pendingVoteAudit');
    if (!raw) return;
    try {
      const payload = safeJsonParse(raw, null);
      if (!payload) return;
      const res = await fetch(`${API_BASE}/vote/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        localStorage.removeItem('pendingVoteAudit');
        localStorage.removeItem('pendingVoteAuditError');
        if (data?.message) {
          localStorage.setItem('lastAuditSyncMessage', String(data.message));
        }
        return;
      }
      localStorage.setItem('pendingVoteAuditError', data.detail || data.message || `Vote audit sync failed (HTTP ${res.status})`);
    } catch (error) {
      localStorage.setItem('pendingVoteAuditError', error?.message || 'Pending audit sync failed');
      console.warn('Pending audit sync failed:', error);
    }
  }

  async handleOptionalFeedback() {
    const feedbackContainer = document.getElementById('feedbackContainer');
    const feedbackInput = document.getElementById('voteFeedback');
    const feedbackStatus = document.getElementById('feedbackStatus');
    const submitButton = document.getElementById('submitFeedbackBtn');
    const skipButton = document.getElementById('skipFeedbackBtn');

    if (!feedbackContainer || !feedbackInput || !submitButton || !skipButton) {
      console.warn('Feedback form elements not found, skipping feedback collection');
      return;
    }

    feedbackContainer.style.display = 'block';
    feedbackInput.value = localStorage.getItem('pendingVoteFeedback') || '';
    if (feedbackStatus) {
      feedbackStatus.textContent = this.feedbackTimeoutMs > 0
        ? 'You can submit feedback now, or skip and continue automatically.'
        : 'You can submit feedback now, or skip to continue.';
    }

    return await new Promise((resolve) => {
      let completed = false;
      let timeoutId = null;

      const finish = () => {
        if (completed) {
          return;
        }
        completed = true;
        localStorage.removeItem('pendingVoteFeedback');
        localStorage.removeItem('lastAuditSyncMessage');
        feedbackInput.removeEventListener('input', handleInput);
        submitButton.removeEventListener('click', handleSubmit);
        skipButton.removeEventListener('click', handleSkip);
        if (timeoutId) clearTimeout(timeoutId);
        resolve();
      };

      const handleInput = () => {
        localStorage.setItem('pendingVoteFeedback', feedbackInput.value);
      };

      const handleSkip = () => {
        if (feedbackStatus) {
          feedbackStatus.textContent = 'Feedback skipped. Resetting session...';
        }
        finish();
      };

      const handleSubmit = async () => {
        const feedback = feedbackInput.value.trim();
        if (!feedback) {
          handleSkip();
          return;
        }

        submitButton.disabled = true;
        skipButton.disabled = true;
        if (feedbackStatus) {
          feedbackStatus.textContent = 'Saving your feedback...';
        }

        try {
          await this.saveFeedback(feedback);
          if (feedbackStatus) {
            feedbackStatus.textContent = 'Feedback saved. Resetting session...';
          }
          finish();
        } catch (error) {
          console.error('Feedback submission error:', error);
          if (feedbackStatus) {
            feedbackStatus.textContent = `Feedback save failed: ${error?.message || 'Unknown error'}. Continuing without it.`;
          }
          // Reset button state to allow retry
          submitButton.disabled = false;
          skipButton.disabled = false;
        }
      };

      feedbackInput.addEventListener('input', handleInput);
      submitButton.addEventListener('click', handleSubmit);
      skipButton.addEventListener('click', handleSkip);

      if (this.feedbackTimeoutMs > 0) {
        timeoutId = setTimeout(() => {
          if (feedbackStatus) {
            feedbackStatus.textContent = 'Time window ended. Resetting session...';
          }
          finish();
        }, this.feedbackTimeoutMs);
      }
    });
  }

      feedbackInput.addEventListener('input', handleInput);
      submitButton.addEventListener('click', handleSubmit);
      skipButton.addEventListener('click', handleSkip);

      if (this.feedbackTimeoutMs > 0) {
        timeoutId = setTimeout(() => {
          if (feedbackStatus) {
            feedbackStatus.textContent = 'Time window ended. Resetting session...';
          }
          finish();
        }, this.feedbackTimeoutMs);
      }
    });
  }

  async saveFeedback(feedback) {
    const pendingAudit = safeJsonParse(localStorage.getItem('pendingVoteAudit'), null);
    const lastSummary = safeJsonParse(localStorage.getItem('lastTxSummary'), null);
    
    if (!feedback || !feedback.trim()) {
      throw new Error('Feedback text is empty');
    }

    const payload = pendingAudit?.voter_id
      ? {
          ...pendingAudit,
          feedback: feedback.trim(),
          tx_hash: pendingAudit.tx_hash || lastSummary?.tx_hash || this.transactionHash || '',
        }
      : {
          voter_id: lastSummary?.voter_id || '',
          candidate_id: lastSummary?.candidate_id || '',
          candidate_name: lastSummary?.candidate_name || '',
          party: lastSummary?.party || '',
          tx_hash: lastSummary?.tx_hash || this.transactionHash || '',
          feedback: feedback.trim(),
        };

    console.log('Sending feedback payload:', {
      has_voter_id: !!payload.voter_id,
      feedback_length: payload.feedback?.length || 0,
      has_tx_hash: !!payload.tx_hash,
    });

    const res = await fetch(`${API_BASE}/vote/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    const data = await res.json().catch(() => ({}));
    
    if (!res.ok) {
      const errorMsg = data.detail || data.message || `HTTP ${res.status}`;
      console.error('Feedback save failed:', errorMsg, data);
      throw new Error(`Feedback save failed: ${errorMsg}`);
    }
    
    console.log('Feedback saved successfully:', data);
    localStorage.removeItem('pendingVoteAudit');
    localStorage.removeItem('pendingVoteAuditError');
    if (data?.message) {
      localStorage.setItem('lastAuditSyncMessage', String(data.message));
    }
  }

  updateUI(status, confirmations) {
    const statusElement = document.getElementById('txStatus');
    const confirmationElement = document.getElementById('confirmationCount');
    const blockNumberElement = document.getElementById('blockNumber');

    if (statusElement) {
      statusElement.textContent = status || 'Pending';
      statusElement.className = `status-${status || 'pending'}`;
    }

    if (confirmationElement && confirmations) {
      confirmationElement.textContent = confirmations;
    }

    // Update progress bar based on confirmations
    const progressBar = document.getElementById('progressBar');
    if (progressBar && confirmations) {
      const c = Number(confirmations) || 0;
      const denom = this.confirmTarget || 1;
      const progress = Math.max(0, Math.min(100, (c / denom) * 100));
      progressBar.style.width = progress + '%';
    }

    // Update block number if available
    if (blockNumberElement && localStorage.getItem('blockNumber')) {
      blockNumberElement.textContent = localStorage.getItem('blockNumber');
    }
  }

  showError(errorMessage) {
    const errorContainer = document.getElementById('errorContainer');
    const errorMessageElement = document.getElementById('errorMessage');
    
    if (errorContainer && errorMessageElement) {
      errorMessageElement.textContent = errorMessage;
      errorContainer.style.display = 'block';
    }
  }

  handleRetry() {
    // Clear stored transaction data
    localStorage.removeItem('currentTxHash');
    localStorage.removeItem('txStatus');
    localStorage.removeItem('txError');
    
    // Go back to voting page
    window.location.replace('./vote.html');
  }

  shortenHash(hash) {
    if (hash && hash.length > 20) {
      return hash.substring(0, 10) + '...' + hash.substring(hash.length - 10);
    }
    return hash;
  }

  // Alternative: Fetch real transaction status from blockchain API
  async fetchTransactionStatus() {
    try {
      if (!this.transactionHash) {
        return;
      }

      // This would connect to a blockchain API like Etherscan
      // Example: https://api.etherscan.io/api?module=transaction&action=gettxreceiptstatus&txhash=...
      
      const response = await fetch(`/api/transaction/${this.transactionHash}`);
      if (response.ok) {
        const data = await response.json();
        return {
          status: data.status,
          confirmations: data.confirmations,
          blockNumber: data.blockNumber
        };
      }
    } catch (error) {
      console.error('Error fetching transaction status:', error);
    }
    return null;
  }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
  new LoadingManager();
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  // Optional: Save transaction data before leaving
});
