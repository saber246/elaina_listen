@echo off
setlocal
set "ELAINA_PYTHON=python"
if exist "D:\onnx_train\venv\Scripts\python.exe" set "ELAINA_PYTHON=D:\onnx_train\venv\Scripts\python.exe"
"%ELAINA_PYTHON%" -B "%~dp0yoimiya_server.py" %*
if errorlevel 1 pause
