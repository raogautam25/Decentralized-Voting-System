// src/js/app.js

const Web3 = require('web3');
const contract = require('@truffle/contract');
const votingArtifacts = require('../../build/contracts/Voting.json');

const VotingContract = contract(votingArtifacts);
const API_BASE = 'http://127.0.0.1:8000';

window.App = {
  web3: null,
  provider: null,
  account: null,
  voting: null,
  initPromise: null,
  providerListenersBound: false,

  // ---- bootstrapping ----
  initProvider: async function () {
    if (window.ethereum) {
      this.provider = window.ethereum;
      this.web3 = new Web3(this.provider);

      try {
        // Check current network and switch to Ganache if needed
        const chainId = await this.provider.request({ method: 'eth_chainId' });
        const currentChainId = parseInt(chainId, 16);
        console.log('Current Chain ID:', currentChainId);
        
        // Use Ganache chain ID 1337
        if (currentChainId !== 1337) {
          console.warn('Wrong network! Attempting to switch to Ganache (1337)...');
          try {
            // Try 1337 first (Ganache CLI)
            await this.provider.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: '0x539' }], // 1337 in hex
            });
          } catch (switchError) {
            if (switchError.code === 4902) {
              // Network not added, try to add it
              try {
                await this.provider.request({
                  method: 'wallet_addEthereumChain',
                  params: [{
                    chainId: '0x539',
                    chainName: 'Ganache Local',
                    rpcUrls: ['http://127.0.0.1:7545'],
                    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }
                  }],
                });
              } catch (addError) {
                console.error('Failed to add network:', addError);
                alert('Please add Ganache network to MetaMask:\nChain ID: 1337\nRPC URL: http://127.0.0.1:7545');
              }
            } else {
              alert('Please manually switch to Ganache network in MetaMask');
            }
          }
        }
      } catch (e) {
        console.warn('Network check error:', e);
      }

      // Reuse already-approved accounts when possible to avoid duplicate MetaMask prompts.
      let accounts = await this.provider.request({ method: 'eth_accounts' });
      if (!accounts || accounts.length === 0) {
        accounts = await this.provider.request({ method: 'eth_requestAccounts' });
      }
      this.account = accounts && accounts[0] ? accounts[0] : null;

      // React to changes
      if (!this.providerListenersBound) {
        this.provider.on?.('accountsChanged', (accs) => {
          this.account = accs && accs[0] ? accs[0] : null;
          $('#accountAddress').text(this.account ? `Your Account: ${this.account}` : 'No account connected');
          // UI state may change with a new account
          this.updateVoteButtonState().catch(console.warn);
        });
        this.provider.on?.('chainChanged', () => {
          // full reload keeps things consistent with the new chain
          window.location.reload();
        });
        this.providerListenersBound = true;
      }
    } else {
      // Fallback to local RPC (development only)
      console.warn('No EIP-1193 provider found; falling back to http://127.0.0.1:7545');
      this.provider = new Web3.providers.HttpProvider('http://127.0.0.1:7545');
      this.web3 = new Web3(this.provider);

      // Best-effort to fetch an account from local node
      try {
        const accounts = await this.web3.eth.getAccounts();
        this.account = accounts && accounts[0] ? accounts[0] : null;
      } catch (e) {
        console.warn('Could not get accounts from fallback provider:', e);
      }
    }

    // Hook the provider to Truffle Contract
    VotingContract.setProvider(this.web3.currentProvider);
  },

  // ---- lifecycle entrypoint ----
  eventStart: async function () {
    if (this.initPromise) {
      return this.initPromise;
    }
    if (this.web3 && this.voting && this.getVotingAddress()) {
      return this.voting;
    }

    this.initPromise = (async () => {
      try {
        await this.initProvider();

        $('#accountAddress').text(this.account ? `Your Account: ${this.account}` : 'No account connected');

      // Load contract instance
      try {
        this.voting = await VotingContract.deployed();
      } catch (err) {
        console.warn('deployed() failed, attempting manual contract instance:', err.message);
        
        // Try to create contract manually with address from artifact for current network id
        const networkId = String(await this.web3.eth.net.getId());
        if (votingArtifacts.networks && votingArtifacts.networks[networkId]) {
          const deployedAddress = votingArtifacts.networks[networkId].address;
          console.log('Using contract address from artifact:', deployedAddress);
          this.voting = new this.web3.eth.Contract(votingArtifacts.abi, deployedAddress);
          console.log('Contract instance created successfully');
        } else {
          // Get current network for debugging
          try {
            const chainId = await this.web3.eth.net.getId();
            const currentAccount = await this.web3.eth.getAccounts();
            console.error('Contract deployment error:', err);
            console.error('Current Chain ID:', chainId);
            console.error('Current Account:', currentAccount);
            
            alert(`Network Mismatch!\n\nCurrent Network: ${chainId}\nRequired Network: 1337 (Ganache)\n\nPlease switch to Ganache network in MetaMask and refresh. If Ganache network is not in MetaMask, click the network dropdown and select "Add network" then add:\nRPC URL: http://127.0.0.1:7545\nChain ID: 1337`);
          } catch (e) {
            console.error('Error getting network info:', e);
          }
          throw err;
        }
      }

        // Initial UI render
        await this.renderDates();
        await this.loadCandidates();
        await this.updateVoteButtonState();

        // Wire UI events once DOM is ready
        $(document).ready(() => {
        // Add candidate
        $('#addCandidate').off('click').on('click', async () => {
          const nameCandidate = $('#name').val()?.trim();
          const partyCandidate = $('#party').val()?.trim();
          if (!nameCandidate || !partyCandidate) {
            alert('Please enter both candidate name and party.');
            return;
          }
          try {
            const gas = await this.voting.addCandidate.estimateGas(nameCandidate, partyCandidate, { from: this.account });
            await this.voting.addCandidate(nameCandidate, partyCandidate, { from: this.account, gas });
            // Persist candidate to DB so voter dashboard can fetch from MySQL in realtime.
            try {
              const newIdRaw = await this.readCountCandidates();
              const newId = Number(newIdRaw);
              await fetch(`${API_BASE}/admin/candidates`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ candidate_id: newId, name: nameCandidate, party: partyCandidate }),
              });
            } catch (e) {
              console.warn('DB candidate sync failed:', e);
            }
            $('#name').val('');
            $('#party').val('');
            await this.loadCandidates();
          } catch (e) {
            this.showTxError('Adding candidate failed', e);
          }
        });

        // Set dates
        $('#addDate').off('click').on('click', async () => {
          const startStr = document.getElementById('startDate')?.value;
          const endStr = document.getElementById('endDate')?.value;
          if (!startStr || !endStr) {
            alert('Please provide both start and end dates.');
            return;
          }
          const startTs = Math.floor(Date.parse(startStr) / 1000);
          const endTs = Math.floor(Date.parse(endStr) / 1000);
          if (isNaN(startTs) || isNaN(endTs) || endTs <= startTs) {
            alert('Invalid dates. End must be after start.');
            return;
          }
          try {
            const gas = await this.voting.setDates.estimateGas(startTs, endTs, { from: this.account });
            await this.voting.setDates(startTs, endTs, { from: this.account, gas });
            // Persist dates to DB for realtime UI; chain still enforces window on vote.
            try {
              await fetch(`${API_BASE}/admin/election/dates`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ start_ts: startTs, end_ts: endTs }),
              });
            } catch (e) {
              console.warn('DB election dates sync failed:', e);
            }
            await this.renderDates();
            await this.updateVoteButtonState();
          } catch (e) {
            this.showTxError('Setting dates failed', e);
          }
        });

        // Enable/disable vote button is handled by updateVoteButtonState()
        // If your HTML uses onclick="App.vote()", this still works because we expose window.App.vote.
        // But we also wire a safety click handler in case you use an ID.
        $('#voteButton').off('click').on('click', () => this.vote());
        });

        return this.voting;
      } catch (err) {
        console.error('Initialization error:', err);
        alert(`Initialization failed: ${err?.message || err}`);
        throw err;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  },

  // ---- helpers / UI ----
  fmtTs: function (tSec) {
    return new Date(tSec * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  },

  getNowTs: async function () {
    // Prefer chain time to avoid local clock skew
    try {
      const latest = await this.web3.eth.getBlock('latest');
      if (latest && typeof latest.timestamp !== 'undefined') {
        return Number(latest.timestamp);
      }
    } catch (e) {
      // ignore and fall back
    }
    return Math.floor(Date.now() / 1000);
  },

  getActiveQrToken: function () {
    try {
      const raw = localStorage.getItem('verifiedVoter');
      if (!raw) return '';
      const v = JSON.parse(raw);
      return (v && v.qr_token) ? String(v.qr_token) : '';
    } catch {
      return '';
    }
  },

  readCheckVoteByQr: async function (qrToken) {
    if (!qrToken) return false;
    if (this.voting?.checkVoteByQr?.call) {
      return this.voting.checkVoteByQr.call(qrToken, { from: this.account });
    }
    if (this.voting?.methods?.checkVoteByQr) {
      return this.voting.methods.checkVoteByQr(qrToken).call({ from: this.account });
    }
    throw new Error('Contract method checkVoteByQr is unavailable. Redeploy contract and refresh.');
  },

  readDates: async function () {
    if (this.voting?.getDates?.call) {
      return this.voting.getDates.call();
    }
    if (this.voting?.methods?.getDates) {
      return this.voting.methods.getDates().call();
    }
    throw new Error('Contract method getDates is unavailable.');
  },

  readCountCandidates: async function () {
    if (this.voting?.getCountCandidates?.call) {
      return this.voting.getCountCandidates.call();
    }
    if (this.voting?.methods?.getCountCandidates) {
      return this.voting.methods.getCountCandidates().call();
    }
    throw new Error('Contract method getCountCandidates is unavailable.');
  },

  readCandidate: async function (candidateID) {
    if (this.voting?.getCandidate?.call) {
      return this.voting.getCandidate.call(candidateID);
    }
    if (this.voting?.methods?.getCandidate) {
      return this.voting.methods.getCandidate(candidateID).call();
    }
    throw new Error('Contract method getCandidate is unavailable.');
  },

  sendVoteByQrTx: async function (candidateID, qrToken) {
    if (this.voting?.voteByQr?.estimateGas && this.voting?.voteByQr) {
      const gas = await this.voting.voteByQr.estimateGas(candidateID, qrToken, { from: this.account });
      return this.voting.voteByQr(candidateID, qrToken, { from: this.account, gas });
    }
    if (this.voting?.methods?.voteByQr) {
      const method = this.voting.methods.voteByQr(candidateID, qrToken);
      const gas = await method.estimateGas({ from: this.account });
      return method.send({ from: this.account, gas });
    }
    throw new Error('Contract method voteByQr is unavailable. Redeploy contract and refresh.');
  },

  getVotingAddress: function () {
    if (!this.voting) return '';
    if (this.voting.address) return String(this.voting.address);
    if (this.voting.options?.address) return String(this.voting.options.address);
    return '';
  },

  getReadonlyVotingContract: function () {
    const address = this.getVotingAddress();
    if (!address) {
      throw new Error('Voting contract address is unavailable.');
    }
    return new this.web3.eth.Contract(votingArtifacts.abi, address);
  },

  getEventAbi: function (eventName) {
    return (votingArtifacts.abi || []).find((item) => item.type === 'event' && item.name === eventName) || null;
  },

  normalizeUint: function (value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') {
      if (!value) return '';
      if (value.startsWith('0x')) {
        try {
          return this.web3.utils.hexToNumberString(value);
        } catch {
          return value;
        }
      }
      return value;
    }
    try {
      return value.toString(10);
    } catch {
      return String(value);
    }
  },

  decodeEventLog: function (log, eventName) {
    if (!log || !Array.isArray(log.topics) || log.topics.length === 0) return null;
    const eventAbi = this.getEventAbi(eventName);
    if (!eventAbi) return null;
    const signature = this.web3.eth.abi.encodeEventSignature(eventAbi);
    if (String(log.topics[0]).toLowerCase() !== String(signature).toLowerCase()) return null;
    try {
      return this.web3.eth.abi.decodeLog(eventAbi.inputs, log.data, log.topics.slice(1));
    } catch {
      return null;
    }
  },

  resolveCandidateMeta: async function (candidateID) {
    const idNum = Number(candidateID);
    if (!idNum) {
      return { candidateId: 0, name: 'Unknown', party: 'Unknown' };
    }
    try {
      const cand = await this.readCandidate(idNum);
      return {
        candidateId: idNum,
        name: String(cand[1] || 'Unknown'),
        party: String(cand[2] || 'Unknown')
      };
    } catch {
      return { candidateId: idNum, name: 'Unknown', party: 'Unknown' };
    }
  },

  verifyVoteTransaction: async function (txHash) {
    const cleanHash = String(txHash || '').trim();
    if (!cleanHash || !cleanHash.startsWith('0x')) {
      throw new Error('Enter a valid transaction hash.');
    }

    if (!this.web3 || !this.voting) {
      await this.eventStart();
    }

    const [tx, receipt] = await Promise.all([
      this.web3.eth.getTransaction(cleanHash),
      this.web3.eth.getTransactionReceipt(cleanHash),
    ]);

    if (!tx) {
      return { found: false, txHash: cleanHash };
    }

    if (!receipt) {
      return {
        found: true,
        pending: true,
        txHash: cleanHash,
        from: tx.from || '',
        to: tx.to || '',
      };
    }

    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    let parsed = null;
    let eventName = '';

    for (const log of logs) {
      const cast = this.decodeEventLog(log, 'VoteCast');
      if (cast) {
        parsed = cast;
        eventName = 'VoteCast';
        break;
      }
    }

    if (!parsed) {
      for (const log of logs) {
        const voted = this.decodeEventLog(log, 'Voted');
        if (voted) {
          parsed = voted;
          eventName = 'Voted';
          break;
        }
      }
    }

    if (!parsed) {
      for (const log of logs) {
        const votedByQr = this.decodeEventLog(log, 'VotedByQr');
        if (votedByQr) {
          parsed = votedByQr;
          eventName = 'VotedByQr';
          break;
        }
      }
    }

    const statusRaw = receipt.status;
    const success = typeof statusRaw === 'boolean'
      ? statusRaw
      : (String(statusRaw).toLowerCase() === '0x1' || String(statusRaw) === '1');

    const blockNumber = Number(receipt.blockNumber || 0);
    const block = blockNumber > 0 ? await this.web3.eth.getBlock(blockNumber) : null;

    const candidateIdRaw = parsed?.candidateId || parsed?.[1] || '';
    const candidateId = Number(this.normalizeUint(candidateIdRaw) || 0);
    const candidateMeta = await this.resolveCandidateMeta(candidateId);

    let timestamp = Number(this.normalizeUint(parsed?.timestamp || '') || 0);
    if (!timestamp && block?.timestamp) {
      timestamp = Number(block.timestamp);
    }

    const voterAddress = String(
      parsed?.voter || parsed?.operator || parsed?.[0] || tx.from || ''
    );

    const isVoteTx = Boolean(parsed);

    return {
      found: true,
      pending: false,
      isVoteTx,
      eventName,
      success,
      txHash: cleanHash,
      from: tx.from || '',
      to: tx.to || '',
      voterAddress,
      blockNumber,
      gasUsed: this.normalizeUint(receipt.gasUsed || ''),
      candidateId: candidateMeta.candidateId,
      candidateName: candidateMeta.name,
      candidateParty: candidateMeta.party,
      timestamp,
      timestampIso: timestamp ? new Date(timestamp * 1000).toISOString() : '',
    };
  },

  getPublicVoteEvents: async function ({ fromBlock = 0, toBlock = 'latest' } = {}) {
    if (!this.web3 || !this.voting) {
      await this.eventStart();
    }

    const contractRo = this.getReadonlyVotingContract();
    const eventAbi = this.getEventAbi('VoteCast');
    let events = [];

    if (eventAbi) {
      events = await contractRo.getPastEvents('VoteCast', { fromBlock, toBlock });
    }

    if (!eventAbi || events.length === 0) {
      const [legacyVotes, legacyQrVotes] = await Promise.all([
        contractRo.getPastEvents('Voted', { fromBlock, toBlock }),
        contractRo.getPastEvents('VotedByQr', { fromBlock, toBlock }),
      ]);
      if (events.length === 0) {
        events = [...legacyVotes, ...legacyQrVotes];
      }
    }

    const blockTsCache = new Map();
    const candidateCache = new Map();

    const normalized = await Promise.all(events.map(async (ev) => {
      const values = ev.returnValues || {};
      const candidateId = Number(this.normalizeUint(values.candidateId || values[1] || '') || 0);
      const voterAddress = String(values.voter || values.operator || values[0] || '');
      const blockNumber = Number(ev.blockNumber || 0);

      let ts = Number(this.normalizeUint(values.timestamp || '') || 0);
      if (!ts && blockNumber > 0) {
        if (!blockTsCache.has(blockNumber)) {
          try {
            const block = await this.web3.eth.getBlock(blockNumber);
            blockTsCache.set(blockNumber, Number(block?.timestamp || 0));
          } catch {
            blockTsCache.set(blockNumber, 0);
          }
        }
        ts = blockTsCache.get(blockNumber) || 0;
      }

      if (!candidateCache.has(candidateId)) {
        candidateCache.set(candidateId, await this.resolveCandidateMeta(candidateId));
      }
      const meta = candidateCache.get(candidateId);

      return {
        txHash: ev.transactionHash || '',
        blockNumber,
        logIndex: Number(ev.logIndex || 0),
        eventName: String(ev.event || ''),
        voterAddress,
        candidateId: Number(meta?.candidateId || candidateId || 0),
        candidateName: String(meta?.name || 'Unknown'),
        candidateParty: String(meta?.party || 'Unknown'),
        timestamp: ts,
        timestampIso: ts ? new Date(ts * 1000).toISOString() : '',
      };
    }));

    return normalized.sort((a, b) => {
      if (b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
      return b.logIndex - a.logIndex;
    });
  },

  getCandidateResults: async function () {
    if (!this.web3 || !this.voting) {
      await this.eventStart();
    }
    const count = Number(await this.readCountCandidates());
    const out = [];
    for (let i = 1; i <= count; i++) {
      try {
        const c = await this.readCandidate(i);
        out.push({
          candidateId: Number(c[0]),
          name: String(c[1] || 'Unknown'),
          party: String(c[2] || 'Unknown'),
          voteCount: Number(c[3] || 0),
        });
      } catch {
        // skip broken candidate slots
      }
    }
    return out.sort((a, b) => b.voteCount - a.voteCount);
  },

  renderDates: async function () {
    try {
      // Prefer DB-driven election dates for realtime control; fall back to chain.
      let start = 0;
      let end = 0;
      try {
        const res = await fetch(`${API_BASE}/election/dates`);
        if (res.ok) {
          const data = await res.json();
          start = Number(data.start_ts || 0);
          end = Number(data.end_ts || 0);
        }
      } catch {
        // ignore and fall back
      }
      if (!(start > 0 && end > 0)) {
        const result = await this.readDates();
        start = Number(result[0]);
        end = Number(result[1]);
      }
      if (start > 0 && end > 0) {
        $('#dates').text(`${this.fmtTs(start)}  –  ${this.fmtTs(end)}`);
      } else {
        $('#dates').text('Voting dates not set');
      }
    } catch (e) {
      console.error('Failed to fetch dates:', e);
      $('#dates').text('Unable to load dates');
    }
  },

  loadCandidates: async function () {
    try {
      const isVoterPage = !!document.getElementById('voteStatus');
      let count = 0;
      if (!isVoterPage) {
        const countRaw = await this.readCountCandidates();
        count = Number(countRaw);
        window.countCandidates = count;
      }
      let disableVoteAction = false;

      $('#boxCandidate').empty();

      if (isVoterPage) {
        const qrToken = this.getActiveQrToken();
        const [dates, now] = await Promise.all([
          this.readDates(),
          this.getNowTs()
        ]);
        let voted = false;
        if (qrToken) {
          voted = await this.readCheckVoteByQr(qrToken);
        }
        const start = Number(dates[0]);
        const end = Number(dates[1]);
        const active = start > 0 && end > 0 && now >= start && now <= end;
        disableVoteAction = voted || !active;

        const voteStatus = document.getElementById('voteStatus');
        if (voteStatus) {
          if (!active) {
            voteStatus.textContent = 'Voting is not active right now.';
            voteStatus.style.display = 'block';
          } else if (voted) {
            voteStatus.textContent = 'This QR voter has already voted.';
            voteStatus.style.display = 'block';
          } else {
            voteStatus.textContent = '';
            voteStatus.style.display = 'none';
          }
        }
      }

      if (isVoterPage) {
        // Voter dashboard: fetch candidates from DB for realtime / clean slate.
        const res = await fetch(`${API_BASE}/candidates`);
        const data = await res.json();
        const items = (data && data.items) ? data.items : [];
        for (const c of items) {
          const id = Number(c.candidate_id);
          const name = c.name;
          const party = c.party;
          const row = `
            <div class="evm-row" role="listitem">
              <div class="evm-name">
                <div class="primary">${name}</div>
                <div class="meta">Candidate ID: ${id}</div>
              </div>
              <div class="evm-party">
                <div class="primary">${party}</div>
                <div class="symbol"><span class="evm-symbol-dot" aria-hidden="true"></span><span>Party</span></div>
              </div>
              <div class="evm-action">
                <button
                  class="vote-btn"
                  type="button"
                  data-candidate-id="${id}"
                  data-candidate-name="${String(name).replace(/"/g, '&quot;')}"
                  data-candidate-party="${String(party).replace(/"/g, '&quot;')}"
                  ${disableVoteAction ? 'disabled' : ''}
                >Vote</button>
              </div>
            </div>`;
          $('#boxCandidate').append(row);
        }
        return;
      }

      for (let i = 1; i <= count; i++) {
        try {
          const data = await this.readCandidate(i);
          
          const id = Number(data[0]);
          const name = data[1];
          const party = data[2];
          const voteCount = Number(data[3]);
          const row = isVoterPage
            ? `
            <tr>
              <td>${name}</td>
              <td>${party}</td>
              <td>
                <button class="vote-btn" type="button" data-candidate-id="${id}" ${disableVoteAction ? 'disabled' : ''}>Vote</button>
              </td>
            </tr>`
            : `
            <tr>
              <td>
                <input class="form-check-input" type="radio" name="candidate" value="${id}" id="c${id}"> ${name}
              </td>
              <td>${party}</td>
              <td>${voteCount}</td>
            </tr>`;
          $('#boxCandidate').append(row);
        } catch (e) {
          console.warn(`Failed to load candidate ${i}:`, e);
        }
      }
    } catch (e) {
      console.error('Failed to load candidates:', e);
      $('#boxCandidate').html('<tr><td colspan="3">Unable to load candidates.</td></tr>');
    }
  },

  updateVoteButtonState: async function () {
    try {
      const qrToken = this.getActiveQrToken();
      const [dates, now] = await Promise.all([
        this.readDates(),
        this.getNowTs()
      ]);
      let voted = false;
      if (qrToken) {
        voted = await this.readCheckVoteByQr(qrToken);
      }

      const start = Number(dates[0]);
      const end = Number(dates[1]);
      const active = start > 0 && end > 0 && now >= start && now <= end;

      $('#voteButton').prop('disabled', voted || !active);

      if (!active) {
        $('#msg').html('<p>Voting is not active for the current time window.</p>');
      } else if (voted) {
        $('#msg').html('<p>This QR voter has already voted.</p>');
      } else {
        $('#msg').html('');
      }
    } catch (e) {
      console.warn('updateVoteButtonState failed:', e);
      $('#voteButton').prop('disabled', true);
    }
  },

  performVote: async function (idNum, qrToken) {
    // Preflight 1: dates active?
    const dates = await this.readDates();
    const start = Number(dates[0]);
    const end = Number(dates[1]);
    const now = await this.getNowTs();

    if (!(start > 0 && end > 0)) {
      throw new Error('Voting dates are not set on the contract.');
    }
    if (now < start || now > end) {
      throw new Error(`Voting not active.\nStart: ${this.fmtTs(start)}\nEnd: ${this.fmtTs(end)}\nNow: ${this.fmtTs(now)}`);
    }

    // Preflight 2: QR already voted?
    if (!qrToken) {
      throw new Error('QR token missing. Verify voter first.');
    }
    const hasVoted = await this.readCheckVoteByQr(qrToken);
    if (hasVoted) {
      throw new Error('This QR voter has already voted.');
    }

    // Preflight 3: candidate exists?
    try {
      const cand = await this.readCandidate(idNum);
      const idOnChain = Number(cand[0]);
      const name = cand[1];
      if (idOnChain !== idNum || !name) {
        throw new Error('Selected candidate does not exist.');
      }
    } catch {
      throw new Error('Selected candidate does not exist.');
    }

    return this.sendVoteByQrTx(idNum, qrToken);
  },

  // ---- voting with preflight checks ----
  vote: async function () {
    const candidateID = $('input[name="candidate"]:checked').val();
    if (!candidateID) {
      $('#msg').html('<p>Please vote for a candidate.</p>');
      return;
    }

    try {
      const idNum = parseInt(candidateID, 10);
      const receipt = await this.performVote(idNum);
      console.log('Vote tx receipt:', receipt);
      $('#voteButton').prop('disabled', true);
      $('#msg').html('<p>Voted</p>');

      // Refresh UI
      await this.loadCandidates();
      await this.updateVoteButtonState();
    } catch (e) {
      this.showTxError('Vote failed', e);
    }
  },

  voteByCandidateId: async function (candidateID) {
    const idNum = Number(candidateID);
    if (!idNum) {
      throw new Error('Invalid candidate selected.');
    }
    const qrToken = this.getActiveQrToken();
    const receipt = await this.performVote(idNum, qrToken);
    await this.loadCandidates();
    await this.updateVoteButtonState();
    return receipt;
  },

  // ---- error surfacing ----
  showTxError: function (prefix, e) {
    // Try to extract revert reasons bubbled up by MetaMask/Ganache
    const msg =
      e?.data?.message ||
      e?.data?.originalError?.message ||
      e?.error?.message ||
      e?.message ||
      'Transaction failed';
    console.error(prefix + ':', e);
    alert(`${prefix}: ${msg}`);
  }
};

// Auto-init on load
window.addEventListener('load', () => {
  window.App.eventStart();
});
