@echo off
title ClassMind setup
cd /d "%~dp0"
node setup.js
if errorlevel 1 goto :eof
echo Keep this window OPEN while you use the app. Close it to stop the app.
echo.
start "" http://localhost:3000
node --disable-warning=ExperimentalWarning server.js
pause
