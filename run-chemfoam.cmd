@echo off
rem ChemFoam: run (double-click me, or run from a terminal)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run.ps1" %*
set CF_EXIT=%ERRORLEVEL%
echo %cmdcmdline% | find /i "%~0" >nul && pause
exit /b %CF_EXIT%
