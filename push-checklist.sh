#!/bin/bash
cd "$(dirname "$0")"
git add DEPLOYMENT_CHECKLIST.md
git commit -m "Add deployment checklist for feedback fix and Render redeploy instructions"
git push origin main
echo "Deployment checklist pushed successfully"
