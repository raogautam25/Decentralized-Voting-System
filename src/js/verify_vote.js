import { safeJsonParse } from './utils.js';

class VerifyVotePage {
  constructor() {
    this.txHashInput = document.getElementById('txHashInput');
    this.verifyBtn = document.getElementById('verifyBtn');
    this.useLastTxBtn = document.getElementById('useLastTxBtn');
    this.verifyMsg = document.getElementById('verifyMsg');
    this.resultPanel = document.getElementById('resultPanel');
    this.bindEvents();
    this.prefillTxHash();
  }

  bindEvents() {
    this.verifyBtn?.addEventListener('click', () => this.verifyNow());
    this.useLastTxBtn?.addEventListener('click', () => this.useLastTx());
    this.txHashInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.verifyNow();
      }
    });
  }

  prefillTxHash() {
    const byQuery = this.readQueryHash();
    if (byQuery) {
      this.txHashInput.value = byQuery;
      return;
    }
    const fromCurrent = String(localStorage.getItem('currentTxHash') || '').trim();
    if (fromCurrent) {
      this.txHashInput.value = fromCurrent;
      return;
    }
    const summaryRaw = localStorage.getItem('lastTxSummary');
    const summary = summaryRaw ? safeJsonParse(summaryRaw, null) : null;
    if (summary?.tx_hash) {
      this.txHashInput.value = String(summary.tx_hash);
    }
  }

  readQueryHash() {
    try {
      const url = new URL(window.location.href);
      return String(url.searchParams.get('txHash') || '').trim();
    } catch {
      return '';
    }
  }

  async waitForApp() {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      if (window.App && typeof window.App.verifyVoteTransaction === 'function') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Blockchain verifier is not ready. Refresh and try again.');
  }

  setStatus(text, isError = false) {
    if (!this.verifyMsg) return;
    this.verifyMsg.textContent = text || '';
    this.verifyMsg.classList.toggle('error', Boolean(isError));
  }

  async useLastTx() {
    const summaryRaw = localStorage.getItem('lastTxSummary');
    const summary = summaryRaw ? safeJsonParse(summaryRaw, null) : null;
    const txHash = String(summary?.tx_hash || localStorage.getItem('currentTxHash') || '').trim();
    if (!txHash) {
      this.setStatus('No recent transaction hash found in local storage.', true);
      return;
    }
    this.txHashInput.value = txHash;
    await this.verifyNow();
  }

  async verifyNow() {
    const txHash = String(this.txHashInput?.value || '').trim();
    if (!txHash) {
      this.setStatus('Enter a transaction hash first.', true);
      return;
    }

    this.setStatus('Verifying transaction on blockchain...');
    this.resultPanel.style.display = 'none';

    try {
      await this.waitForApp();
      const result = await window.App.verifyVoteTransaction(txHash);
      this.renderResult(result);
    } catch (error) {
      this.setStatus(error?.message || 'Verification failed.', true);
    }
  }

  renderResult(result) {
    if (!result || !result.found) {
      this.setStatus('Transaction not found on connected network.', true);
      this.resultPanel.style.display = 'none';
      return;
    }

    if (result.pending) {
      this.setStatus('Transaction found, but it is still pending.');
      this.resultPanel.style.display = 'block';
      this.fillRow('resultStatus', 'Pending');
      this.fillRow('resultTxHash', result.txHash || 'N/A');
      this.fillRow('resultEvent', 'Pending');
      this.fillRow('resultCandidate', 'Pending');
      this.fillRow('resultCandidateId', 'Pending');
      this.fillRow('resultParty', 'Pending');
      this.fillRow('resultBlock', 'Pending');
      this.fillRow('resultTimestamp', 'Pending');
      this.fillRow('resultWallet', result.from || 'N/A');
      this.fillRow('resultGas', 'Pending');
      this.fillRow('resultHint', 'Wait for block confirmation, then verify again.');
      return;
    }

    const statusText = result.success ? 'Vote Verified' : 'Transaction Failed';
    const eventName = result.eventName || 'Unknown';
    const timestamp = result.timestamp
      ? new Date(result.timestamp * 1000).toLocaleString()
      : 'Unavailable';

    this.resultPanel.style.display = 'block';
    this.fillRow('resultStatus', statusText);
    this.fillRow('resultTxHash', result.txHash || 'N/A');
    this.fillRow('resultEvent', eventName);
    this.fillRow('resultCandidate', result.candidateName || 'Unknown');
    this.fillRow('resultCandidateId', result.candidateId ? String(result.candidateId) : 'Unknown');
    this.fillRow('resultParty', result.candidateParty || 'Unknown');
    this.fillRow('resultBlock', result.blockNumber ? String(result.blockNumber) : 'Unknown');
    this.fillRow('resultTimestamp', timestamp);
    this.fillRow('resultWallet', result.voterAddress || result.from || 'Unknown');
    this.fillRow('resultGas', result.gasUsed || 'Unknown');

    if (!result.isVoteTx) {
      this.fillRow('resultHint', 'Transaction is on-chain but no vote event was detected for this hash.');
      this.setStatus('Transaction found, but it does not look like a vote transaction.', true);
    } else {
      this.fillRow('resultHint', 'This vote receipt is derived from on-chain logs and block metadata.');
      this.setStatus('Vote verification completed successfully.');
    }
  }

  fillRow(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value || '';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new VerifyVotePage();
});
