@echo off
setlocal
set "ELAINA_PYTHON=D:\onnx_train\venv\Scripts\python.exe"
set "ELAINA_VOICE=D:\onnx_train\onnx_yoimiya\yoimiya_tts"
if not "%~1"=="" set "ELAINA_VOICE=%~1"
if not "%~2"=="" set "ELAINA_PYTHON=%~2"
if "%~3"=="" (
  "%ELAINA_PYTHON%" -B "%~dp0yoimiya_server.py" --voice-dir "%ELAINA_VOICE%"
) else (
  "%ELAINA_PYTHON%" -B "%~dp0yoimiya_server.py" --voice-dir "%ELAINA_VOICE%" --extension-id "%~3"
)
exit /b %errorlevel%