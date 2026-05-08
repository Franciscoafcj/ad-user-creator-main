@echo off
chcp 65001 >nul
color 0B
title AD User Creator - Inicializador

echo ===================================================
echo     Iniciando AD User Creator
echo ===================================================
echo.

:: Verifica se o arquivo de dados existe
if not exist "ad-data.js" (
    echo [INFO] Arquivo 'ad-data.js' nao encontrado. 
    echo Extraindo dados do Active Directory pela primeira vez...
    echo Isso pode levar alguns minutos. Aguarde.
    powershell.exe -ExecutionPolicy Bypass -NoProfile -File "Get-ADData.ps1"
    echo.
)

echo [INFO] Iniciando o servidor local em background...
:: Inicia o servidor oculto sem prender o terminal
start /B powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "Start-Server.ps1"

echo [INFO] Aguardando o servidor carregar...
timeout /t 3 /nobreak >nul

echo [INFO] Abrindo o aplicativo no navegador...
start index.html

echo.
echo ===================================================
echo  Tudo pronto! Voce ja pode usar o sistema no Chrome.
echo  Pode fechar esta janela preta.
echo ===================================================
timeout /t 5 >nul
exit
