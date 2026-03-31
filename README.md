# Decentralized Voting System

This project is a decentralized voting application built around four working parts:

- a Solidity smart contract deployed from Remix
- MetaMask for wallet-based blockchain transactions
- a Node/Express server for frontend hosting and login
- a FastAPI + MongoDB backend for voter data, verification, reports, and exports

The repository is organized so the blockchain remains the source of truth for vote transactions, while MongoDB handles voter identity, QR verification, audit records, nomination data, and admin-side reporting.

## System Flow

1. Admin deploys [Voting.sol](./contracts/Voting.sol) from Remix and sets `VOTING_CONTRACT_ADDRESS`.
2. Admin starts [main.py](./Database_API/main.py) for MongoDB-backed API services.
3. Admin starts [index.js](./index.js) to serve the frontend and proxy browser API calls.
4. Admin logs in, registers voters, adds candidates, and defines election dates.
5. Voters scan QR, pass face verification, vote using MetaMask, and receive an on-chain transaction hash.
6. Admin and public users can inspect results, verify transactions, export audit data, and review ML-based reports.

## Runtime Entry Points

### [index.js](./index.js)
What it does:
- runs the Express web server
- serves the active HTML, CSS, JS, bundle, and asset files
- handles admin login using MongoDB-backed credentials
- protects admin routes with JWT verification
- proxies frontend requests to the FastAPI backend

Advantage:
- keeps the browser setup simple because the frontend talks to one base URL
- centralizes login and route protection
- separates UI hosting from the Python API cleanly

### [Database_API/main.py](./Database_API/main.py)
What it does:
- runs the FastAPI backend
- connects to MongoDB and initializes collections/indexes
- registers voters and generates QR-linked voter IDs
- handles candidate nomination and election date storage
- performs QR lookup and live face verification
- stores vote audit records and image evidence
- exposes reporting and export endpoints

Advantage:
- keeps database and verification logic in one service
- makes Render deployment straightforward
- allows the frontend to stay thin and mostly UI-focused

### [contracts/Voting.sol](./contracts/Voting.sol)
What it does:
- stores candidate data on-chain
- stores election start/end timestamps on-chain
- records QR-token-based voting
- exposes public vote status and candidate result functions

Advantage:
- makes vote casting tamper-resistant
- gives public verifiability through blockchain events
- prevents QR token reuse at contract level

## Root Files

### [package.json](./package.json)
What it does:
- defines the Node project
- lists frontend/server dependencies
- defines build and start scripts

Advantage:
- gives a single place to install and run the Node side
- ensures the browser bundle is rebuilt consistently

### [package-lock.json](./package-lock.json)
What it does:
- locks exact Node dependency versions

Advantage:
- reduces “works on my machine” dependency drift
- improves reproducible installs

### [render.yaml](./render.yaml)
What it does:
- stores Render deployment configuration for the backend

Advantage:
- makes deployment repeatable
- reduces manual setup mistakes

### [runtime.txt](./runtime.txt)
What it does:
- defines the runtime version expected by deployment tooling

Advantage:
- helps keep hosted execution closer to local development

### [vercel.json](./vercel.json)
What it does:
- maps public routes to the active frontend files

Advantage:
- supports static-style routing cleanly if Vercel hosting is used

### [nodemon.json](./nodemon.json)
What it does:
- controls which files Nodemon ignores in development

Advantage:
- prevents unnecessary restarts during local work

## Smart Contract Folder

### [contracts/Voting.sol](./contracts/Voting.sol)
What it does:
- core election contract used by the browser app

Advantage:
- this is the main blockchain logic that Remix deploys

## Build and Script Files

### [scripts/generate_runtime_config.js](./scripts/generate_runtime_config.js)
What it does:
- reads environment variables
- writes the runtime browser config file

Advantage:
- avoids hardcoding API base URL, RPC URL, chain ID, and contract address in frontend source
- makes deployment configuration much easier

### [build/contracts/Voting.json](./build/contracts/Voting.json)
What it does:
- stores the compiled ABI and network metadata for the contract

Advantage:
- gives the browser app the ABI it needs to call contract functions
- avoids duplicating ABI definitions by hand

## Backend Files: `Database_API/`

### [Database_API/main.py](./Database_API/main.py)
What it does:
- main API server and MongoDB integration layer

Advantage:
- acts as the operational center of the backend

### [Database_API/duplicate_detection.py](./Database_API/duplicate_detection.py)
What it does:
- analyzes uploaded face images
- detects duplicate or near-duplicate voter photos
- compares live photos against registered voter photos

Advantage:
- prevents the same person from being registered multiple times
- strengthens the voter verification flow before vote access

### [Database_API/sentiment.py](./Database_API/sentiment.py)
What it does:
- scores feedback text using sentiment analysis
- builds candidate-wise sentiment summaries

Advantage:
- gives admins quick insight into voter experience and candidate perception
- turns free-text feedback into reportable data

### [Database_API/vote_prediction.py](./Database_API/vote_prediction.py)
What it does:
- estimates likely final vote totals from current voting progress
- calculates trend slope, confidence, and predicted winner

Advantage:
- gives a simple forecasting layer for admin monitoring
- helps interpret incomplete election data while voting is still ongoing

### [Database_API/anomaly_detection.py](./Database_API/anomaly_detection.py)
What it does:
- scans vote activity windows for unusual spikes
- protects the anomaly report with admin JWT checks

Advantage:
- helps detect suspicious bursts of vote activity
- adds a basic monitoring/control layer without changing the voting flow

### [Database_API/requirements.txt](./Database_API/requirements.txt)
What it does:
- lists Python dependencies for FastAPI, MongoDB, OpenCV, and ML/reporting

Advantage:
- makes backend setup predictable
- documents the backend technology stack clearly

### [Database_API/runtime.txt](./Database_API/runtime.txt)
What it does:
- pins backend runtime expectations

Advantage:
- improves deployment consistency

### `Database_API/media/`
What it does:
- stores generated voter photos, scan photos, and uploaded symbol images

Advantage:
- keeps image evidence accessible for audit and admin review

### `Database_API/__pycache__/`
What it does:
- stores Python bytecode cache

Advantage:
- speeds repeated local execution

### `Database_API/.venv/`
What it does:
- local Python virtual environment

Advantage:
- isolates backend dependencies from the global Python install

## Frontend HTML Files: `src/html/`

### [src/html/login.html](./src/html/login.html)
What it does:
- renders the login page for admin and voter entry

Advantage:
- creates a single controlled entry point into the system

### [src/html/admin.html](./src/html/admin.html)
What it does:
- renders the admin dashboard
- includes voter registration, election controls, live reports, ML reports, and voter card export actions

Advantage:
- gives admins one place to manage the full election workflow

### [src/html/candidate_nomination.html](./src/html/candidate_nomination.html)
What it does:
- renders the candidate nomination form used inside the admin page iframe

Advantage:
- keeps candidate nomination isolated and easier to manage

### [src/html/vote.html](./src/html/vote.html)
What it does:
- renders the voter-facing vote page
- includes QR scanning, verification, and candidate selection UI

Advantage:
- combines verification and voting into one guided experience

### [src/html/loading.html](./src/html/loading.html)
What it does:
- shows transaction progress after a vote is submitted
- supports post-vote feedback while waiting for confirmation

Advantage:
- improves user trust by showing transaction status instead of a blank wait

### [src/html/verify_vote.html](./src/html/verify_vote.html)
What it does:
- renders the public transaction verification page

Advantage:
- supports transparency and public confidence in the voting process

### [src/html/explorer.html](./src/html/explorer.html)
What it does:
- renders on-chain results and public vote event history

Advantage:
- gives a public blockchain-style explorer without exposing admin controls

## Frontend JavaScript Files: `src/js/`

### [src/js/app.js](./src/js/app.js)
What it does:
- initializes Web3 and MetaMask connectivity
- loads the contract ABI and address
- reads candidates, dates, results, and vote events
- sends candidate creation, date-setting, and voting transactions
- verifies transaction hashes against chain data

Advantage:
- keeps all blockchain logic in one reusable browser module
- reduces duplication across admin, vote, verifier, and explorer pages

### [src/js/admin.js](./src/js/admin.js)
What it does:
- runs the admin dashboard behavior
- registers voters and generates voter cards
- downloads QR and voter ID card PDF
- loads live reports and ML reports
- handles election stop/restart controls
- coordinates candidate nomination iframe messages

Advantage:
- centralizes admin-side browser behavior
- keeps the admin page interactive without moving logic into inline HTML

### [src/js/candidate_nomination.js](./src/js/candidate_nomination.js)
What it does:
- validates candidate nomination form input
- checks duplicates before save
- passes approved on-chain candidate creation requests to the parent admin page

Advantage:
- reduces bad nomination data before it reaches the backend or contract

### [src/js/login-page.js](./src/js/login-page.js)
What it does:
- submits login credentials
- stores JWT tokens in localStorage
- redirects users by role

Advantage:
- keeps login flow simple and role-aware

### [src/js/voter.js](./src/js/voter.js)
What it does:
- runs QR scanning
- fetches voter data by QR token
- captures live image for initial verification

Advantage:
- prevents unauthorized voting before the EVM-style interface is enabled

### [src/js/vote.js](./src/js/vote.js)
What it does:
- handles final vote readiness check
- submits the vote transaction through MetaMask
- stores pending audit data for confirmation stage

Advantage:
- separates vote submission logic from scan/verification logic
- makes the final vote process easier to reason about

### [src/js/loading.js](./src/js/loading.js)
What it does:
- monitors blockchain transaction confirmation
- syncs pending audit data to the backend
- handles optional feedback save
- resets voter session state for the next voter

Advantage:
- prevents half-finished vote sessions
- improves reliability between blockchain confirmation and backend audit save

### [src/js/verify_vote.js](./src/js/verify_vote.js)
What it does:
- verifies a transaction hash and renders receipt details

Advantage:
- gives users a direct self-service proof check

### [src/js/explorer.js](./src/js/explorer.js)
What it does:
- loads candidate result data and recent vote events

Advantage:
- supports a transparent public election dashboard

### [src/js/config.js](./src/js/config.js)
What it does:
- exposes frontend runtime config values

Advantage:
- keeps shared config logic small and reusable

### [src/js/runtime-config.js](./src/js/runtime-config.js)
What it does:
- stores generated browser runtime settings

Advantage:
- lets the same frontend code run in different environments without manual edits

### [src/js/utils.js](./src/js/utils.js)
What it does:
- contains shared helper functions for DOM lookup, API requests, status messages, and downloads

Advantage:
- avoids repeated boilerplate across frontend modules

## Frontend CSS Files: `src/css/`

### [src/css/login.css](./src/css/login.css)
What it does:
- styles the login page

Advantage:
- keeps the entry screen clear and focused

### [src/css/admin.css](./src/css/admin.css)
What it does:
- styles the admin dashboard, voter card, action buttons, and report sections

Advantage:
- keeps a large admin page organized and readable

### [src/css/candidate_nomination.css](./src/css/candidate_nomination.css)
What it does:
- styles the nomination form

Advantage:
- improves data-entry usability for admins

### [src/css/vote.css](./src/css/vote.css)
What it does:
- styles the voter page, QR scan area, and EVM-style voting layout

Advantage:
- makes the actual vote experience clearer and more controlled

### [src/css/loading.css](./src/css/loading.css)
What it does:
- styles the transaction confirmation page

Advantage:
- makes pending/confirmed/error states easier to understand

### [src/css/public_verifier.css](./src/css/public_verifier.css)
What it does:
- styles the public verification and explorer pages

Advantage:
- keeps public-facing transparency pages visually consistent

## Assets and Generated Output

### [src/assets/eth5.jpg](./src/assets/eth5.jpg)
What it does:
- provides the background image used by parts of the frontend

Advantage:
- gives the interface a distinct identity

### [src/dist/app.bundle.js](./src/dist/app.bundle.js)
What it does:
- browserified bundle generated from [src/js/app.js](./src/js/app.js)

Advantage:
- allows CommonJS-style frontend blockchain code to run in the browser

## Environment Variables

Required variables:

- `MONGODB_URI` or `MONGO_URI`: MongoDB connection string
- `JWT_SECRET` or `SECRET_KEY`: JWT signing secret
- `ADMIN_USERNAME`: admin login username
- `ADMIN_PASSWORD`: admin login password
- `ADMIN_FULL_NAME`: admin display name
- `CHAIN_ID`: blockchain network ID expected by the frontend
- `RPC_URL`: RPC endpoint used by the browser logic
- `VOTING_CONTRACT_ADDRESS`: Remix-deployed contract address
- `DATABASE_API_BASE` or `API_BASE`: backend API base URL

Useful optional variables:

- `FRONTEND_URL`: explicit frontend origin for CORS
- `CORS_ALLOWED_ORIGINS`: extra allowed origins
- `LIVE_FACE_VERIFICATION_THRESHOLD`: match threshold for vote-time face verification
- `MONGO_SERVER_SELECTION_TIMEOUT_MS`: MongoDB timeout tuning
- `REQUIRE_MONGO_ON_STARTUP`: whether Express should refuse startup without MongoDB

## Commands

### Install Node dependencies

```powershell
npm install
```

### Install Python dependencies

```powershell
Database_API\.venv\Scripts\python.exe -m pip install -r Database_API\requirements.txt
```

### Build frontend runtime bundle

```powershell
npm run build
```

### Start backend

```powershell
python Database_API\main.py
```

### Start frontend/server

```powershell
npm start
```

## Main Advantages of This Architecture

- Blockchain voting remains publicly verifiable and harder to tamper with.
- MongoDB handles identity, nomination, reporting, and audit tasks that do not belong on-chain.
- Express keeps frontend delivery and login simple.
- FastAPI keeps backend logic modular and deployable on Render.
- ML reporting adds prediction, sentiment, and anomaly insights without changing the main vote flow.
- QR plus face verification adds an extra identity check before voting.

## Security Model

### Official vote count source

The official live vote total should be treated as blockchain data, not MongoDB data.

- on-chain vote totals come from [contracts/Voting.sol](./contracts/Voting.sol)
- public verification pages and explorer pages read blockchain transactions and events
- MongoDB is used for voter identity, nominations, audit records, exports, and ML-style reporting

Advantage:
- if someone tampers with MongoDB, they should not be able to change the official on-chain election result

### Current protection in this project

- vote casting is enforced by the smart contract
- QR token reuse is blocked on-chain
- audit save now depends on a real successful blockchain transaction hash
- admin live report is intended to reflect blockchain-based totals

Advantage:
- database tampering becomes much less useful because the trusted result is no longer the DB counter

### Important security note

If an attacker gets write access to MongoDB, they may still be able to alter:

- voter profile data
- candidate metadata
- nomination records
- audit and ML/reporting data

But they should not be able to forge real blockchain vote totals without controlling actual blockchain transactions.

### Recommended deployment security

- keep MongoDB private and never expose it publicly without strict access control
- use a dedicated DB user with minimum required permissions
- use a strong `JWT_SECRET` or `SECRET_KEY`
- rotate secrets if credentials are leaked
- back up MongoDB regularly
- treat blockchain explorer and transaction verification as the final public proof of votes
