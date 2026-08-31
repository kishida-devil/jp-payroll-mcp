@echo off
rem 公開の入口。bash を自分で選ばない。
rem
rem   D:\Claude\tsumugi\scripts\publish.cmd
rem   D:\Claude\tsumugi\scripts\publish.cmd --check   空打ちだけ
rem
rem `bash publish.sh` は PATH の引き当て次第で WSL の bash を起動する。
rem WSL からは D: が見えず、Windows 側の npm / gh も無い。
rem ここで Git Bash を名指しする。
setlocal

set "SH=%~dp0publish.sh"

for %%B in (
  "%ProgramFiles%\Git\bin\bash.exe"
  "%ProgramFiles(x86)%\Git\bin\bash.exe"
  "%LocalAppData%\Programs\Git\bin\bash.exe"
) do (
  if exist %%B (
    "%%~B" "%SH%" %*
    exit /b %ERRORLEVEL%
  )
)

echo.
echo Git Bash が見つかりませんでした。
echo 探した場所:
echo   %ProgramFiles%\Git\bin\bash.exe
echo   %ProgramFiles(x86)%\Git\bin\bash.exe
echo   %LocalAppData%\Programs\Git\bin\bash.exe
echo.
echo Git for Windows の bash.exe の場所が分かれば、そこから直接:
echo   "C:\path\to\bash.exe" "%SH%"
echo.
exit /b 1
