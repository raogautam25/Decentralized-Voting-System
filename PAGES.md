# Decentralized Voting System - Pages Documentation

This document outlines all the pages in the voting application and their purposes.

## Page Structure

### 1. **Login Page** (`login.html`)
- **Purpose**: User authentication for both voters and admins
- **Location**: `src/html/login.html`
- **Styling**: `src/css/login.css`
- **Script**: `src/js/login.js`
- **Flow**: 
  - Voters enter their Voter ID and password
  - If role is 'admin', redirected to admin page
  - If role is 'user', redirected to voter page
  - Authentication validates against the Database API

### 2. **Admin Page** (`admin.html`)
- **Purpose**: Admin dashboard for managing candidates and voting dates
- **Location**: `src/html/admin.html`
- **Styling**: `src/css/admin.css`
- **Script**: Uses Truffle contract interface via `app.bundle.js`
- **Features**:
  - Add candidates (name and party)
  - Define voting start and end dates
  - View candidate management UI
  - Open Candidate Nomination Form (modern government-style form)

### 2a. **Candidate Nomination Form** (`candidate-nomination.html`)
- **Purpose**: Admin-only nomination intake form with real-time validation + duplicate protection (DB-backed)
- **Location**: `src/html/candidate_nomination.html`
- **Script**: `src/js/candidate_nomination.jsx` (React via CDN, Tailwind via CDN)
- **Validation**:
  - Required: Full Name, Date of Birth, ID Number
  - Contact Number numeric only
  - Date of Birth must be in the past
  - Duplicates blocked:
    - Full Name + Date of Birth
    - Party Name (unless Independent)
  - Displays inline field errors and a red duplicate alert
  - Shows a green success message on submission

### 3. **Voter Dashboard** (`voter.html`)
- **Purpose**: Main voter interface to view candidates and initiate voting
- **Location**: `src/html/voter.html`
- **Styling**: `src/css/voter.css`
- **Scripts**: `app.bundle.js` + `voter.js`
- **Features**:
  - Display candidates in a table (DB-backed fetch for realtime election list)
  - Show candidate name and party
  - Display voting period dates (DB preferred, chain fallback)
  - Show current account address
  - Submit vote button for each candidate
  - Logout button
  - Vote status indicator

### 4. **Vote Confirmation Page** (`vote.html`)
- **Purpose**: Confirm the selected candidate before submitting the vote
- **Location**: `src/html/vote.html`
- **Styling**: `src/css/vote.css`
- **Script**: `src/js/vote.js`
- **Features**:
  - Display selected candidate details (name, party)
  - Show warning about vote irreversibility
  - Confirm or cancel voting
  - After confirmation, shows success page with:
    - Transaction hash
    - Vote timestamp
    - Blockchain confirmation counter (0/12)
  - Error handling with retry option

### 5. **Loading Page** (`loading.html`)
- **Purpose**: Show transaction processing status during blockchain voting
- **Location**: `src/html/loading.html`
- **Styling**: `src/css/loading.css`
- **Script**: `src/js/loading.js`
- **Features**:
  - Animated loading spinner
  - Transaction hash display
  - Real-time status updates (Pending → Confirmed)
  - Confirmation counter
  - Progress bar animation
  - Error display with retry button
  - Prevents page closure during transaction

### 6. **Index Page** (`index.html`)
- **Purpose**: Legacy voting page (can be replaced with voter.html)
- **Location**: `src/html/index.html`
- **Note**: Consider redirecting to `voter.html` for consistency

### 7. **Public Vote Verifier** (`verify-vote.html`)
- **Purpose**: Verify a vote by transaction hash (Etherscan-style)
- **Location**: `src/html/verify_vote.html`
- **Styling**: `src/css/public_verifier.css`
- **Script**: `src/js/verify_vote.js`
- **Features**:
  - Enter transaction hash and validate on blockchain
  - Shows candidate, block number, timestamp, wallet, gas used
  - Supports quick prefill from last transaction saved in localStorage

### 8. **Blockchain Explorer** (`explorer.html`)
- **Purpose**: Public transparency page for vote events + on-chain result table
- **Location**: `src/html/explorer.html`
- **Styling**: `src/css/public_verifier.css`
- **Script**: `src/js/explorer.js`
- **Features**:
  - Displays on-chain candidate vote counts
  - Lists vote events (`VoteCast`) with tx links to verifier page
  - Refresh action for live updates

## Navigation Flow

```
login.html
├── (Admin Login)
│   └── admin.html
│       └── [Manage candidates & voting dates]
│
└── (Voter Login)
    └── voter.html
        ├── [View candidates]
        ├── [Select candidate]
        └── Click Vote Button
            └── vote.html
                ├── [Confirm selection]
                └── Click "Confirm Vote"
                    └── loading.html
                        └── [Monitor blockchain transaction]
                            └── vote.html (Success summary)
                                ├── [Show confirmation]
                                ├── Verify via verify-vote.html
                                └── Explore via explorer.html
```

## Local Storage Keys

The following keys are used to maintain state between pages:

- `jwtTokenVoter`: JWT token for voter authentication
- `jwtTokenAdmin`: JWT token for admin authentication
- `selectedCandidate`: JSON containing selected candidate data
- `currentTxHash`: Blockchain transaction hash
- `txStatus`: Transaction status (pending/confirmed/failed)
- `txError`: Error message if transaction fails
- `txConfirmations`: Number of blockchain confirmations
- `blockNumber`: Block number where transaction was mined
- `voteSubmittedTime`: ISO timestamp of vote submission
- `lastTxSummary`: Last confirmed vote summary used by verifier shortcut

## CSS Classes and Styling

All pages use:
- **Background**: Ethereum-themed background image (`eth5.jpg`)
- **Color Scheme**: Dark theme with green (#64c898) accents
- **Buttons**: 
  - Primary (teal): #198a7b
  - Success (green): #28a745
  - Danger (red): #dc3545
  - Secondary (gray): #6c757d

## JavaScript Modules

- `login.js`: Handles authentication flow
- `voter.js`: Voter dashboard functionality
- `vote.js`: Vote confirmation logic
- `loading.js`: Transaction status monitoring
- `app.js`: Web3/Blockchain contract interface (compiled to `app.bundle.js`)

## Database API Integration

All pages integrate with the Database API running on `http://127.0.0.1:8000`:

- `/login`: Authenticate users
- `/candidates`: Candidate list for voter dashboard
- `/election/dates`: DB-driven election dates for UI display
- `/vote`: Submit vote to blockchain
- CORS enabled for localhost:8080

## Environment Configuration

The Database API requires:
- MySQL database: `voter_db`
- API endpoint: `http://127.0.0.1:8000`
- Frontend runs on: `http://127.0.0.1:8080`

## Future Enhancements

- Add vote verification page
- Implement real-time result dashboard
- Add audit logs
- Multi-language support
- Mobile responsive optimizations
- Transaction gas fee calculator
