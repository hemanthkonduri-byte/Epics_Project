@echo off
title ClassMind
cd /d "%~dp0"
start "" http://localhost:3000
echo Keep this window OPEN while you use the app. Close it to stop the app.
echo.
node --disable-warning=ExperimentalWarning server.js
pause
