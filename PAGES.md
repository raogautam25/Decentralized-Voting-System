# Decentralized Voting System Documentation

This document focuses on page responsibilities, module behavior, backend roles, and literature-ready system explanation.
For setup, run commands, and deployment notes, see `README.md`.

## 1. Project Overview

This project is a decentralized voting application that combines:

- A browser-based frontend for voter and administrator operations
- A Node.js Express server for page delivery, login routing, and API proxying
- A FastAPI backend for voter records, QR verification, face matching, audit storage, and election control
- A MongoDB database for persistent application data
- An Ethereum smart contract for on-chain voting and transparent vote counting

The main objective of the system is to provide:

- Secure voter registration
- Duplicate voter prevention using face-based matching
- QR-based voter verification
- Live face verification during vote authorization
- On-chain vote casting and public verification
- Administrative control of election dates, candidates, and reports

## 2. System Architecture

| Layer | Main Files | Responsibility |
| --- | --- | --- |
| Presentation Layer | `src/html/*`, `src/css/*`, `src/js/*` | User interface for login, admin tasks, voting, verification, and explorer pages |
| Frontend Runtime | `src/js/app.js`, `src/js/config.js`, `src/js/utils.js` | Web3 integration, shared API configuration, shared browser helpers |
| Web Server | `index.js` | Serves HTML/CSS/JS, protects admin routes, proxies selected requests to FastAPI |
| Backend API | `Database_API/main.py` | Voter registration, QR verification, face matching, candidate and election management, vote audit |
| Face Matching Module | `Database_API/duplicate_detection.py` | Face detection, image signature generation, duplicate-face matching, live face verification |
| Blockchain Layer | `contracts/Voting.sol` | Candidate storage, election dates, QR-based one-vote enforcement, vote event emission |
| Automation Scripts | `scripts/*` | Runtime config generation and blockchain-to-database synchronization |

## 3. Frontend Pages

### 3.1 Login Page

| Item | Details |
| --- | --- |
| Page | `src/html/login.html` |
| Style | `src/css/login.css` |
| Script | `src/js/login.js` |
| Route | `/` and `/login.html` |
| Purpose | Authenticates admins and voters and redirects them to the correct interface |

What it does:

- Accepts username or voter ID and password
- Sends login request to the backend
- Stores `jwtTokenAdmin` or `jwtTokenVoter` in `localStorage`
- Redirects admin users to `admin.html`
- Redirects voter users to `vote.html`

Importance in documentation:

- This is the system entry point
- It begins session creation and role-based access control
- It separates administrative and voting operations

### 3.2 Admin Dashboard

| Item | Details |
| --- | --- |
| Page | `src/html/admin.html` |
| Style | `src/css/admin.css` |
| Script | `src/js/admin.js` plus `src/dist/app.bundle.js` |
| Route | `/admin.html` |
| Access | Protected by JWT token through Express middleware |

What it does:

- Registers voters and generates voter ID cards
- Captures or uploads voter photo
- Checks face duplicates against existing voter images
- Displays generated voter ID and QR code
- Hosts the nomination form inside an iframe
- Stops or restarts an election
- Shows current election status
- Downloads CSV vote-audit reports
- Clears database content when required
- Displays live vote report

Importance in documentation:

- This is the administrative control center
- It manages voter lifecycle, candidate lifecycle, and election lifecycle
- It demonstrates how database records and blockchain operations are coordinated

### 3.3 Candidate Nomination Page

| Item | Details |
| --- | --- |
| Page | `src/html/candidate_nomination.html` |
| Style | `src/css/candidate_nomination.css` |
| Script | `src/js/candidate_nomination.js` |
| Route | `/candidate-nomination.html` |
| Usage | Loaded inside the admin page iframe |

What it does:

- Collects candidate nomination details
- Validates age, ID number, contact number, party information, and election identity
- Prevents duplicate candidate nominations using backend checks
- Sends candidate creation request to blockchain via parent admin page messaging
- Saves nomination metadata and party symbol image in the backend database

Importance in documentation:

- This page shows how the project integrates blockchain submission with off-chain record storage
- It documents duplicate prevention for candidates as well as voters

### 3.4 Vote Page

| Item | Details |
| --- | --- |
| Page | `src/html/vote.html` |
| Style | `src/css/vote.css` |
| Script | `src/js/vote.js`, `src/js/voter.js`, `src/dist/app.bundle.js` |
| Route | `/vote.html` |
| Role | Main voting interface |

What it does:

- Shows election status banner
- Starts QR scan for voter identification
- Fetches voter details using QR token
- Captures live on-vote-day image
- Confirms the voter using backend verification
- Performs an additional ready-check face match before enabling candidate selection
- Displays candidates in EVM-style layout
- Locks voting until QR and face verification succeed
- Applies one-voter-one-vote logic using QR token and smart contract checks
- Opens a 15-second vote confirmation window
- Sends vote transaction to the blockchain

Importance in documentation:

- This is the core operational page of the system
- It combines biometric verification, QR verification, election-time control, and blockchain vote submission
- It shows how booth-style voting can be implemented on a web interface

### 3.5 Loading Page

| Item | Details |
| --- | --- |
| Page | `src/html/loading.html` |
| Style | `src/css/loading.css` |
| Script | `src/js/loading.js` |
| Route | `/loading.html` |

What it does:

- Monitors blockchain transaction status after vote submission
- Displays transaction hash, confirmation count, and progress bar
- Persists last transaction summary for later verification
- Attempts to synchronize pending vote audit data to the backend
- Logs out the voter automatically after successful completion
- Resets booth state for the next voter

Importance in documentation:

- This page acts as the bridge between vote submission and final confirmation
- It enforces session reset and booth continuity

### 3.6 Verify Vote Page

| Item | Details |
| --- | --- |
| Page | `src/html/verify_vote.html` |
| Style | `src/css/public_verifier.css` |
| Script | `src/js/verify_vote.js` |
| Route | `/verify-vote.html` |

What it does:

- Accepts transaction hash input
- Reads transaction and receipt from blockchain
- Decodes vote events
- Displays vote status, candidate, party, block number, timestamp, gas, and wallet address
- Supports quick verification using the last locally stored transaction

Importance in documentation:

- This page provides public auditability
- It demonstrates vote transparency without revealing voter intent beyond on-chain event data

### 3.7 Explorer Page

| Item | Details |
| --- | --- |
| Page | `src/html/explorer.html` |
| Style | `src/css/public_verifier.css` |
| Script | `src/js/explorer.js` |
| Route | `/explorer.html` |

What it does:

- Displays public candidate results from the blockchain
- Lists historical vote events
- Links each vote transaction to the verify-vote page
- Refreshes data on demand

Importance in documentation:

- This page is the transparency interface of the system
- It supports public confidence by exposing vote-related blockchain data

### 3.8 Legacy or Compatibility Pages

| Page | Role |
| --- | --- |
| `src/html/index.html` | Legacy protected page maintained for compatibility |
| `src/html/voter.html` | Legacy route; current Express setup redirects voters to `vote.html` |

These files are useful to mention in documentation because they show system evolution from a multi-page voter flow to a single-screen vote flow.

## 4. Frontend JavaScript Modules

### 4.1 `src/js/login.js`

- Handles login form submission
- Communicates with backend login API
- Stores role-based token in `localStorage`
- Redirects according to user role

### 4.2 `src/js/admin.js`

- Controls voter registration UI
- Captures webcam image or file upload for voter photo
- Calls `/admin/voters` API
- Renders printable voter ID card and QR code
- Manages election stop and restart
- Downloads audit reports and clears database
- Embeds and coordinates candidate nomination flow

### 4.3 `src/js/candidate_nomination.js`

- Performs client-side validation
- Detects form duplicates before submission
- Sends precheck request to backend
- Coordinates with parent page for blockchain candidate creation
- Saves candidate and nomination data in backend database

### 4.4 `src/js/voter.js`

- Handles QR scanning and fallback manual QR input
- Fetches voter details by QR token
- Captures on-vote-day live image
- Calls `/voter/confirm-scan`
- Saves verified voter session in `localStorage`

### 4.5 `src/js/vote.js`

- Controls EVM voting interface
- Requires voter verification before enabling vote
- Captures additional live face image for ready-check
- Calls `/voter/ready-check`
- Opens 15-second confirmation window
- Builds vote audit payload
- Submits blockchain vote using `window.App.voteByCandidateId`

### 4.6 `src/js/loading.js`

- Monitors transaction receipt and confirmation status
- Writes summary data to local storage
- Synchronizes pending audit payload to backend
- Clears voter session after successful vote

### 4.7 `src/js/verify_vote.js`

- Reads and verifies on-chain transaction information
- Displays detailed vote verification result

### 4.8 `src/js/explorer.js`

- Fetches public vote events from blockchain
- Fetches candidate results from blockchain
- Renders public transparency tables

### 4.9 `src/js/app.js`

- Initializes Web3 and MetaMask connection
- Loads the deployed smart contract
- Switches to configured chain if necessary
- Reads candidates and election dates
- Verifies vote transactions
- Fetches public events
- Sends vote, candidate, and date transactions to the smart contract

This is the main blockchain interaction layer of the frontend.

### 4.10 Shared Support Modules

| File | Purpose |
| --- | --- |
| `src/js/config.js` | Exposes runtime API and frontend base URLs |
| `src/js/utils.js` | Common helpers such as `fetchJson`, `safeJsonParse`, DOM lookup, and status display |
| `src/js/runtime-config.js` | Injected runtime configuration for API base, RPC URL, chain ID, and contract address |

## 5. Backend and Server Files

### 5.1 `index.js`

Purpose:

- Serves all frontend assets
- Provides login route
- Protects admin-only pages
- Proxies selected routes to FastAPI backend
- Connects to MongoDB for admin login seeding and validation

Important routes:

- `/`
- `/login`
- `/admin.html`
- `/vote.html`
- `/verify-vote.html`
- `/explorer.html`
- Proxy routes such as `/admin/voters`, `/voter/by-qr`, `/voter/confirm-scan`, `/vote/audit`

### 5.2 `Database_API/main.py`

Purpose:

- Main FastAPI backend for persistent application logic

Key responsibilities:

- Voter registration
- Duplicate voter detection
- Face-based live verification
- Candidate and nomination record handling
- Election date and election state management
- Vote audit storage
- CSV export
- Media storage for voter images and scanned images

Important API groups:

- `/login`
- `/admin/voters`
- `/admin/candidate-nominations/*`
- `/admin/election/*`
- `/voter/by-qr`
- `/voter/confirm-scan`
- `/voter/ready-check`
- `/vote/audit`
- `/vote/report`

### 5.3 `Database_API/duplicate_detection.py`

Purpose:

- Implements the face-matching logic used by registration and voting verification

What it does:

- Detects face regions using OpenCV Haar cascades
- Normalizes image patches
- Builds image signatures using:
  - Average hash
  - Histogram features
  - Local Binary Pattern histogram
  - HOG descriptor
- Computes similarity score
- Detects whether an uploaded voter image matches an already registered voter
- Validates live image against stored voter ID-card image

Importance in documentation:

- This file is central to the authenticity claim of the system
- It is the main anti-duplication and anti-impersonation component

### 5.4 `contracts/Voting.sol`

Purpose:

- Implements the smart contract that records votes on-chain

Main functions:

- `addCandidate`
- `vote`
- `voteByQr`
- `checkVote`
- `checkVoteByQr`
- `setDates`
- `getDates`
- `getCandidate`
- `getCountCandidates`

Main events:

- `CandidateAdded`
- `Voted`
- `VotedByQr`
- `VoteCast`
- `DatesSet`

Importance in documentation:

- This file provides decentralization, public transparency, and immutable vote records

## 6. Data Flow

### 6.1 Voter Registration Flow

1. Admin opens `admin.html`
2. Admin enters voter details and uploads or captures photo
3. Frontend sends voter data to `/admin/voters`
4. Backend checks age and photo validity
5. Backend compares the new face image with stored voter photos
6. If no duplicate is found, voter ID and QR token are generated
7. Voter record and image are stored in MongoDB and media storage
8. Frontend renders voter ID card with QR code

### 6.2 Voter Verification Flow

1. Voter opens `vote.html`
2. QR code is scanned or pasted manually
3. Frontend fetches voter profile using `/voter/by-qr`
4. Frontend captures live image
5. Frontend calls `/voter/confirm-scan`
6. Backend compares live image with registered voter image
7. If matched, verified voter data is stored in browser `localStorage`

### 6.3 Ready-to-Vote Face Check

1. Voter presses `OK (Ready)`
2. Frontend captures another live image
3. Frontend calls `/voter/ready-check`
4. Backend compares this image with the registered voter image
5. Candidate buttons are enabled only if similarity is above threshold

### 6.4 Vote Casting Flow

1. Voter selects candidate
2. Frontend captures pre-vote image
3. Voter confirms within 15 seconds
4. Frontend calls smart contract vote function through Web3
5. Transaction hash is stored locally
6. User is redirected to `loading.html`
7. Loading page tracks confirmation
8. Vote audit is stored in backend
9. Voter session is cleared for the next voter

## 7. Database and Stored Records

Main collections in MongoDB:

| Collection | Purpose |
| --- | --- |
| `voters` | Voter identity, voter ID, DOB, QR token, photo path, role |
| `candidates` | Candidate list used by the vote page |
| `candidate_nominations` | Detailed candidate nomination records |
| `election_config` | Election status, start date, end date, reconduct count |
| `vote_audit` | Audit trail of votes and captured images |
| `vote_report_live` | Live vote summary for admin dashboard |
| `counters` | Sequence counters for audit and nomination IDs |

Media storage:

- Registered voter images
- Vote-day scan images
- Pre-vote images
- Party symbol images

## 8. Smart Contract Logic

The smart contract enforces:

- Only valid candidate IDs can be voted for
- Voting can happen only between configured start and end times
- A QR token cannot be used more than once
- Each successful vote emits public events

The contract does not store face data or private voter profile data. That responsibility remains in the backend.

## 9. Authentication and Security Features

Main protection mechanisms:

- JWT-based admin page protection
- Role-based login redirection
- QR token verification before vote activation
- Duplicate voter blocking using face similarity
- Live face verification during voting
- QR-based one-time vote enforcement on-chain
- Election stop and restart controls
- Vote audit logging for administrative review

## 10. Local Storage Usage

Important browser keys:

| Key | Purpose |
| --- | --- |
| `jwtTokenAdmin` | Admin session token |
| `jwtTokenVoter` | Voter session token |
| `verifiedVoter` | Verified QR and face-checked voter session |
| `selectedCandidate` | Selected candidate for voting |
| `currentTxHash` | Current vote transaction hash |
| `txStatus` | Vote transaction status |
| `txConfirmations` | Confirmation counter |
| `blockNumber` | Mined block number |
| `voteSubmittedTime` | Vote submission timestamp |
| `pendingVoteAudit` | Vote audit payload to sync after transaction |
| `lastTxSummary` | Recent vote summary for verification page |
| `lastVoteCompleted` | Booth reset marker for next voter |

## 11. Important Environment Variables

| Variable | Purpose |
| --- | --- |
| `SECRET_KEY` | JWT signing secret |
| `MONGODB_URI` or `MONGO_URI` | MongoDB connection string |
| `ADMIN_USERNAME` | Default admin username |
| `ADMIN_PASSWORD` | Default admin password |
| `CHAIN_ID` | Target blockchain network ID |
| `RPC_URL` | Blockchain RPC URL |
| `VOTING_CONTRACT_ADDRESS` | Deployed contract address |
| `LIVE_FACE_VERIFICATION_THRESHOLD` | Threshold for live face verification strictness |
| `DATABASE_API_BASE` or related API base vars | FastAPI backend base URL |

## 12. Supporting Files

| File | Purpose |
| --- | --- |
| `scripts/sync_chain_to_db.js` | Syncs on-chain candidates into backend database |
| `scripts/generate_runtime_config.js` | Generates runtime configuration for frontend |
| `migrations/*` | Truffle deployment scripts |
| `build/contracts/Voting.json` | Compiled smart contract artifact |
| `package.json` | Node dependencies and scripts |
| `Database_API/requirements.txt` | Python dependencies |

## 13. Suggested Literature Sections

For a report, thesis, or project documentation, this project can be described under these headings:

- Introduction to decentralized voting
- Problem statement: duplicate identity and booth authenticity
- Proposed solution architecture
- Frontend page design
- Backend API design
- Smart contract design
- Face verification and duplicate detection model
- QR-based voter validation
- Audit and transparency mechanisms
- Security considerations
- Limitations and future work

## 14. Current System Highlights

The present implementation supports:

- Voter registration with duplicate face detection
- QR-based voter verification
- Live face match before vote authorization
- Strict face similarity threshold for authenticity
- One-time QR voting on blockchain
- Vote audit export and live admin reporting
- Public verification and explorer pages

This makes the system suitable for academic demonstration of a secure, semi-biometric, blockchain-assisted voting workflow.
