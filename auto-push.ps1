git add .
if (git diff --cached --quiet) {
    Write-Host "No changes to commit."
    exit
}

git commit -m "Auto-update from Claude Code"
git push