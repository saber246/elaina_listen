"""Synthesize text for the installed elaina listen extension on this PC."""

import argparse
import hashlib
import io
import json
import math
import re
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import sherpa_onnx


HOST = "127.0.0.1"
PORT = 43167
ENDPOINT = "/synthesize"
MAX_BODY_BYTES = 4096
MAX_TEXT_LENGTH = 160


def unpacked_extension_id(directory):
    # Chromium hashes the normalized Windows path as UTF-16LE for unpacked extensions.
    path = str(directory.resolve())
    path = path[0].upper() + path[1:]
    digest = hashlib.sha256(path.encode("utf-16le")).hexdigest()[:32]
    return digest.translate(str.maketrans("0123456789abcdef", "abcdefghijklmnop"))


def load_voice(directory):
    files = {name: directory / name for name in ("model.onnx", "tokens.txt", "lexicon.txt")}
    for file in files.values():
        if not file.is_file():
            raise FileNotFoundError(f"宵宫语音包缺少 {file}")

    voice = sherpa_onnx.OfflineTtsVitsModelConfig(
        model=str(files["model.onnx"]),
        tokens=str(files["tokens.txt"]),
        lexicon=str(files["lexicon.txt"]),
    )
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(vits=voice, provider="cpu", num_threads=4),
        max_num_sentences=2,
    )
    if not config.validate():
        raise ValueError("宵宫语音包配置有误")
    return sherpa_onnx.OfflineTts(config)


def to_wave(audio):
    samples = np.asarray(audio.samples, dtype=np.float32)
    if samples.size == 0 or audio.sample_rate <= 0:
        return None
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setparams((1, 2, audio.sample_rate, 0, "NONE", "not compressed"))
        output.writeframes(pcm.tobytes())
    return buffer.getvalue()


class VoiceServer(ThreadingHTTPServer):
    def __init__(self, extension_id, voice):
        self.extension_id = extension_id
        self.origin = f"chrome-extension://{extension_id}"
        self.voice = voice
        self.lock = threading.Lock()
        super().__init__((HOST, PORT), VoiceHandler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        return connection, address


class VoiceHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        # Browser requests can contain private article text.
        return

    def trusted_host(self):
        return self.headers.get("Host") == f"{HOST}:{PORT}"

    def do_OPTIONS(self):
        if (not self.trusted_host() or self.path != ENDPOINT
                or self.headers.get("Origin") != self.server.origin
                or self.headers.get("Access-Control-Request-Method") != "POST"):
            self.respond(403, "application/json", b"{}")
            return
        self.respond(204, "application/json", b"")

    def do_POST(self):
        origin = self.headers.get("Origin")
        if (not self.trusted_host() or origin not in (None, self.server.origin)
                or self.headers.get("X-Elaina-Client") != self.server.extension_id):
            self.error(403, "宵宫助手未授权这个扩展。请确认助手与当前加载的扩展来自同一项目目录。")
            return
        if self.path != ENDPOINT:
            self.error(404, "本机合成接口不存在。")
            return
        if self.headers.get_content_type() != "application/json":
            self.error(415, "本机合成请求格式不正确。")
            return

        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_BODY_BYTES:
                raise ValueError("invalid size")
            data = json.loads(self.rfile.read(size).decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("invalid request")
            text = data.get("text")
            rate = data.get("rate")
            if not isinstance(text, str) or not 1 <= len(text.strip()) <= MAX_TEXT_LENGTH:
                raise ValueError("invalid text")
            if (isinstance(rate, bool) or not isinstance(rate, (float, int))
                    or not math.isfinite(rate) or not 0.5 <= rate <= 2):
                raise ValueError("invalid rate")
        except (ValueError, OverflowError, OSError):
            self.error(400, "请提交一段有效的文本和语速。")
            return

        try:
            with self.server.lock:
                audio = self.server.voice.generate(text.strip(), sid=0, speed=float(rate))
            wav = to_wave(audio)
        except (ValueError, RuntimeError):
            self.error(500, "宵宫音色合成失败。可切换回系统语音后继续。")
            return

        if wav is None:
            self.error(422, "宵宫音色无法合成这段内容。可切换回系统语音或跳至下一段。")
        else:
            self.respond(200, "audio/wav", wav)

    def error(self, status, message):
        self.respond(status, "application/json; charset=utf-8",
                     json.dumps({"message": message}, ensure_ascii=False).encode("utf-8"))

    def respond(self, status, content_type, body):
        try:
            self.send_response(status)
            if self.headers.get("Origin") == self.server.origin:
                self.send_header("Access-Control-Allow-Origin", self.server.origin)
                self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Elaina-Client")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Vary", "Origin")
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if body:
                self.wfile.write(body)
        except OSError:
            # A reader can stop, seek or close while audio is still being generated.
            return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice-dir", type=Path, required=True)
    parser.add_argument("--extension-id",
                        default=unpacked_extension_id(Path(__file__).resolve().parents[1] / "extension"))
    args = parser.parse_args()
    if not re.fullmatch(r"[a-p]{32}", args.extension_id):
        parser.error("--extension-id 必须是 Edge 扩展的 32 位 ID")

    voice = load_voice(args.voice_dir)
    with VoiceServer(args.extension_id, voice) as server:
        print(f"宵宫语音已就绪：{HOST}:{PORT}，扩展 ID {args.extension_id}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            return


if __name__ == "__main__":
    main()