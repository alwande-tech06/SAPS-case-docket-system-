@echo off
rem Runs the app so phones and other computers on the same Wi-Fi can reach it,
rem at http://<this computer's IP>:5000. Uses waitress, not the debug server,
rem so the Flask debugger is never exposed on the network.
rem The first time, Windows asks whether to allow Python through the firewall:
rem choose Allow.
cd /d "%~dp0"
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo Open http:%%a:5000 on your phone (same Wi-Fi) & goto :run
:run
set FLASK_CONFIG=development
".venv\Scripts\waitress-serve.exe" --listen=0.0.0.0:5000 wsgi:app
