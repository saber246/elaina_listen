"""Voice-pack catalog, installation, and local model loading."""

from dataclasses import dataclass
import hashlib
import re
import shutil
import tarfile
import threading
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

import sherpa_onnx


MIB = 1024 * 1024
BLOCK_SIZE = MIB
RELEASE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
DOWNLOAD_HOSTS = {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
CHINESE_RULES = ("number.fst", "date.fst", "phone.fst")
VITS_FILES = ("model.onnx", "tokens.txt", "lexicon.txt")


@dataclass(frozen=True)
class Asset:
    name: str
    size: int
    sha256: str = ""
    tag: str = "tts-models"


@dataclass(frozen=True)
class Pack:
    name: str
    language: str
    engine: str
    files: tuple[str, ...] = ()
    rules: tuple[str, ...] = ()
    assets: tuple[Asset, ...] = ()
    local_dir: str = ""
    sid: int = 0
    unavailable: str = ""


PACKS = {
    "matcha-icefall-zh-baker": Pack(
        "Matcha · 中文", "zh-CN", "matcha",
        ("model-steps-3.onnx", "vocos-22khz-univ.onnx", "tokens.txt", "lexicon.txt"),
        CHINESE_RULES,
        (
            Asset("matcha-icefall-zh-baker.tar.bz2", 75455267,
                  "ae70096b19c6e283ea351a26b8a718ce6427c8bde8c1da22eb46a5478d39a69b"),
            Asset("vocos-22khz-univ.onnx", 53884024, tag="vocoder-models"),
        ),
    ),
    "vits-melo-tts-zh_en": Pack(
        "MeloTTS · 中英", "zh-CN", "vits", VITS_FILES, (*CHINESE_RULES, "new_heteronym.fst"),
        (Asset("vits-melo-tts-zh_en.tar.bz2", 167006755),),
    ),
    "kokoro-multi-lang-v1_1": Pack(
        "Kokoro · 中文", "zh-CN", "kokoro",
        ("model.onnx", "voices.bin", "tokens.txt", "lexicon-zh.txt",
         "espeak-ng-data", "dict"),
        ("number-zh.fst", "date-zh.fst", "phone-zh.fst"),
        (Asset("kokoro-multi-lang-v1_1.tar.bz2", 364855331,
               "b78e1ac42b852e839cceaafbe88f66806bf5860992d1d7b9a3f2ad1198427aed"),),
        sid=1,
    ),
    "yoimiya": Pack("宵宫（本机）", "zh-CN", "vits", VITS_FILES),
    "fanchen-c": Pack(
        "凡尘 C（本机）", "zh-CN", "vits",
        ("vits-zh-hf-fanchen-C.onnx", "tokens.txt", "lexicon.txt"),
        (*CHINESE_RULES, "new_heteronym.fst"), local_dir="vits-zh-hf-fanchen-C",
    ),
    "huayan": Pack("华燕", "zh-CN", "", unavailable="当前推理引擎缺少此模型需要的音素转换，暂不可播放。"),
}


def files_present(pack, directory):
    return all(
        (directory / name).is_dir() if name in {"espeak-ng-data", "dict"}
        else (directory / name).is_file() and (directory / name).stat().st_size > 0
        for name in pack.files
    )


def load_voice(pack, directory):
    def path(name):
        return str(directory / name)

    tokens = path("tokens.txt")
    if pack.engine == "matcha":
        config = sherpa_onnx.OfflineTtsMatchaModelConfig(
            acoustic_model=path("model-steps-3.onnx"), vocoder=path("vocos-22khz-univ.onnx"),
            tokens=tokens, lexicon=path("lexicon.txt"),
        )
    elif pack.engine == "kokoro":
        config = sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=path("model.onnx"), voices=path("voices.bin"), tokens=tokens,
            lexicon=path("lexicon-zh.txt"), data_dir=path("espeak-ng-data"),
            dict_dir=path("dict"), lang="zh",
        )
    else:
        config = sherpa_onnx.OfflineTtsVitsModelConfig(
            model=path(pack.files[0]), tokens=tokens, lexicon=path("lexicon.txt"),
        )

    rule_fsts = ",".join(path(name) for name in pack.rules if (directory / name).is_file())
    settings = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(**{pack.engine: config}, provider="cpu", num_threads=4),
        rule_fsts=rule_fsts,
        max_num_sentences=2,
    )
    if not settings.validate():
        raise ValueError("语音包配置有误。")
    voice = sherpa_onnx.OfflineTts(settings)
    if not 0 <= pack.sid < voice.num_speakers:
        raise ValueError("语音包音色编号不可用。")
    return voice


class ReleaseRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urlparse(newurl)
        if url.scheme != "https" or url.hostname not in DOWNLOAD_HOSTS:
            raise ValueError("语音包下载地址跳转到未授权来源。")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_asset(asset, destination, progress):
    url = f"{RELEASE_URL}/{asset.tag}/{asset.name}"
    request = Request(url, headers={"User-Agent": "elaina-listen"})
    digest = hashlib.sha256()
    size = 0
    with build_opener(ReleaseRedirect()).open(request, timeout=30) as response, destination.open("wb") as output:
        while chunk := response.read(BLOCK_SIZE):
            size += len(chunk)
            if size > asset.size:
                raise ValueError("下载文件超过语音包的发布大小。")
            digest.update(chunk)
            output.write(chunk)
            progress(len(chunk))
    if size != asset.size or (asset.sha256 and digest.hexdigest() != asset.sha256):
        raise ValueError("语音包下载不完整或校验失败。")


def extract_model_archive(archive_path, directory, asset, pack):
    root = asset.name.removesuffix(".tar.bz2")
    root_files = set(pack.files) | set(pack.rules) | {"LICENSE", "README.md"}
    directories = set(pack.files) & {"dict", "espeak-ng-data"}
    total = 0
    with tarfile.open(archive_path, "r|bz2") as archive:
        for member in archive:
            parts = PurePosixPath(member.name).parts
            if len(parts) < 2 or parts[0] != root:
                continue
            relative = parts[1:]
            relevant = relative[0] in directories or (len(relative) == 1 and relative[0] in root_files)
            if not relevant or member.isdir():
                continue
            if (not member.isfile()
                    or any(not re.fullmatch(r"[\w.-]+", part) or part.endswith(".")
                           or Path(part).is_reserved() for part in relative)):
                raise ValueError("语音包包含无效文件。")
            total += member.size
            if total > 768 * MIB:
                raise ValueError("语音包解压大小超出限制。")
            destination = directory.joinpath(*relative)
            if not destination.resolve().is_relative_to(directory.resolve()):
                raise ValueError("语音包文件不在安装目录内。")
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, destination.open("wb") as output:
                shutil.copyfileobj(source, output, BLOCK_SIZE)


class VoicePacks:
    def __init__(self, models_dir, download_dir, yoimiya_dir=None):
        self.models_dir = models_dir
        self.download_dir = download_dir
        self.yoimiya_dir = yoimiya_dir
        self.jobs = {}
        self.job_lock = threading.Lock()
        self.engine_lock = threading.Lock()
        self.cached_key = None
        self.voice = None

    def installed_directory(self, pack_id, pack):
        if pack.unavailable:
            return None
        downloaded = self.download_dir / pack_id
        if pack.assets and (downloaded / ".installed").is_file() and files_present(pack, downloaded):
            return downloaded
        if pack_id == "yoimiya" and self.yoimiya_dir and files_present(pack, self.yoimiya_dir):
            return self.yoimiya_dir
        local = self.models_dir / pack_id
        if files_present(pack, local):
            return local
        if pack.local_dir:
            local = self.models_dir / pack.local_dir
            if files_present(pack, local):
                return local
        return None

    def listing(self):
        with self.job_lock:
            return [self.pack_status(pack_id, pack) for pack_id, pack in PACKS.items()]

    def pack_status(self, pack_id, pack):
        ready = self.installed_directory(pack_id, pack) is not None
        job = self.jobs.get(pack_id, {})
        return {
            "id": pack_id, "name": pack.name, "language": pack.language, "ready": ready,
            "size": sum(asset.size for asset in pack.assets), "status": "ready" if ready else job.get("status", ""),
            "received": job.get("received", 0), "message": pack.unavailable or job.get("message", ""),
        }

    def start_download(self, pack_id):
        pack = PACKS[pack_id]
        if not pack.assets:
            raise ValueError("这个语音包只提供本地使用。")
        with self.job_lock:
            if self.installed_directory(pack_id, pack):
                return
            if any(job["status"] == "downloading" for job in self.jobs.values()):
                if self.jobs.get(pack_id, {}).get("status") == "downloading":
                    return
                raise ValueError("请等当前语音包下载完成。")
            self.jobs[pack_id] = {"status": "downloading", "received": 0}
            threading.Thread(target=self.install, args=(pack_id, pack), daemon=True).start()

    def install(self, pack_id, pack):
        directory = self.download_dir / pack_id
        part = directory / ".download"
        marker = directory / ".installed"
        succeeded = False
        try:
            directory.mkdir(parents=True, exist_ok=True)
            marker.unlink(missing_ok=True)
            for asset in pack.assets:
                download_asset(asset, part, lambda size: self.count_download(pack_id, size))
                if asset.name.endswith(".tar.bz2"):
                    extract_model_archive(part, directory, asset, pack)
                    part.unlink()
                else:
                    part.replace(directory / asset.name)
            if not files_present(pack, directory):
                raise ValueError("下载的语音包缺少运行文件。")
            marker.write_text("1\n", encoding="ascii")
            succeeded = True
        except (OSError, ValueError, tarfile.TarError) as error:
            print(f"语音包 {pack_id} 安装失败：{error}", flush=True)
        finally:
            try:
                part.unlink(missing_ok=True)
            except OSError:
                pass
            with self.job_lock:
                if succeeded:
                    self.jobs.pop(pack_id, None)
                else:
                    self.jobs[pack_id].update(
                        status="error", message="安装失败。请检查 GitHub 连接和磁盘空间后重试。",
                    )

    def count_download(self, pack_id, size):
        with self.job_lock:
            self.jobs[pack_id]["received"] += size

    def synthesize(self, pack_id, text, rate):
        pack = PACKS[pack_id]
        directory = self.installed_directory(pack_id, pack)
        if directory is None:
            raise FileNotFoundError("这个语音包尚未就绪。")
        key = (pack_id, directory)
        with self.engine_lock:
            if self.cached_key != key:
                self.cached_key = None
                self.voice = None
                self.voice = load_voice(pack, directory)
                self.cached_key = key
            return self.voice.generate(text, sid=pack.sid, speed=rate)
