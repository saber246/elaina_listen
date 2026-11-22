"""Synthesize text for the installed elaina listen extension on this PC."""

import argparse
import hashlib
import io
import json
import re
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

from voice_packs import PACKS, VoicePacks


HOST = "127.0.0.1"
PORT = 43167
ENDPOINTS = {"/synthesize", "/voices/list", "/voices/install"}
MAX_BODY_BYTES = 4096
MAX_TEXT_LENGTH = 160


def unpacked_extension_id(directory):
    # Chromium hashes the normalized Windows path as UTF-16LE for unpacked extensions.
    path = str(directory.resolve())
    path = path[0].upper() + path[1:]
    digest = hashlib.sha256(path.encode("utf-16le")).hexdigest()[:32]
    return digest.translate(str.maketrans("0123456789abcdef", "abcdefghijklmnop"))


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
    def __init__(self, extension_id, packs):
        self.extension_id = extension_id
        self.origin = f"chrome-extension://{extension_id}"
        self.packs = packs
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
        if (not self.trusted_host() or self.path not in ENDPOINTS
                or self.headers.get("Origin") != self.server.origin
                or self.headers.get("Access-Control-Request-Method") != "POST"):
            self.respond(403, "application/json", b"{}")
            return
        self.respond(204, "application/json", b"")

    def do_POST(self):
        origin = self.headers.get("Origin")
        if (not self.trusted_host() or origin not in (None, self.server.origin)
                or self.headers.get("X-Elaina-Client") != self.server.extension_id):
            self.error(403, "语音助手未授权这个扩展。请确认助手与当前加载的扩展来自同一项目目录。")
            return
        if self.path not in ENDPOINTS:
            self.error(404, "本机语音接口不存在。")
            return
        if self.headers.get_content_type() != "application/json":
            self.error(415, "本机语音请求格式不正确。")
            return

        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_BODY_BYTES:
                raise ValueError("invalid size")
            data = json.loads(self.rfile.read(size).decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("invalid request")
        except (ValueError, OverflowError, OSError):
            self.error(400, "本机语音请求格式不正确。")
            return

        if self.path == "/voices/list":
            self.json_response(200, {"packs": self.server.packs.listing()})
            return

        pack_id = data.get("voice", "yoimiya" if self.path == "/synthesize" else None)
        if not isinstance(pack_id, str) or pack_id not in PACKS:
            self.error(400, "未知的语音包。")
            return
        if self.path == "/voices/install":
            try:
                self.server.packs.start_download(pack_id)
            except ValueError as error:
                self.error(409, str(error))
                return
            self.json_response(202, {"packs": self.server.packs.listing()})
            return

        text = data.get("text")
        rate = data.get("rate")
        if (not isinstance(text, str) or not 1 <= len(text.strip()) <= MAX_TEXT_LENGTH
                or isinstance(rate, bool) or not isinstance(rate, (float, int))
                or not 0.5 <= rate <= 2):
            self.error(400, "请提交一段有效的文本和语速。")
            return

        try:
            audio = self.server.packs.synthesize(pack_id, text.strip(), float(rate))
            wav = to_wave(audio)
        except FileNotFoundError as error:
            self.error(404, str(error))
            return
        except (ValueError, RuntimeError, OSError):
            self.error(500, "本机音色合成失败。可切换回系统语音后继续。")
            return

        if wav is None:
            self.error(422, "本机音色无法合成这段内容。可切换回系统语音或跳至下一段。")
        else:
            self.respond(200, "audio/wav", wav)

    def error(self, status, message):
        self.json_response(status, {"message": message})

    def json_response(self, status, data):
        self.respond(status, "application/json; charset=utf-8",
                     json.dumps(data, ensure_ascii=False).encode("utf-8"))

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
    desktop = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice-dir", type=Path)
    parser.add_argument("--models-dir", type=Path, default=desktop.parent.parent / "models")
    parser.add_argument("--download-dir", type=Path, default=desktop / "voice-packs")
    parser.add_argument("--extension-id",
                        default=unpacked_extension_id(desktop.parent / "extension"))
    args = parser.parse_args()
    if not re.fullmatch(r"[a-p]{32}", args.extension_id):
        parser.error("--extension-id 必须是 Edge 扩展的 32 位 ID")

    packs = VoicePacks(args.models_dir.resolve(), args.download_dir.resolve(),
                       args.voice_dir.resolve() if args.voice_dir else None)
    with VoiceServer(args.extension_id, packs) as server:
        print(f"本机语音助手已就绪：{HOST}:{PORT}，扩展 ID {args.extension_id}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            return


if __name__ == "__main__":
    main()
