@echo off
rem Lance Relief Studio en local et ouvre le navigateur.
rem Double-cliquez sur ce fichier ; fermez la fenetre pour arreter l'application.
chcp 65001 >nul
title Relief Studio
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js est introuvable. Installez-le depuis https://nodejs.org puis relancez ce fichier.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo Premiere utilisation : installation des dependances, patientez...
  call npm install
  if errorlevel 1 (
    echo L'installation des dependances a echoue.
    pause
    exit /b 1
  )
)

echo.
echo  Relief Studio demarre, le navigateur va s'ouvrir.
echo  Pour arreter l'application : fermez cette fenetre ou faites Ctrl+C.
echo.
node node_modules\vite\bin\vite.js --open
pause
