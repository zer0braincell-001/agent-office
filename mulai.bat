@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js belum terpasang. Unduh dari https://nodejs.org lalu jalankan lagi. & pause & exit /b)
where claude >nul 2>nul || (echo Claude Code belum ada di PATH. & pause & exit /b)
node server\server.js
pause
