# Decentralized Voting System Master Reference

This file is a current, code-derived replacement reference for the repository.
It is written from the source files that exist now, not from older README text.

Scope:

- Documents the maintained application files and their responsibilities
- Summarizes page flow, API flow, blockchain flow, and ML helpers
- Notes generated or legacy files separately so source-of-truth files stay clear

Out of scope:

- `node_modules/`
- generated contract artifacts and cache internals except where they affect runtime
- binary images in `public/` and `Database_API/media/`

## 1. System Summary

This project combines four major layers:

1. A browser frontend for login, admin control, voting, public verification, and public exploration
2. A Node.js Express server that serves the UI, protects admin pages, proxies API requests, and seeds admin login data
3. A FastAPI backend that stores election data in MongoDB and performs voter identity checks
4. A Solidity voting contract that stores candidates, election dates, and QR-based on-chain vote state

The project also includes ML-assisted reporting:

- sentiment analysis with VADER
- vote forecasting with `LinearRegression`
- anomaly detection with `IsolationForest`

## 2. Runtime Architecture

| Layer | Main files | Purpose |
| --- | --- | --- |
| Frontend pages | `src/html/*` | Page structure and route targets |
| Frontend logic | `src/js/*` | Login, admin tools, QR verification, EVM voting, explorer, verifier |
| Frontend styling | `src/css/*` | Page-level styling |
| Blockchain browser bundle | `src/js/app.js`, `src/dist/app.bundle.js` | Web3, contract reads/writes, vote verification, explorer reads |
| Web server | `index.js` | Static hosting, admin auth gate, FastAPI proxy, Mongo-backed admin login |
| Backend API | `Database_API/main.py` | Mongo persistence, voter registration, face checks, audit, reports |
| Vision helpers | `Database_API/duplicate_detection.py` | Face detection and similarity scoring |
| ML helpers | `Database_API/sentiment.py`, `Database_API/vote_prediction.py`, `Database_API/anomaly_detection.py` | Reporting and analysis |
| Smart contract | `contracts/Voting.sol` | Candidate registry, vote casting, QR vote lock, date window enforcement |

## 3. Main User Flows

### 3.1 Login flow

1. `src/html/login.html` renders the login form.
2. `src/js/login-page.js` sends credentials to `/login`.
3. `index.js` authenticates against Mongo-seeded admin users.
4. Admins are redirected to `/admin.html`.
5. Voters are redirected to `/vote.html`.

### 3.2 Voter registration flow

1. Admin opens `src/html/admin.html`.
2. `src/js/admin.js` captures or uploads a face image.
3. `POST /admin/voters` in `Database_API/main.py` validates age and face quality.
4. `Database_API/duplicate_detection.py` checks for duplicate or near-duplicate voter faces.
5. Backend stores voter data, generates a voter ID, and creates a QR token.
6. Admin UI renders a printable ID card and QR image.

### 3.3 Candidate nomination flow

1. Admin page hosts `src/html/candidate_nomination.html` inside an iframe.
2. `src/js/candidate_nomination.js` validates the form and checks duplicates via `/admin/candidate-nominations/check`.
3. The iframe posts a message to the parent admin page.
4. Parent page uses `window.App` from `src/js/app.js` to call `addCandidate` on-chain.
5. Backend saves the nomination and candidate metadata in MongoDB.

### 3.4 Voting flow

1. Voter opens `src/html/vote.html`.
2. `src/js/voter.js` scans QR code, fetches voter details, captures a live image, and confirms the scan with `/voter/confirm-scan`.
3. `src/js/vote.js` performs a second ready-check face verification through `/voter/ready-check`.
4. `src/js/app.js` verifies election dates and QR vote status on-chain.
5. Voter selects a candidate and confirms the vote.
6. Contract transaction hash is stored in `localStorage`.
7. `src/html/loading.html` and `src/js/loading.js` wait for confirmation, sync audit data, accept optional feedback, and reset voter state.

### 3.5 Public verification flow

1. `src/html/verify_vote.html` accepts a transaction hash.
2. `src/js/verify_vote.js` calls `window.App.verifyVoteTransaction`.
3. `src/js/app.js` reads the transaction, receipt, logs, and candidate metadata from chain.
4. Result page shows vote status, candidate, party, block, gas, timestamp, and wallet.

### 3.6 Public explorer flow

1. `src/html/explorer.html` loads results and vote events.
2. `src/js/explorer.js` calls `window.App.getCandidateResults()` and `window.App.getPublicVoteEvents()`.
3. `src/js/app.js` decodes contract events and enriches them with timestamps and candidate details.

## 4. Browser Storage Keys

The frontend uses `localStorage` heavily for booth-style state handoff:

| Key | Purpose |
| --- | --- |
| `jwtTokenAdmin` | Admin session token |
| `jwtTokenVoter` | Voter session token |
| `verifiedVoter` | QR-verified and face-verified voter snapshot |
| `selectedCandidate` | Current selected candidate before final vote |
| `currentTxHash` | Active blockchain transaction |
| `txStatus` | `pending`, `confirming`, `confirmed`, or `failed` |
| `txConfirmations` | Confirmation counter |
| `blockNumber` | Mined block number |
| `voteSubmittedTime` | Submission timestamp |
| `pendingVoteAudit` | Vote audit payload queued for backend sync |
| `pendingVoteFeedback` | Temporary feedback draft on loading page |
| `lastTxSummary` | Last completed vote summary for verify page |
| `lastVoteCompleted` | Marker used to force fresh QR verification next round |

## 5. Backend Collections

`Database_API/main.py` works with these MongoDB collections:

| Collection | Purpose |
| --- | --- |
| `voters` | Voter identity, QR token, role, image path |
| `candidates` | Candidate metadata used by the frontend |
| `candidate_nominations` | Nomination records and party symbol references |
| `election_config` | Current election dates, status, reconduct count |
| `vote_audit` | Vote audit trail, images, tx hash, optional feedback sentiment |
| `vote_report_live` | Live ranked vote counts |
| `counters` | Auto-increment style sequence values |

## 6. API Surface

### Public or voter-facing endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/login` | `GET` | Role lookup and JWT creation |
| `/voter/by-qr` | `GET` | Load voter record by QR token |
| `/candidates` | `GET` | Candidate list with live vote counts |
| `/election/dates` | `GET` | Current election state |
| `/voter/confirm-scan` | `POST` | First live-face verification after QR scan |
| `/voter/ready-check` | `POST` | Second live-face verification before voting |
| `/vote/audit` | `POST` | Save vote audit or later feedback |
| `/vote/report` | `GET` | Ranked live results from backend DB |
| `/vote/prediction` | `GET` | ML forecast report |
| `/vote/sentiment-report` | `GET` | Candidate sentiment summary |

### Admin-focused endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/admin/voters` | `POST` | Register voter with face duplicate detection |
| `/admin/candidates` | `POST` | Upsert candidate metadata |
| `/admin/candidate-nominations/keys` | `GET` | Fetch nomination identifiers for duplicate checks |
| `/admin/candidate-nominations/check` | `POST` | Validate nomination before save |
| `/admin/candidate-nominations` | `POST` | Save nomination record |
| `/admin/election/dates` | `POST` | Save election date window |
| `/admin/election/stop` | `POST` | Stop election |
| `/admin/election/restart` | `POST` | Restart or reconduct election |
| `/admin/anomaly-report` | `GET` | Admin-only anomaly report, JWT required |
| `/admin/vote-audit/export` | `GET` | CSV export |
| `/admin/vote-audit/image/{audit_id}` | `GET` | Serve stored audit image blob |
| `/admin/database/clear` | `POST` | Clear Mongo records and media files |

## 7. Smart Contract Summary

`contracts/Voting.sol` stores:

- candidates by integer ID
- wallet vote status in `voters`
- QR-hash vote status in `votedQrTokens`
- election start and end timestamps

Main functions:

- `addCandidate(string name, string party)`
- `vote(uint candidateID)`
- `voteByQr(uint candidateID, string qrToken)`
- `checkVote()`
- `checkVoteByQr(string qrToken)`
- `setDates(uint256 start, uint256 end)`
- `getDates()`
- `getCandidate(uint candidateID)`
- `getCountCandidates()`

Main events:

- `CandidateAdded`
- `Voted`
- `VotedByQr`
- `VoteCast`
- `DatesSet`

Important contract behavior:

- date window enforced on-chain
- candidate ID bounds enforced on-chain
- QR token reuse blocked on-chain
- vote events remain public even if backend data is later cleared

## 8. File-by-File Reference

### 8.1 Root files

| File | Responsibility |
| --- | --- |
| `package.json` | Defines Node scripts: `start`, `dev`, `build`, `build:app`. Declares Express, Web3, Truffle Contract, JWT, Mongoose, Browserify. |
| `package-lock.json` | Locked Node dependency tree. |
| `index.js` | Main Express app. Serves frontend assets, protects admin routes with JWT, connects to MongoDB, seeds default admin, proxies selected routes to FastAPI, exposes `/healthz`, and runs the chain-to-DB sync script. |
| `README.md` | Older top-level documentation file currently present in the repository history but deleted in the working tree. |
| `PAGES.md` | Older page-focused documentation file currently present in the repository history but deleted in the working tree. |
| `all.md` | This consolidated master reference. |
| `.env` | Local environment file for Mongo, blockchain, admin credentials, and API config. |
| `.gitignore` | Git ignore rules. |
| `nodemon.json` | Development reload config for Node server. |
| `render.yaml` | Render deployment for the FastAPI service from `Database_API/`. |
| `runtime.txt` | Python runtime version for Render-style deployment. |
| `vercel.json` | Vercel rewrites for serving frontend files directly. |
| `truffle-config.js` | Truffle network config for local Ganache-style development. |
| `check_networks.py` | Small helper script that prints deployed contract addresses from a hardcoded artifact path. Useful as a local diagnostic, not part of runtime. |

### 8.2 `scripts/`

| File | Responsibility |
| --- | --- |
| `scripts/generate_runtime_config.js` | Reads env vars and writes `src/js/runtime-config.js` with API base, RPC URL, chain ID, and contract address. |
| `scripts/sync_chain_to_db.js` | Reads on-chain candidates and dates from deployed contract and posts them into backend DB endpoints. |

### 8.3 `contracts/` and `migrations/`

| File | Responsibility |
| --- | --- |
| `contracts/Voting.sol` | Core smart contract. |
| `contracts/Migrations.sol` | Standard Truffle migrations contract. |
| `contracts/2_deploy_contracts.js` | Deploys `Voting.sol` through Truffle. |
| `migrations/1_initial_migration.js` | Deploys the standard `Migrations` contract. |

### 8.4 `Database_API/`

| File | Responsibility |
| --- | --- |
| `Database_API/main.py` | FastAPI application. Handles schema init, Mongo connection, voter registration, candidate nomination, election state, live verification, audit storage, exports, and report endpoints. |
| `Database_API/duplicate_detection.py` | OpenCV-based face analysis. Detects frontal/profile faces, extracts features, compares images, and returns similarity scores. Used both for duplicate registration checks and live verification. |
| `Database_API/sentiment.py` | VADER-based feedback scoring. Produces positive/neutral/negative labels and aggregate candidate sentiment reports. |
| `Database_API/vote_prediction.py` | Uses current vote history to forecast final counts, winner, turnout progress, and confidence. |
| `Database_API/anomaly_detection.py` | Builds rolling vote-rate windows and uses `IsolationForest` to flag suspicious spikes. Also contains JWT admin-role validation helper. |
| `Database_API/requirements.txt` | Python dependencies for the API and ML features. |
| `Database_API/runtime.txt` | Python runtime file for backend deployment. |
| `Database_API/media/*` | Saved voter photos, scan images, and party symbol images. Runtime/generated content, not source. |
| `Database_API/__pycache__/*` | Python bytecode cache. Generated, not source. |

### 8.5 `Database_API/main.py` endpoint map

Important helper areas inside `main.py`:

- Mongo URI normalization and DB name resolution
- date parsing and age validation
- image decoding and file save helpers
- index creation in `ensure_schema()`
- vote rank refresh in `refresh_vote_rankings()`
- duplicate voter search in `find_existing_voter_duplicate()`
- live face verification in `verify_live_face_against_voter()`

Important behavior details:

- admin user is mirrored into the `voters` collection during schema setup
- election stop is enforced before QR lookup, scan confirmation, ready-check, and vote audit
- `vote_audit` enforces one record per voter, but a second call with only feedback updates the existing record
- audit export exposes image URLs through `/admin/vote-audit/image/{audit_id}`
- clearing the database also deletes files inside `Database_API/media/` and recreates schema defaults

### 8.6 `src/html/`

| File | Responsibility |
| --- | --- |
| `src/html/login.html` | Entry page with login form and runtime-config/login script includes. |
| `src/html/admin.html` | Admin portal layout. Contains voter registration UI, election controls, live reports, ML report tables, and the nomination iframe. |
| `src/html/candidate_nomination.html` | Standalone nomination form UI used inside the admin iframe. |
| `src/html/vote.html` | Main combined voter page: QR verification, election banner, EVM-style candidate rows, and cancel/message area. |
| `src/html/loading.html` | Vote processing screen with tx hash, confirmation progress, optional feedback form, and retry state. |
| `src/html/verify_vote.html` | Public receipt checker by tx hash. |
| `src/html/explorer.html` | Public results and vote-event explorer. |
| `src/html/index.html` | Legacy chain-driven voting page still kept for compatibility. |
| `src/html/voter.html` | Older QR + EVM voter dashboard; Express now redirects `/voter.html` to `/vote.html`. |

### 8.7 `src/js/`

| File | Responsibility |
| --- | --- |
| `src/js/config.js` | Exposes `API_BASE` and `FRONTEND_BASE` from runtime config or current origin. |
| `src/js/runtime-config.js` | Generated file consumed by browser modules. Not hand-edited. |
| `src/js/utils.js` | Shared DOM helpers, JSON parsing, HTTP wrapper, status messaging, and file download helper. |
| `src/js/login.js` | Duplicate login implementation; functionally similar to `login-page.js`. |
| `src/js/login-page.js` | Active login form logic used by `login.html`. |
| `src/js/admin.js` | Admin dashboard controller. Handles camera/photo capture, voter registration, QR save, election stop/restart, live report polling, ML report loading, DB clear, and nomination iframe messaging. |
| `src/js/candidate_nomination.js` | Validates form fields, handles independent-candidate logic, party symbol preview/upload, duplicate checks, parent-window blockchain messaging, and final nomination save. |
| `src/js/app.js` | Browser blockchain layer. Initializes provider, switches network, loads contract, verifies tx receipts, reads public events, reads candidates, writes dates, adds candidates, checks QR vote state, and sends vote transactions. |
| `src/js/voter.js` | QR verification controller. Manages scanner backends, live camera capture, stale state cleanup, QR lookup, first face match, and verification persistence. |
| `src/js/vote.js` | Final vote controller. Watches verified voter state, performs ready-check face capture, enforces election stop/QR-voted guards, renders EVM rows, captures pre-vote image, submits vote via `window.App`, and stages audit payload for loading page sync. |
| `src/js/loading.js` | Polls RPC or injected provider for transaction confirmation, syncs pending audit, records last tx summary, accepts optional feedback, and resets booth state. |
| `src/js/verify_vote.js` | Reads a tx hash from query/local storage/input and renders the verification receipt. |
| `src/js/explorer.js` | Loads public results and latest vote events and renders explorer tables. |

### 8.8 `src/css/`

| File | Responsibility |
| --- | --- |
| `src/css/login.css` | Login page styling. |
| `src/css/admin.css` | Admin portal styling, tables, registration card, ML report layout. |
| `src/css/candidate_nomination.css` | Government-form style for nomination page with floating labels and alerts. |
| `src/css/vote.css` | Main combined voting page styling, QR verification section, EVM machine layout, status states. |
| `src/css/loading.css` | Vote-processing screen styling, progress bar, feedback panel, error state. |
| `src/css/public_verifier.css` | Shared styling for verify and explorer pages. |
| `src/css/index.css` | Legacy `index.html` styles. |
| `src/css/voter.css` | Legacy `voter.html` styles. |

### 8.9 Generated frontend output

| File | Responsibility |
| --- | --- |
| `src/dist/app.bundle.js` | Browserify bundle generated from `src/js/app.js`. Runtime artifact. |
| `src/dist/login.bundle.js` | Older bundled login artifact. Runtime artifact. |
| `client/dist/*` | Separate built frontend output kept in repo. Not the main source used by Express routes. |

### 8.10 Blockchain artifacts and caches

| Path | Responsibility |
| --- | --- |
| `build/contracts/*` | Truffle contract artifacts consumed by browser bundle and scripts. |
| `artifacts/*` | Additional contract build output. |
| `cache/*` | Solidity cache data. |

### 8.11 Public assets

| Path | Responsibility |
| --- | --- |
| `public/favicon.ico` | Site favicon. |
| `public/*.png` and `public/*.jpg` | Screenshot assets. |
| `src/assets/eth5.jpg` | Frontend image asset. |

## 9. Notable Implementation Details

### 9.1 Authentication split

There are two login paths in the repo:

- Express `index.js` handles active login used by the frontend and seeds admin data in Mongo
- FastAPI `Database_API/main.py` still exposes `/login` using `voters` collection credentials

In the current frontend, login goes through the Express layer.

### 9.2 Face verification strategy

`Database_API/duplicate_detection.py` does more than a simple hash compare. It combines:

- frontal and profile Haar cascade detection
- CLAHE normalization
- average hash
- grayscale histogram
- LBP histogram
- HOG descriptor
- edge histogram
- optional ORB descriptor matching

This is used both for:

- registration-time duplicate detection
- live scan and ready-check validation

### 9.3 Vote audit strategy

Audit records can contain:

- voter ID
- candidate ID and name
- party
- pre-vote image
- on-vote-day image
- tx hash
- vote timestamp
- optional feedback and sentiment score

The DB report and the blockchain report are intentionally separate:

- backend DB gives administrative reporting and exports
- blockchain explorer gives immutable public event history

### 9.4 Election restart behavior

Restarting with `reset_results=true` clears backend vote audit and live report data, but does not reset the smart contract.
For a truly fresh on-chain election, the contract must be redeployed.

## 10. Environment Variables

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` or `MONGO_URI` | Mongo connection string |
| `MONGO_DB_NAME` and related DB vars | Explicit DB name override |
| `SECRET_KEY` or `JWT_SECRET` | JWT signing secret |
| `ADMIN_USERNAME` | Seeded admin username |
| `ADMIN_PASSWORD` | Seeded admin password |
| `ADMIN_FULL_NAME` | Seeded admin full name |
| `CHAIN_ID` | Required blockchain network ID |
| `RPC_URL` | RPC URL for browser and scripts |
| `VOTING_CONTRACT_ADDRESS` | Contract address override used by frontend |
| `DATABASE_API_BASE`, `FASTAPI_BASE`, or `API_BASE` | Express proxy target |
| `FRONTEND_API_BASE` | Browser API base override injected into runtime config |
| `FRONTEND_URL` | Allowed frontend origin |
| `CORS_ALLOWED_ORIGINS` | Extra allowed CORS origins |
| `LIVE_FACE_VERIFICATION_THRESHOLD` | Threshold for vote-time live face matching |
| `FACE_MATCH_THRESHOLD` | Threshold for registration duplicate matching |
| `REQUIRE_MONGO_ON_STARTUP` | Controls whether Express refuses to boot without Mongo |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | Mongo connection timeout |

## 11. Commands

| Command | Effect |
| --- | --- |
| `npm install` | Install Node dependencies |
| `pip install -r Database_API\\requirements.txt` | Install Python dependencies |
| `npm start` | Generate runtime config, bundle `app.js`, start Express |
| `npm run dev` | Same build steps plus `nodemon` |
| `npm run build` | Generate runtime config and bundle browser app |
| `node scripts\\sync_chain_to_db.js` | Sync chain candidates and dates to backend DB |
| `python Database_API\\main.py` | Start FastAPI locally via embedded `uvicorn.run` |
| `npx truffle migrate --reset --network development` | Local contract deployment |

## 12. Current Source-of-Truth Notes

- The maintained runtime entrypoints are `index.js`, `Database_API/main.py`, `contracts/Voting.sol`, and the files under `src/`.
- `src/html/index.html`, `src/html/voter.html`, `src/css/index.css`, and `src/css/voter.css` are legacy/compatibility surfaces.
- `src/js/login.js` and `src/js/login-page.js` are near-duplicates; `login.html` currently loads `login-page.js`.
- `README.md` and `PAGES.md` are currently deleted in the working tree, so `all.md` is the safest up-to-date consolidated reference.
