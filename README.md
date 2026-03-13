# Decentralized Voting System

This repository now deploys the React app in `client/dist` for online hosting.

## Online Deploy

- Render start command: `node index.js`
- Vercel serves the static build from `client/dist`
- Health check: `/healthz`

## Local Run

```powershell
npm install
npm start
```

Open `http://127.0.0.1:8080`.

## Notes

- The active online deploy path no longer serves the legacy `src/html` pages.
- The legacy Python `Database_API` folder is kept in the repo for reference only and is not part of the online deploy flow.
- The built React app in `client/dist` is the source of truth for the hosted UI.
