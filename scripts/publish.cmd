@echo off
rem Entry point for publishing. ASCII only on purpose.
rem
rem   D:\Claude\tsumugi\scripts\publish.cmd
rem   D:\Claude\tsumugi\scripts\publish.cmd --check
rem
rem Three things broke the first version of this file, all of them cmd.exe rules:
rem   1. It was UTF-8. cmd reads .cmd in the OEM code page (932 here), so the
rem      Japanese comments became mojibake and were executed as commands.
rem   2. %ProgramFiles(x86)% inside a for ( ... ) block: the ) in the variable
rem      name closes the block early.
rem   3. Both of the above broke `set "SH=%~dp0publish.sh"`, so bash was called
rem      with an empty argument.
rem Hence: ASCII, no parenthesised blocks, no (x86) variable.
setlocal

set "SH=%~dp0publish.sh"
if not exist "%SH%" goto :nosh

set "BASH=C:\Program Files\Git\bin\bash.exe"
if exist "%BASH%" goto :run

set "BASH=C:\Program Files (x86)\Git\bin\bash.exe"
if exist "%BASH%" goto :run

set "BASH=%LocalAppData%\Programs\Git\bin\bash.exe"
if exist "%BASH%" goto :run

set "BASH=C:\Program Files\Git\usr\bin\bash.exe"
if exist "%BASH%" goto :run

goto :nobash

:run
"%BASH%" "%SH%" %*
exit /b %ERRORLEVEL%

:nosh
echo.
echo publish.sh not found next to this file:
echo   %SH%
echo.
exit /b 1

:nobash
echo.
echo Git Bash was not found. Looked in:
echo   C:\Program Files\Git\bin\bash.exe
echo   C:\Program Files (x86)\Git\bin\bash.exe
echo   %LocalAppData%\Programs\Git\bin\bash.exe
echo   C:\Program Files\Git\usr\bin\bash.exe
echo.
echo If Git for Windows is installed elsewhere, run it directly:
echo   "C:\your\path\bash.exe" "%SH%"
echo.
exit /b 1
