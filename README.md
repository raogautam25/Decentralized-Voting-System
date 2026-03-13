# Decentralized Voting System (Ethereum + QR Verification + MySQL)

This project is a local, end-to-end voting demo:

- Frontend: static pages served by `index.js` (Express) on `http://127.0.0.1:8080`
- Blockchain: Ganache RPC on `http://127.0.0.1:7545`
- Smart contract: Truffle (`contracts/Voting.sol`)
- Database API: FastAPI + MySQL on `http://127.0.0.1:8000`
- Verification: Voter QR token + camera capture (auto verification flow)
- Audit: vote audit stored in MySQL, including vote-day images stored as BLOBs

## Ports

- `8080`: frontend server (`index.js`)
- `7545`: Ganache RPC (`Ganache UI` or `ganache`)
- `8000`: Database API (`Database_API/main.py`)

## Run Locally

1. Start Ganache (RPC `7545`, chain id `1337`)
2. Start Database API:
   - `cd Database_API`
   - `.\.venv\Scripts\python.exe main.py`
3. Start frontend:
   - project root: `node index.js`

## Deploy / Redeploy Contract

When you reset Ganache or change contract code:

```powershell
npx truffle migrate --reset --network development
```

## Key URLs

- Login: `http://127.0.0.1:8080/`
- Admin: `http://127.0.0.1:8080/admin.html?Authorization=Bearer <JWT>`
- Voter: `http://127.0.0.1:8080/voter.html`
- Vote: `http://127.0.0.1:8080/vote.html`
- Verify Vote: `http://127.0.0.1:8080/verify-vote.html`
- Explorer: `http://127.0.0.1:8080/explorer.html`
- API docs: `http://127.0.0.1:8000/docs`

## Admin Features

- Register voters and generate a printable ID card + QR (download QR as PNG)
- Download vote audit report (CSV)
- Delete all MySQL data (database wipe)
- Sync candidates/dates from blockchain -> DB (one click)

## Voter Flow (QR)

1. Start QR scan on `voter.html`
2. QR token auto-detected and auto-verified (camera image captured)
3. Vote buttons are disabled until verification completes
4. Vote page requires a live photo capture before allowing the vote submission
5. Public verifier can validate the vote using transaction hash
6. Explorer page shows on-chain vote events and live result table

## Notes

- Clearing MySQL does not clear blockchain state. For a truly fresh election, reset Ganache and redeploy the contract.
- Voter dashboard candidate list is DB-backed (realtime) to avoid mixing old on-chain candidates with new elections.
