class ExplorerPage {
  constructor() {
    this.resultsBody = document.getElementById('resultsBody');
    this.eventsBody = document.getElementById('eventsBody');
    this.explorerMsg = document.getElementById('explorerMsg');
    this.refreshBtn = document.getElementById('refreshExplorerBtn');
    this.refreshBtn?.addEventListener('click', () => this.loadAll());
    this.loadAll();
  }

  async waitForApp() {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      if (
        window.App
        && typeof window.App.getPublicVoteEvents === 'function'
        && typeof window.App.getCandidateResults === 'function'
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Blockchain explorer is not ready. Refresh and try again.');
  }

  setStatus(text, isError = false) {
    if (!this.explorerMsg) return;
    this.explorerMsg.textContent = text || '';
    this.explorerMsg.classList.toggle('error', Boolean(isError));
  }

  async loadAll() {
    this.setStatus('Loading blockchain results and vote events...');
    try {
      await this.waitForApp();
      const [results, events] = await Promise.all([
        window.App.getCandidateResults(),
        window.App.getPublicVoteEvents({ fromBlock: 0, toBlock: 'latest' }),
      ]);
      this.renderResults(results || []);
      this.renderEvents(events || []);
      this.setStatus(`Loaded ${events.length} vote event(s).`);
    } catch (error) {
      this.setStatus(error?.message || 'Failed to load explorer.', true);
    }
  }

  renderResults(results) {
    if (!this.resultsBody) return;
    if (!Array.isArray(results) || results.length === 0) {
      this.resultsBody.innerHTML = '<tr><td colspan="4" class="muted">No candidates found.</td></tr>';
      return;
    }

    this.resultsBody.innerHTML = results.map((row, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${this.escapeHtml(row.name || 'Unknown')}</td>
        <td>${this.escapeHtml(row.party || 'Unknown')}</td>
        <td>${Number(row.voteCount || 0)}</td>
      </tr>
    `).join('');
  }

  renderEvents(events) {
    if (!this.eventsBody) return;
    if (!Array.isArray(events) || events.length === 0) {
      this.eventsBody.innerHTML = '<tr><td colspan="5" class="muted">No vote events found.</td></tr>';
      return;
    }

    const limited = events.slice(0, 200);
    this.eventsBody.innerHTML = limited.map((ev) => {
      const tx = String(ev.txHash || '');
      const txShort = tx ? `${tx.slice(0, 12)}...${tx.slice(-8)}` : 'N/A';
      const timeText = ev.timestamp
        ? new Date(Number(ev.timestamp) * 1000).toLocaleString()
        : 'Unavailable';
      const candidate = `${this.escapeHtml(ev.candidateName || 'Unknown')} (#${Number(ev.candidateId || 0)})`;
      const voter = String(ev.voterAddress || '');
      const voterShort = voter ? `${voter.slice(0, 10)}...${voter.slice(-6)}` : 'Unknown';

      return `
        <tr>
          <td>${timeText}</td>
          <td><a class="tx-link mono" href="./verify-vote.html?txHash=${encodeURIComponent(tx)}">${txShort}</a></td>
          <td>${candidate}</td>
          <td>${Number(ev.blockNumber || 0)}</td>
          <td class="mono" title="${this.escapeHtml(voter)}">${voterShort}</td>
        </tr>
      `;
    }).join('');
  }

  escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new ExplorerPage();
});
