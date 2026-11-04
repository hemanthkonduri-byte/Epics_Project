@echo off
title AI Knowledge System - Public URL
cd /d "%~dp0"
echo Starting AI Knowledge System server on port 3000...
start "AI Knowledge System Server" cmd /k "node --disable-warning=ExperimentalWarning server.js"
timeout /t 2 /nobreak >nul
echo.
echo Starting Public HTTPS Tunnel (anyone with the trycloudflare.com link below can access the site)...
echo.
"%~dp0cloudflared.exe" tunnel --url http://localhost:3000
pause

