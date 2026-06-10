@echo off
echo ========================================
echo NewsEra Mobile App - Asset Size Check
echo ========================================
echo.

cd /d "%~dp0"

echo Current asset sizes:
echo.
dir /s /-c assets\*.png 2>nul | findstr /i ".png"

echo.
echo ========================================
echo Target sizes (after optimization):
echo ========================================
echo icon.png:     20-50 KB
echo favicon.png:  5-10 KB
echo splash.png:   100-200 KB
echo ========================================
echo.

echo If files are larger than targets:
echo 1. Use https://squoosh.app/ to compress
echo 2. Or see OPTIMIZE_ASSETS_NOW.md for instructions
echo.

pause
