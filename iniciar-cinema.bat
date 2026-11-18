@echo off
title PaeStream - Cinema Privado
cd /d "%~dp0"

if not exist "node_modules" (
  echo [PaeStream] Instalando dependencias...
  call npm install
)

echo [PaeStream] Iniciando servidor e abrindo http://localhost:3000 ...
start "" /B cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node server/index.js
pause
