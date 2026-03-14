# Decentralized Voting System

A decentralized voting platform that combines:

- A browser-based voting and admin interface
- A Node.js Express server for page delivery and API proxying
- A FastAPI backend for voter management, QR verification, face matching, and audit storage
- A MongoDB database for persistent election data
- An Ethereum smart contract for on-chain vote recording and public verification

This project focuses on voter authenticity and election transparency by using:

- Duplicate voter prevention from stored face images during registration
- QR-based voter identification
- Live face verification against the registered voter image before vote enablement
- On-chain vote submission with public verification and explorer pages

## Core Features

- Admin login and voter login
- Voter registration with generated voter ID and QR code
- Face-based duplicate detection during voter registration
- Candidate nomination and candidate record management
- Election start, stop, restart, and date control
- QR scan based voter verification
- Live face match before vote authorization
- One QR token can vote only once
- Vote audit storage with captured images
- CSV vote audit export
- Public vote verification by transaction hash
- Public explorer for vote events and result transparency

## Current Architecture

| Layer | Main Technology | Main Files |
| --- | --- | --- |
| Frontend UI | HTML, CSS, JavaScript | `src/html/*`, `src/css/*`, `src/js/*` |
| Frontend blockchain layer | Web3, Truffle contract wrapper | `src/js/app.js`, `src/dist/app.bundle.js` |
| Web server | Node.js, Express | `index.js` |
| Backend API | FastAPI, PyMongo | `Database_API/main.py` |
| Face verification | OpenCV, NumPy | `Database_API/duplicate_detection.py` |
| Database | MongoDB | configured via `.env` |
| Smart contract | Solidity, Truffle | `contracts/Voting.sol` |

## Main Pages

| Page | Route | Purpose |
| --- | --- | --- |
| `login.html` | `/` | Login for admin and voter roles |
| `admin.html` | `/admin.html` | Admin dashboard for voters, candidates, dates, reports |
| `candidate_nomination.html` | `/candidate-nomination.html` | Candidate nomination form used inside admin dashboard |
| `vote.html` | `/vote.html` | Main voting screen with QR verification and EVM-style voting |
| `loading.html` | `/loading.html` | Transaction progress and booth reset screen |
| `verify_vote.html` | `/verify-vote.html` | Public verification page for vote transactions |
| `explorer.html` | `/explorer.html` | Public blockchain explorer and result view |

Detailed page-by-page documentation is available in [PAGES.md](./PAGES.md).

## Voting Flow

1. Admin registers a voter with name, date of birth, and face image.
2. The backend checks whether the uploaded face matches an already registered voter.
3. If registration succeeds, the system generates a voter ID and QR token.
4. On the voting page, the voter scans the QR code.
5. The system fetches the stored voter record and captures a live image.
6. The backend compares the live image with the registered voter photo.
7. After QR verification, the voter presses `OK (Ready)`.
8. A second live face match is performed for ready-to-vote authorization.
9. Candidate buttons unlock only after successful verification.
10. The voter selects a candidate and confirms within 15 seconds.
11. The vote is written to the blockchain and audit data is stored in the backend.
12. The voter session is cleared automatically for the next voter.

## Voter Authenticity Features

### Registration-time duplicate prevention

When a new voter is registered, the uploaded photo is compared with existing stored voter images. This helps stop the same person from registering multiple times under different names.

### Voting-time face verification

During voting, the system compares:

- The registered voter ID-card image
- The live image captured from the camera

This check happens:

- During QR confirmation
- Again during the `OK (Ready)` step before voting is enabled

### Strict face threshold

The project supports strict face verification using:

- `LIVE_FACE_VERIFICATION_THRESHOLD`

Current `.env` example:

```env
LIVE_FACE_VERIFICATION_THRESHOLD=0.94
```

Higher values make the match stricter but can also reject genuine voters if lighting or angle changes too much.

## Key Backend APIs

| Endpoint | Purpose |
| --- | --- |
| `/login` | Role-based authentication |
| `/admin/voters` | Register voter and generate voter record |
| `/admin/candidate-nominations/check` | Candidate duplicate and rule validation |
| `/admin/candidate-nominations` | Save nomination record |
| `/admin/candidates` | Save candidate metadata |
| `/admin/election/dates` | Save election time window |
| `/admin/election/stop` | Stop election |
| `/admin/election/restart` | Restart or reconduct election |
| `/voter/by-qr` | Fetch voter record by QR token |
| `/voter/confirm-scan` | Verify QR voter with live face image |
| `/voter/ready-check` | Perform ready-to-vote live face match |
| `/vote/audit` | Save audit trail after successful vote |
| `/vote/report` | Fetch live vote report |
| `/admin/vote-audit/export` | Download vote audit CSV |
| `/admin/database/clear` | Clear database records and media |

## Smart Contract Responsibilities

The smart contract in `contracts/Voting.sol` is responsible for:

- Storing candidates
- Storing vote counts
- Storing election start and end dates
- Preventing repeated vote submission from the same QR token
- Emitting vote events for public auditability

Main contract methods:

- `addCandidate`
- `vote`
- `voteByQr`
- `checkVote`
- `checkVoteByQr`
- `setDates`
- `getDates`
- `getCandidate`
- `getCountCandidates`

## Tech Stack

### Frontend

- HTML5
- CSS3
- JavaScript
- Browserify bundle for blockchain app
- Web3
- jQuery for some legacy interactions

### Backend

- FastAPI
- PyMongo
- python-dotenv
- PyJWT
- OpenCV
- NumPy

### Server and Runtime

- Node.js
- Express
- Mongoose

### Blockchain

- Solidity
- Truffle
- Ethereum-compatible RPC network

## Project Structure

```text
Decentralized-Voting-System/
├── Database_API/
│   ├── main.py
│   ├── duplicate_detection.py
│   ├── requirements.txt
│   └── media/
├── contracts/
│   └── Voting.sol
├── migrations/
├── scripts/
│   ├── generate_runtime_config.js
│   └── sync_chain_to_db.js
├── src/
│   ├── html/
│   ├── css/
│   ├── js/
│   └── dist/
├── build/
├── index.js
├── package.json
├── PAGES.md
└── README.md
```

## Environment Variables

Important variables used by the project:

| Variable | Purpose |
| --- | --- |
| `SECRET_KEY` | JWT signing key |
| `MONGODB_URI` or `MONGO_URI` | MongoDB connection string |
| `ADMIN_USERNAME` | Default admin login |
| `ADMIN_PASSWORD` | Default admin password |
| `CHAIN_ID` | Blockchain network ID |
| `RPC_URL` | RPC endpoint for blockchain network |
| `VOTING_CONTRACT_ADDRESS` | Deployed voting contract address |
| `LIVE_FACE_VERIFICATION_THRESHOLD` | Live face similarity threshold |
| `DATABASE_API_BASE` or `API_BASE` | Backend API base URL when overridden |

## Installation

### 1. Install Node dependencies

```powershell
npm install
```

### 2. Install Python dependencies

```powershell
pip install -r Database_API\requirements.txt
```

### 3. Configure environment

Update `.env` with:

- MongoDB URI
- admin credentials
- blockchain chain ID
- RPC URL
- deployed contract address
- live face verification threshold

## Run the Project

### Start the FastAPI backend

```powershell
python Database_API\main.py
```

### Start the frontend server

```powershell
npm start
```

The frontend server will:

- Generate runtime config
- Build `src/dist/app.bundle.js`
- Start Express server

## Development Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Build frontend bundle and start Express server |
| `npm run dev` | Build frontend bundle and run Express with nodemon |
| `npm run build` | Generate runtime config and rebuild frontend bundle |
| `npm run build:app` | Rebuild blockchain/browser bundle only |

## Local URLs

Typical local URLs:

- Frontend: `http://127.0.0.1:8080`
- Login: `http://127.0.0.1:8080/`
- Admin: `http://127.0.0.1:8080/admin.html`
- Vote: `http://127.0.0.1:8080/vote.html`
- Verify Vote: `http://127.0.0.1:8080/verify-vote.html`
- Explorer: `http://127.0.0.1:8080/explorer.html`
- Backend API docs: `http://127.0.0.1:8000/docs`

## Contract Deployment Notes

This project can work with:

- A local development chain such as Ganache
- A configured Ethereum-compatible network through `.env`

If you are using Truffle local development network:

```powershell
npx truffle migrate --reset --network development
```

If you redeploy the contract, update:

- `VOTING_CONTRACT_ADDRESS`
- runtime configuration if needed

## Audit and Reporting

The system stores an audit trail for each vote that can include:

- voter ID
- candidate ID
- candidate name
- party name
- transaction hash
- pre-vote captured image
- on-vote-day verification image
- vote time

Administrators can:

- download CSV reports
- view live backend vote totals
- inspect public blockchain results separately through explorer and verify pages

## Security and Integrity Notes

- Duplicate faces are blocked at voter registration time
- QR token reuse is blocked at smart-contract level
- Live face verification is required before voting
- Voting can be stopped centrally through the admin panel
- Public verification is available through blockchain event decoding
- Clearing backend data does not clear blockchain data

## Documentation Files

| File | Purpose |
| --- | --- |
| `README.md` | Setup, architecture, workflow, and usage overview |
| `PAGES.md` | Detailed literature-style explanation of pages, modules, APIs, and system flow |

## Current Status

The current project implementation includes:

- MongoDB-backed voter, candidate, election, and audit storage
- Face duplicate detection during voter registration
- Live face verification during voter verification and ready-check
- QR-based vote authorization
- EVM-style voting interface
- 15-second vote confirmation window
- Blockchain vote verification and explorer support

This repository is suitable for:

- project demonstration
- literature documentation
- academic presentation
- prototype research on secure digital voting workflows
