@echo off
echo Exit DSH completely before installation.
echo WARNING: edited histories require this patched host, including after software updates.
choice /C YN /N /M "Read README.md and proceed? [Y/N]: "
if errorlevel 2 exit /b 0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Apply-Patch.ps1" -Mode Install -AcknowledgeHistoryDependency
pause
