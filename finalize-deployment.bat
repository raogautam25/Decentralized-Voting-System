@echo off
setlocal enabledelayedexpansion
cd /d "C:\Users\DEVAN\Desktop\NTCC\Decentralized-Voting-System"
echo Checking git status...
git status --short
echo.
echo Adding DEPLOYMENT_CHECKLIST.md...
git add DEPLOYMENT_CHECKLIST.md
echo.
echo Committing...
git commit -m "Add deployment checklist for feedback fix and Render redeploy instructions"
echo.
echo Pushing to GitHub...
git push origin main
echo.
echo Done! DEPLOYMENT_CHECKLIST.md has been committed and pushed.
pause
