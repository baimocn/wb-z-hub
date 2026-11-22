@echo off
rem WorkBuddy2API-Hub silent auto-start (used by the Startup-folder VBS)
rem Runs the gateway hidden; logs go to wb-proxy-run.log / wb-proxy-run.err
rem If the port is already taken (gateway already running) the new process exits on its own.

rem ---- pool wave-hold tuning (ASCII only: cmd reads this file in GBK) ----
rem Default: 2 accounts restricted within 900s -> whole pool pauses 1800s.
rem With a small pool that pause blocks requests even when usable accounts exist.
rem Hold seconds 0 = disable the whole-pool pause; failed account just rotates.
set "WB_RESTRICTION_HOLD_SECONDS=0"
rem Raise the trigger threshold so a stray 403 does not pause the pool.
set "WB_RESTRICTION_WAVE_MIN=10"

powershell -NoProfile -Command "Start-Process -FilePath 'C:\Python314\python.exe' -ArgumentList 'wb_proxy.py','--port','8789' -WorkingDirectory 'D:\Desktop\workbuddy2api-hub-main\workbuddy2api-hub-main' -WindowStyle Hidden -RedirectStandardOutput 'D:\Desktop\workbuddy2api-hub-main\workbuddy2api-hub-main\wb-proxy-run.log' -RedirectStandardError 'D:\Desktop\workbuddy2api-hub-main\workbuddy2api-hub-main\wb-proxy-run.err'"
exit /b 0
