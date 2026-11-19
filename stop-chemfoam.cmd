@echo off
rem ChemFoam: stop (double-click me, or run from a terminal)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1" %*
set CF_EXIT=%ERRORLEVEL%
echo %cmdcmdline% | find /i "%~0" >nul && pause
exit /b %CF_EXIT%
