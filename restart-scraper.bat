@echo off
setlocal
set PORT=8787

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% .*LISTENING"') do (
  echo Encerrando processo na porta %PORT%: %%a
  taskkill /PID %%a /F >nul 2>nul
)

cd /d "%~dp0scraper-service"
npm start
