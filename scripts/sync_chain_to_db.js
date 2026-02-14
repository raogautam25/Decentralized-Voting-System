/* Sync on-chain candidates/dates -> Database API (MySQL).
 *
 * Usage: node scripts/sync_chain_to_db.js
 * Env:
 *   RPC_URL   (default http://127.0.0.1:7545)
 *   API_BASE  (default http://127.0.0.1:8000)
 */

const path = require('path');
const Web3 = require('web3');

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) ? (data.detail || data.message) : text;
    throw new Error(`HTTP ${res.status} ${url}: ${msg}`);
  }
  return data;
}

async function main() {
  const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:7545';
  const apiBase = process.env.API_BASE || 'http://127.0.0.1:8000';

  const artifactPath = path.join(__dirname, '..', 'build', 'contracts', 'Voting.json');
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const artifact = require(artifactPath);

  const web3 = new Web3(rpcUrl);
  const netId = String(await web3.eth.net.getId());
  const entry = artifact.networks && artifact.networks[netId];
  if (!entry || !entry.address) {
    throw new Error(`No deployed Voting contract found in artifact for network id ${netId}`);
  }

  const contract = new web3.eth.Contract(artifact.abi, entry.address);

  const count = Number(await contract.methods.getCountCandidates().call());
  let synced = 0;
  for (let i = 1; i <= count; i++) {
    // getCandidate returns (id, name, party, voteCount)
    // web3 may return array-like object; use indices.
    // eslint-disable-next-line no-await-in-loop
    const c = await contract.methods.getCandidate(i).call();
    const candidateId = Number(c[0]);
    const name = String(c[1] || '').trim();
    const party = String(c[2] || '').trim();
    if (!candidateId || !name || !party) continue;

    // eslint-disable-next-line no-await-in-loop
    await postJson(`${apiBase}/admin/candidates`, {
      candidate_id: candidateId,
      name,
      party,
    });
    synced += 1;
  }

  // Sync election dates too (optional)
  try {
    const dates = await contract.methods.getDates().call();
    const startTs = Number(dates[0] || 0);
    const endTs = Number(dates[1] || 0);
    if (startTs > 0 && endTs > 0 && endTs > startTs) {
      await postJson(`${apiBase}/admin/election/dates`, { start_ts: startTs, end_ts: endTs });
    }
  } catch {
    // ignore dates sync
  }

  const out = {
    ok: true,
    network_id: netId,
    contract_address: entry.address,
    chain_candidates: count,
    db_candidates_synced: synced,
  };
  // Print machine-readable output for the Express route
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  const out = { ok: false, error: err && err.message ? err.message : String(err) };
  process.stdout.write(JSON.stringify(out));
  process.exitCode = 1;
});

