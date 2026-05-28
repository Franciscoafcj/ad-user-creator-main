@echo off
chcp 65001 >nul
title Iniciando Start-Server.ps1 como Administrador

echo Solicitando privilégios de administrador para iniciar o servidor...
cd /d "%~dp0"
set "SCRIPT_PATH=%~dp0Start-Server.ps1"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', \"$env:SCRIPT_PATH\") -Verb RunAs"

exit
