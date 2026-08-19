@echo off
chcp 65001 >nul
title AD User Creator

powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0Server.ps1"
pause
