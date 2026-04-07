# Decentralized Voting System

This project is a hybrid decentralized voting platform that combines:

- a Solidity smart contract for tamper-resistant vote storage
- MetaMask for user-approved blockchain transactions
- a Node/Express layer for frontend hosting, login, and browser-friendly routing
- a FastAPI + MongoDB backend for voter identity, QR verification, reporting, media storage, and exports

The result is not a "blockchain-only" app and not a "database-only" app. It is a layered architecture where:

- blockchain is the source of truth for vote casting and final vote totals
- MongoDB stores operational data that should not live on-chain
- Express keeps the frontend and login flow simple
- FastAPI keeps verification, database logic, and reporting modular
- Remix is used as the smart contract deployment and debugging environment, not as the production web backend
- Render is used to deploy the web services

## Core Idea

This system is built around a practical separation of responsibilities:

- `Voting.sol` handles vote-related state that must be publicly verifiable
- MongoDB handles voter records, QR tokens, candidate metadata, nomination forms, audit trails, and exported reports
- the frontend coordinates QR verification, face verification, candidate selection, and MetaMask signing

That split is the main architectural decision in this project.

## Why This Architecture Exists

### Why not store everything on blockchain?

Because blockchain is expensive, slow for large media/data, and unsuitable for storing:

- voter photos
- face verification images
- large reports
- admin login data
- nomination forms
- CSV exports

Advantage:
- vote integrity stays on-chain
- operational data stays off-chain where it is cheaper and easier to manage

### Why not keep everything only in MongoDB?

Because then the official vote result would depend entirely on database trust.

Advantage:
- blockchain provides public proof that votes happened
- contract logic prevents QR-token reuse at the smart contract level
- final vote totals are harder to tamper with than plain database counters

### Why Remix + Render instead of one single framework?

This project uses each tool for the job it is best at:

- Remix IDE: compile, deploy, inspect, and debug the smart contract
- MetaMask: sign blockchain transactions in the browser
- Render: host the Node and Python services
- MongoDB Atlas: persistent cloud database

Advantage:
- easier smart contract iteration with Remix
- easier cloud deployment with Render
- cleaner operational database with MongoDB Atlas

## High-Level Architecture

```text
Admin / Voter Browser
        |
        v
Node / Express
 - serves HTML/CSS/JS
 - login
 - route protection
 - frontend runtime config
 - API proxying
        |
        v
FastAPI + MongoDB
 - voter registration
 - QR lookup
 - face verification
 - candidate data
 - election state
 - reports / exports / ML summaries
        |
        +--------------------+
        |                    |
        v                    v
   MongoDB Atlas       Ethereum Contract
 - voter data          - official vote state
 - nomination data     - QR vote lock
 - audit images        - candidate vote counts
 - reports             - public verification
```

## Production Components

### 1. Smart Contract

File:
- [contracts/Voting.sol](/Decentralized-Voting-System/contracts/Voting.sol)

What it does:
- stores candidates on-chain
- stores vote counts on-chain
- stores election start/end timestamps on-chain
- stores QR-token vote usage on-chain
- emits events used for verification and public inspection

Key responsibilities:
- `addCandidate(...)`
- `vote(...)`
- `voteByQr(...)`
- `getCountCandidates()`
- `getCandidate(...)`
- `setDates(...)`
- `getDates()`
- `checkVoteByQr(...)`

Advantage:
- final vote count comes from chain data, not MongoDB
- QR token reuse is blocked at contract level
- on-chain events can be publicly verified

### 2. Remix IDE

Remix is used to:

- compile `Voting.sol`
- deploy the contract
- inspect transactions
- read constructor and event logs
- verify deployed bytecode on explorers

Important:
- Remix is a deployment tool here
- Remix is not the production application server
- after deployment, the deployed contract address must be copied into `VOTING_CONTRACT_ADDRESS`

### 3. MetaMask

MetaMask is used by the browser app to:

- connect the voter/admin wallet
- switch to the correct chain
- sign voting and candidate-management transactions
- submit contract calls to the deployed network

Advantage:
- votes are authorized by a real wallet transaction
- browser never needs to directly hold a private key in app code

### 4. Node / Express Layer

File:
- [index.js](/Decentralized-Voting-System/index.js)

What it does:
- serves frontend pages
- serves CSS, JS, bundle, and assets
- handles login
- protects admin pages with JWT validation
- exposes frontend runtime config
- acts as the entry point for the web UI

Why it exists:
- keeps frontend deployment simple
- centralizes routing
- keeps admin authorization logic out of static HTML

### 5. FastAPI + MongoDB Layer

File:
- [Database_API/main.py](/Decentralized-Voting-System/Database_API/main.py)

What it does:
- connects to MongoDB
- initializes collections and indexes
- registers voters
- checks duplicate identities
- performs QR lookup
- verifies live face against stored face image
- stores audit records and media
- returns blockchain-based live reports
- supports anomaly, sentiment, and prediction reports

Why it exists:
- keeps business logic separate from UI hosting
- keeps MongoDB access in one backend service
- makes Render deployment practical

### 6. MongoDB Atlas

MongoDB stores:

- voter records
- admin credentials/bootstrap info
- candidate records
- nomination forms
- election state metadata
- vote audit records
- image paths and image blobs
- report support data

What MongoDB does not define:
- official vote totals

That distinction is important.

### 7. Render Deployment

Render hosts the cloud services:

- Node/Express frontend service
- FastAPI backend service

Current Render blueprint file:
- [render.yaml](/Decentralized-Voting-System/render.yaml)

It now defines both the Node service and the Python service. The FastAPI service starts with:

```yaml
startCommand: uvicorn main:app --host 0.0.0.0 --port $PORT
```

Render should be the source of truth for production secrets and URLs.

- Use the Render dashboard or Blueprint environment variables for production values.
- Keep local `.env` files only for local development.
- The Node service can now read Render's internal backend `host:port` through `DATABASE_API_INTERNAL_HOSTPORT`, so you do not need to commit a production backend URL into the repo.

## How This Project Differs From a Typical Existing Setup

### Compared to a traditional centralized voting app

Traditional app:
- stores votes in one database
- admins ultimately control the result database
- verification is internal

This project:
- stores official vote state on blockchain
- uses MongoDB only for operational support data
- allows public transaction/result inspection

Advantage:
- higher transparency and stronger tamper resistance for final results

### Compared to a pure Remix smart-contract demo

Pure Remix demo:
- deploys contract
- maybe reads/writes contract directly
- usually lacks real user management, audit storage, QR workflow, reporting, and cloud deployment

This project:
- keeps Remix only for deployment/debugging
- adds real web pages
- adds voter identity flow
- adds QR and face verification
- adds cloud deployment through Render
- adds MongoDB-backed operational workflows

Advantage:
- moves from proof-of-concept contract demo to full-stack voting workflow

### Compared to a pure Mongo/Express app

Pure Mongo/Express app:
- easier CRUD
- weaker public verifiability
- database becomes the only trust anchor

This project:
- uses MongoDB for everything non-public and non-transactional
- uses blockchain where public trust matters most

Advantage:
- better balance between usability and trust

## System Flow

### Admin flow

1. Deploy [Voting.sol](/Decentralized-Voting-System/contracts/Voting.sol) from Remix.
2. Copy the deployed contract address into `VOTING_CONTRACT_ADDRESS`.
3. Configure `RPC_URL`, `CHAIN_ID`, MongoDB URI, and backend/frontend base URLs.
4. Start FastAPI.
5. Start Express.
6. Login as admin.
7. Register voters and generate voter cards with QR tokens.
8. Add candidates.
9. Set election dates.
10. Monitor live report, anomaly report, prediction report, and sentiment report.

### Voter flow

1. Open vote page.
2. Scan the QR token from the voter ID card using the camera.
3. Fetch the voter record from MongoDB through FastAPI.
4. Auto-capture a live image after a short delay of a few seconds.
5. Compare the live image with the registered voter-card photo in the backend.
6. Only after successful face verification, allow the `OK (Ready)` step and unlock candidate selection.
7. Select candidate.
8. Confirm vote through MetaMask.
9. Wait for blockchain confirmation.
10. Save audit record linked to the transaction hash.

### Public verification flow

1. Open verify page or explorer page.
2. Enter or open a transaction hash.
3. Read transaction/receipt details from blockchain.
4. Display proof details to the user.

## Pages and Their Advantages

## [src/html/login.html](/Decentralized-Voting-System/src/html/login.html)

Purpose:
- entry point for both admin and voter users

What happens here:
- admin or voter enters credentials
- frontend calls login endpoint
- JWT token is stored in local storage
- user is redirected by role

Advantage:
- one controlled entry point
- simpler role-based routing

## [src/html/admin.html](/Decentralized-Voting-System/src/html/admin.html)

Purpose:
- main operations dashboard for election management

What happens here:
- admin registers voter
- captures/uploads voter photo
- generates voter ID card
- prepares a voter-card photo with a cleaner white-background portrait-style output
- saves/downloads QR code
- loads blockchain live report
- loads ML reports
- starts/stops/restarts election
- manages candidate nomination through iframe flow

Advantage:
- all admin functions in one place
- practical for election-day operations
- duplicate-save protection helps prevent accidental repeated voter-card generation from repeated clicks

## [src/html/candidate_nomination.html](/Decentralized-Voting-System/src/html/candidate_nomination.html)

Purpose:
- isolated candidate nomination workflow

What happens here:
- nomination validation
- duplicate checks
- independent/party candidate handling
- candidate metadata preparation before on-chain add

Advantage:
- keeps candidate management separate from the larger admin page
- easier validation and maintenance

## [src/html/vote.html](/Decentralized-Voting-System/src/html/vote.html)

Purpose:
- voter verification and EVM-style vote selection page

What happens here:
- QR scan starts
- QR token is read
- voter record is fetched
- live image is auto-captured after QR verification
- face verification is performed against the registered voter-card photo
- `OK (Ready)` becomes part of the gated flow only after identity verification succeeds
- EVM-style candidate selection becomes available
- final vote confirmation window begins

Advantage:
- combines identity verification and vote interaction in one controlled flow
- removes the insecure manual QR-token entry path so random pasted tokens cannot be used for voting

## [src/html/loading.html](/Decentralized-Voting-System/src/html/loading.html)

Purpose:
- post-vote confirmation and audit sync page

What happens here:
- waits for blockchain transaction confirmation
- tracks receipt status
- saves audit data when confirmed
- if backend RPC verification is temporarily unavailable, it keeps the audit for retry and can still store the audit row with pending blockchain verification instead of silently losing the data
- optionally stores feedback
- clears stale session state for next voter

Advantage:
- avoids silent failures after wallet confirmation
- improves reliability between chain confirmation and database audit

## [src/html/verify_vote.html](/Decentralized-Voting-System/src/html/verify_vote.html)

Purpose:
- public/self-service transaction verification page

What happens here:
- user enters transaction hash
- app queries blockchain
- receipt and transaction details are shown

Advantage:
- improves transparency
- lets users independently validate a vote transaction

## [src/html/explorer.html](/Decentralized-Voting-System/src/html/explorer.html)

Purpose:
- public explorer for results and recent vote activity

What happens here:
- reads candidate totals
- displays vote events / recent transactions
- links to vote verification

Advantage:
- gives blockchain-style public visibility without admin controls

## Frontend JavaScript Modules

## [src/js/app.js](/Decentralized-Voting-System/src/js/app.js)

Role:
- blockchain integration layer for the browser

Responsibilities:
- connect to MetaMask or RPC
- read ABI and contract address
- load candidate data from contract
- create candidates on-chain
- set election dates on-chain
- send vote transactions
- check QR vote status on-chain
- verify transaction receipts

Advantage:
- one reusable blockchain module used across pages

## [src/js/admin.js](/Decentralized-Voting-System/src/js/admin.js)

Role:
- admin dashboard behavior

Responsibilities:
- voter registration
- image upload/capture
- card photo preparation
- white-background portrait-style card image generation
- QR generation/download
- card PDF generation
- election control
- live report loading
- ML report loading
- candidate iframe communication
- duplicate-click protection during voter save

Advantage:
- avoids large inline script blocks in HTML

## [src/js/voter.js](/Decentralized-Voting-System/src/js/voter.js)

Role:
- QR scan and voter confirmation flow

Responsibilities:
- QR scanner setup
- camera preview
- QR-only verification flow
- delayed auto capture of live image after scan
- auto/manual verification
- scan confirmation
- state reset between voters

Advantage:
- protects voting page from stale identity reuse
- no longer relies on manual QR token entry for actual verification

## [src/js/vote.js](/Decentralized-Voting-System/src/js/vote.js)

Role:
- final vote confirmation logic

Responsibilities:
- final gated vote flow after QR-based identity verification
- candidate selection
- confirmation timer
- MetaMask vote transaction
- audit payload creation

Advantage:
- separates verification from final vote submission logic
- keeps the post-verification vote flow intact after the backend confirms that the live voter matches the voter-card photo

## [src/js/loading.js](/Decentralized-Voting-System/src/js/loading.js)

Role:
- blockchain confirmation watcher and backend sync helper

Responsibilities:
- poll transaction receipt
- mark transaction states
- sync pending audit
- store optional feedback
- cleanup local state

Advantage:
- prevents partial vote completion flows

## [src/js/verify_vote.js](/Decentralized-Voting-System/src/js/verify_vote.js)

Role:
- transaction verification UI logic

Advantage:
- dedicated, simple, user-facing proof screen

## [src/js/explorer.js](/Decentralized-Voting-System/src/js/explorer.js)

Role:
- public result/explorer logic

Advantage:
- separates public visibility concerns from admin controls

## [src/js/login-page.js](/Decentralized-Voting-System/src/js/login-page.js)

Role:
- role-aware login logic

Advantage:
- keeps authentication behavior simple and isolated

## [src/js/config.js](/Decentralized-Voting-System/src/js/config.js)

Role:
- frontend config resolver

Advantage:
- central place for frontend base URLs

## [src/js/runtime-config.js](/Decentralized-Voting-System/src/js/runtime-config.js)

Role:
- generated browser runtime configuration

Stores:
- API base
- RPC URL
- chain ID
- contract address

Advantage:
- same frontend code can be deployed to different environments

## [src/js/utils.js](/Decentralized-Voting-System/src/js/utils.js)

Role:
- shared DOM/network/helper utilities

Advantage:
- reduces repetitive browser boilerplate

## Backend Modules

## [Database_API/main.py](/Decentralized-Voting-System/Database_API/main.py)

Main backend responsibilities:

- bootstraps MongoDB
- creates indexes
- loads admin bootstrap data
- handles election state
- handles voter registration
- QR lookup
- face verification
- candidate endpoints
- candidate fallback from on-chain data when MongoDB candidate rows are unavailable
- nomination endpoints
- blockchain report endpoints
- audit export endpoints
- database clear endpoint

## [Database_API/duplicate_detection.py](/Decentralized-Voting-System/Database_API/duplicate_detection.py)

Role:
- duplicate face and near-match detection

Why it matters:
- prevents same person from registering multiple times under different names
- reduces accidental duplicate voter-card generation even when the same user changes pose slightly during registration

## [Database_API/sentiment.py](/Decentralized-Voting-System/Database_API/sentiment.py)

Role:
- feedback sentiment analysis

Advantage:
- turns voter feedback into candidate-level summary data

## [Database_API/vote_prediction.py](/Decentralized-Voting-System/Database_API/vote_prediction.py)

Role:
- simple vote trend forecasting

Advantage:
- helps admins interpret incomplete elections

## [Database_API/anomaly_detection.py](/Decentralized-Voting-System/Database_API/anomaly_detection.py)

Role:
- suspicious vote-rate pattern detection

Advantage:
- adds a lightweight monitoring layer without changing vote mechanics

## Important Routes

### Express routes

Defined in:
- [index.js](/Decentralized-Voting-System/index.js)

Important page routes:

- `/`
- `/login.html`
- `/admin.html`
- `/candidate-nomination.html`
- `/vote.html`
- `/verify-vote.html`
- `/explorer.html`
- `/loading.html`

### FastAPI routes

Defined in:
- [Database_API/main.py](/Decentralized-Voting-System/Database_API/main.py)

Important API routes:

- `/voter/by-qr`
- `/voter/confirm-scan`
- `/voter/ready-check`
- `/candidates`
- `/admin/candidates`
- `/admin/candidate-nominations`
- `/election/dates`
- `/admin/election/stop`
- `/admin/election/restart`
- `/vote/audit`
- `/vote/report`
- `/vote/prediction`
- `/vote/sentiment-report`
- `/admin/anomaly-report`
- `/admin/vote-audit/export`
- `/admin/database/clear`

## Environment Variables and Configuration

This project uses variables in Express, FastAPI, and the frontend runtime generator.

## Database and authentication variables

- `MONGODB_URI`
  Purpose: primary MongoDB connection string
  Used by: Express and FastAPI

- `MONGO_URI`
  Purpose: fallback MongoDB connection string
  Used by: Express and FastAPI

- `MONGO_DB_NAME`
  Purpose: explicit MongoDB database name
  Used by: FastAPI

- `MONGODB_DB`
  Purpose: alternate MongoDB database name key
  Used by: FastAPI

- `MONGO_DATABASE`
  Purpose: alternate MongoDB database name key
  Used by: FastAPI

- `DB_NAME`
  Purpose: alternate MongoDB database name key
  Used by: FastAPI

- `JWT_SECRET`
  Purpose: JWT signing secret in Express

- `SECRET_KEY`
  Purpose: fallback JWT/admin secret key
  Used by: Express and FastAPI admin checks

- `ADMIN_USERNAME`
  Purpose: bootstrap admin username

- `ADMIN_PASSWORD`
  Purpose: bootstrap admin password

- `ADMIN_FULL_NAME`
  Purpose: bootstrap admin display name

- `ADMIN_ROLE`
  Purpose: bootstrap admin role in Express

- `ADMIN_COLLECTION`
  Purpose: collection name override for admin storage in Express

## Blockchain and runtime variables

- `CHAIN_ID`
  Purpose: expected blockchain network ID for frontend wallet logic

- `RPC_URL`
  Purpose: primary blockchain RPC endpoint
  Used by: Express runtime config, FastAPI blockchain reporting, frontend runtime generation

- `RPC_FALLBACK_URLS`
  Purpose: optional comma-separated fallback RPC URLs
  Used by: FastAPI

- `VOTING_CONTRACT_ADDRESS`
  Purpose: deployed contract address from Remix
  Used by: FastAPI and frontend blockchain logic

- `FRONTEND_API_BASE`
  Purpose: API base injected into browser runtime config
  Used by: generated frontend runtime config

- `DATABASE_API_BASE`
  Purpose: Express-side backend API base
  Used by: Node/Express

- `FASTAPI_BASE`
  Purpose: alternate backend API base variable
  Used by: Node/Express

- `API_BASE`
  Purpose: alternate backend API base variable
  Used by: Node/Express

## CORS and deployment variables

- `FRONTEND_URL`
  Purpose: known frontend origin for CORS

- `CORS_ALLOWED_ORIGINS`
  Purpose: extra comma-separated allowed origins

- `CORS_ALLOW_ORIGIN_REGEX`
  Purpose: regex-based CORS allowance

- `PORT`
  Purpose: Render-assigned service port
  Used by: Express and Render/FastAPI startup

## Verification and runtime behavior variables

- `LIVE_FACE_VERIFICATION_THRESHOLD`
  Purpose: threshold for live face match success

- `FACE_MATCH_THRESHOLD`
  Purpose: duplicate detection threshold in image matching

- `MONGO_SERVER_SELECTION_TIMEOUT_MS`
  Purpose: MongoDB connection timeout

- `REQUIRE_MONGO_ON_STARTUP`
  Purpose: whether Express should fail early when Mongo is unavailable

## Render Deployment Variables You Commonly Use

For the Node frontend service, the practical variables are usually:

- `CHAIN_ID`
- `RPC_URL`
- `VOTING_CONTRACT_ADDRESS`
- `DATABASE_API_BASE`
- `DATABASE_API_INTERNAL_HOSTPORT`
- `MONGODB_URI`
- `JWT_SECRET` or `SECRET_KEY`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

For the FastAPI backend service, the practical variables are usually:

- `MONGODB_URI`
- `SECRET_KEY`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_FULL_NAME`
- `CHAIN_ID`
- `RPC_URL`
- `RPC_FALLBACK_URLS`
- `VOTING_CONTRACT_ADDRESS`
- `FRONTEND_URL`
- `CORS_ALLOWED_ORIGINS`
- `LIVE_FACE_VERIFICATION_THRESHOLD`

If you deploy through Render Blueprints, keep secret values as `sync: false` entries in `render.yaml` and then fill the actual values in the Render dashboard for each service.

## If Someone Deploys This Project On Their Own System

If another developer, college team, or organization wants to deploy this project using their own credentials and infrastructure, they must replace the original project-specific values with their own values.

They should not reuse:

- your MongoDB connection string
- your admin username/password
- your JWT or secret keys
- your RPC/API keys
- your deployed contract address
- your Render service URLs

### Minimum things they must change

| Item | What they should replace | Why it must be changed |
|---|---|---|
| MongoDB connection | `MONGODB_URI` / `MONGO_URI` | So the app uses their own database, not yours |
| Admin login | `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_FULL_NAME` | So they control their own admin account |
| JWT secret | `JWT_SECRET` or `SECRET_KEY` | So tokens are signed with their own private secret |
| Smart contract address | `VOTING_CONTRACT_ADDRESS` | So the frontend/backend point to their own deployed contract |
| Blockchain RPC | `RPC_URL`, `RPC_FALLBACK_URLS` | So blockchain calls use their own provider or API key |
| Chain setting | `CHAIN_ID` | So MetaMask and contract logic match the intended network |
| Frontend/backend URLs | `DATABASE_API_BASE`, `FASTAPI_BASE`, `API_BASE`, `FRONTEND_API_BASE`, `FRONTEND_URL` | So services talk to the correct deployed URLs |
| CORS settings | `CORS_ALLOWED_ORIGINS`, `CORS_ALLOW_ORIGIN_REGEX` | So their browser origins are allowed |
| Mongo DB name | `MONGO_DB_NAME` / related DB name vars | If they want a custom database name |

### Recommended replacement checklist

1. Deploy a new instance of [contracts/Voting.sol](/Decentralized-Voting-System/contracts/Voting.sol) from Remix.
2. Copy the new deployed contract address into `VOTING_CONTRACT_ADDRESS`.
3. Create a new MongoDB Atlas database and use a new `MONGODB_URI`.
4. Create a new RPC/API key from a provider such as Alchemy.
5. Set a new `RPC_URL` for the selected network.
6. Set a strong new `JWT_SECRET` or `SECRET_KEY`.
7. Create a new admin account through `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `ADMIN_FULL_NAME`.
8. Update frontend/backend service URLs to their own Render or local URLs.
9. Redeploy both Node/Express and FastAPI services.
10. Test login, voter registration, candidate creation, QR verification, vote casting, and report loading.

### Example of what a new deployer should personalize

```env
MONGODB_URI=mongodb+srv://their-user:their-password@their-cluster.mongodb.net/theirVotingDb
JWT_SECRET=their-very-strong-secret
SECRET_KEY=their-very-strong-secret
ADMIN_USERNAME=theiradmin
ADMIN_PASSWORD=theirpassword
ADMIN_FULL_NAME=Their System Admin
CHAIN_ID=11155111
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/THEIR_API_KEY
VOTING_CONTRACT_ADDRESS=0xTHEIR_DEPLOYED_CONTRACT_ADDRESS
DATABASE_API_BASE=https://their-backend-service.onrender.com
FRONTEND_URL=https://their-frontend-service.onrender.com
```

### Local/self-hosted deployment note

If someone runs the project on their own machine instead of Render, they should especially verify:

- local MongoDB or MongoDB Atlas connectivity
- correct local/backend port numbers
- correct `API_BASE` / `DATABASE_API_BASE`
- correct MetaMask network
- correct contract address after local or testnet deployment

Without these changes, the project may appear to run but will still point to someone else's services or fail to verify/vote correctly.

## Deployment Architecture With Remix, Render, MongoDB, and Blockchain

### Remix

Used for:
- contract compilation
- deployment
- transaction inspection
- event inspection

Not used for:
- hosting the production frontend
- storing user data
- handling admin login

### Render

Used for:
- deploying Express
- deploying FastAPI
- exposing HTTP endpoints publicly
- hosting the production app flow

### MongoDB Atlas

Used for:
- persistent voter and admin data
- operational election data
- reports and image records

### Blockchain

Used for:
- official vote state
- QR reuse prevention
- public proof of vote transactions

## Feature Comparison

The table below compares this project with common existing approaches. It is meant to show where this project is stronger, not to claim that every other project is bad.

| Feature | Typical Centralized Voting App | Pure Remix Contract Demo | Basic Mongo + Express App | This Project |
|---|---|---|---|---|
| Official vote source | Database | Smart contract only | Database | Blockchain |
| Real web UI pages | Usually yes | Usually very limited | Yes | Yes |
| Smart contract integration | Usually no | Yes | Usually no | Yes |
| MetaMask transaction flow | No | Yes | No | Yes |
| MongoDB operational storage | Sometimes | Usually no | Yes | Yes |
| QR-based voter verification | Rare | Usually no | Sometimes | Yes |
| Face verification | Rare | No | Rare | Yes |
| Candidate nomination workflow | Sometimes | No | Sometimes | Yes |
| Admin dashboard | Yes | Usually no | Yes | Yes |
| Public transaction verification page | Rare | Limited/manual | Rare | Yes |
| Public explorer/results page | Rare | Limited/manual | Rare | Yes |
| Cloud deployment readiness | Sometimes | No | Sometimes | Yes |
| Audit image storage | Rare | No | Sometimes | Yes |
| CSV export/report support | Sometimes | No | Sometimes | Yes |
| Prediction/anomaly/sentiment reports | Rare | No | Rare | Yes |
| Separation of official vs operational data | Weak | Often incomplete | Weak | Strong |

## Why This Project Stands Out

Compared to many existing academic or demo projects, this system is stronger because it combines:

- blockchain-backed vote integrity
- practical MongoDB-backed election operations
- real wallet-based voting with MetaMask
- cloud deployment through Render
- QR + face-based voter confirmation
- public verification and explorer pages
- admin reporting and ML-style analytics

In simple terms:

- centralized projects are easier to build but weaker in trust
- pure Remix demos prove the contract but are weak as full products
- basic CRUD voting apps manage data well but lack public verifiability
- this project tries to combine the strengths of all of them into one system

That is the main reason this project can be presented as more complete and more practical than many existing student-level voting projects.

## What Is Official vs What Is Operational

### Official data

Official election result should be treated as:

- on-chain candidate totals
- on-chain transaction receipts
- contract event history

### Operational data

Operational support data includes:

- voter details
- voter photos
- QR-linked identity records
- candidate metadata
- nomination forms
- audit images
- feedback and ML summaries

This distinction is the most important architectural concept in the project.

## Advantages of the Overall System

- stronger transparency than a plain database voting app
- more practical than a blockchain-only storage design
- easier smart contract iteration through Remix
- easier hosting through Render
- practical cloud persistence through MongoDB Atlas
- browser-native transaction approval through MetaMask
- extra verification through QR and face matching
- added analytics through anomaly, prediction, and sentiment modules

## Limitations and Tradeoffs

- face verification accuracy depends on image quality and thresholds
- MongoDB still remains a sensitive operational dependency
- blockchain RPC availability affects explorer/report features
- MetaMask UX adds friction compared to ordinary form submission
- contract deployment changes require address/config updates in the app

## Suggested Local Run Commands

### Install Node dependencies

```powershell
npm install
```

### Install Python dependencies

```powershell
Database_API\.venv\Scripts\python.exe -m pip install -r Database_API\requirements.txt
```

### Build frontend runtime assets

```powershell
npm run build
```

### Start Express

```powershell
npm start
```

### Start FastAPI directly

```powershell
uvicorn Database_API.main:app --host 0.0.0.0 --port 8000
```

### Render-style FastAPI start

```powershell
uvicorn main:app --host 0.0.0.0 --port $PORT
```

## Security Notes

- keep MongoDB credentials private
- keep JWT/admin secrets strong
- never hardcode real private wallet keys in code
- rotate RPC/API keys if they are leaked
- treat blockchain receipt verification as the final public proof
- use dedicated RPC endpoints for production hosting instead of unstable public rate-limited endpoints

## Summary

This project is a full-stack decentralized voting workflow, not just a contract demo.

Its real architectural identity is:

- Remix for contract deployment
- MetaMask for transaction signing
- Express for UI hosting and routing
- FastAPI for verification and business logic
- MongoDB for operational election data
- blockchain for official vote integrity

That layered split is what makes it different from a standard web app, a pure Remix demo, or a pure database voting system.
