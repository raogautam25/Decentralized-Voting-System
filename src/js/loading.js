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

  async checkTransactionStatus() {
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
        clearInterval(this.updateInterval);
        this.persistLastTransactionSummary();
        await this.syncPendingAudit();
        this.updateDoneMessage();
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
    if (msg) msg.textContent = `Vote confirmed${short ? ` (Tx ${short})` : ''}. Logging out for the next voter...`;
    if (info) info.textContent = 'Please wait...';
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
      if (res.ok) {
        localStorage.removeItem('pendingVoteAudit');
      }
    } catch (error) {
      console.warn('Pending audit sync failed:', error);
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
