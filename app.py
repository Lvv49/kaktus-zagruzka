import asyncio
import os
import re
import shutil
import tempfile
import time
import uuid
import zipfile
import io
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

import yt_dlp
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import youtube_innertube

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
EXTENSION_DIR = BASE_DIR / "extension"
DOWNLOADS_DIR = BASE_DIR / "downloads"
DOWNLOADS_DIR.mkdir(exist_ok=True)
COOKIES_DIR = BASE_DIR / "cookies"
COOKIES_DIR.mkdir(exist_ok=True)
COOKIES_FILE = COOKIES_DIR / "youtube.txt"

PUBLIC_URL = (
    os.environ.get("PUBLIC_URL")
    or os.environ.get("RENDER_EXTERNAL_URL", "")
    or "https://kaktus-zagruzka.onrender.com"
).rstrip("/")

IS_RENDER = bool(os.environ.get("RENDER") or os.environ.get("RENDER_EXTERNAL_URL"))


def init_cookies_from_env() -> None:
    """Загружает cookies из переменной окружения (для Render)."""
    if COOKIES_FILE.is_file():
        return

    raw = os.environ.get("YTDLP_COOKIES", "").strip()
    if not raw:
        return

    COOKIES_FILE.write_text(raw, encoding="utf-8")


init_cookies_from_env()

DOWNLOAD_TOKENS: dict[str, dict] = {}
TOKEN_TTL_SEC = 1800

app = FastAPI(title="Кактус загрузка", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class AnalyzeRequest(BaseModel):
    url: str
    cookies: Optional[str] = None


class DownloadRequest(BaseModel):
    url: str
    format_id: str
    cookies: Optional[str] = None


@contextmanager
def temp_cookie_file(cookies: Optional[str]):
    if not cookies or not cookies.strip():
        yield None
        return
    fd, path = tempfile.mkstemp(suffix=".txt", prefix="ytcookies_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(cookies.strip())
        yield path
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def sanitize_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*]', "", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:200] or "video"


def format_size(size: Optional[int]) -> str:
    if not size:
        return "—"
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    if size < 1024 * 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    return f"{size / (1024 * 1024 * 1024):.2f} GB"


def format_duration(seconds: Optional[float]) -> str:
    if not seconds:
        return "—"
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def get_format_label(fmt: dict) -> str:
    parts = []
    ext = fmt.get("ext", "?")
    parts.append(ext.upper())

    resolution = fmt.get("resolution") or fmt.get("format_note")
    height = fmt.get("height")
    if height:
        parts.append(f"{height}p")
    elif resolution and resolution != "audio only":
        parts.append(resolution)

    vcodec = fmt.get("vcodec", "none")
    acodec = fmt.get("acodec", "none")
    if vcodec != "none" and acodec != "none":
        parts.append("видео+аудио")
    elif vcodec != "none":
        parts.append("только видео")
    elif acodec != "none":
        parts.append("только аудио")

    fps = fmt.get("fps")
    if fps:
        parts.append(f"{int(fps)} fps")

    note = fmt.get("format_note")
    if note and note not in parts and note != resolution:
        parts.append(note)

    return " · ".join(parts)


def extract_youtube_id(url: str) -> Optional[str]:
    patterns = [
        r"(?:v=|/embed/|/shorts/|/live/)([\w-]{11})",
        r"youtu\.be/([\w-]{11})",
    ]
    for pattern in patterns:
        match = re.search(pattern, url, re.I)
        if match:
            return match.group(1)
    return None


def youtube_stub_info(url: str) -> dict:
    video_id = extract_youtube_id(url)
    if not video_id:
        raise ValueError("Не удалось определить ID видео YouTube")
    return {
        "id": video_id,
        "title": "YouTube видео",
        "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        "uploader": "—",
        "duration": None,
        "extractor_key": "youtube",
        "formats": [],
        "webpage_url": url,
    }


def default_youtube_clients(with_cookies: bool = False) -> list[str]:
    if with_cookies:
        return ["web", "tv", "tv_embedded", "android_vr", "ios", "android"]
    return ["android_vr", "tv", "tv_embedded", "ios", "android", "mweb"]


def is_format_unavailable_error(err: Exception) -> bool:
    msg = str(err).lower()
    return "not available" in msg or "requested format" in msg


def is_bot_ytdl_error(err: Exception) -> bool:
    msg = str(err).lower()
    return any(
        word in msg
        for word in (
            "bot",
            "sign in",
            "confirm you're not a bot",
            "cookies",
            "player response",
            "unable to download api page",
            "http error 403",
            "http error 429",
        )
    )


def is_retryable_ytdl_error(err: Exception) -> bool:
    return is_bot_ytdl_error(err) or is_format_unavailable_error(err)


def parse_preset_height(format_id: str) -> Optional[int]:
    if format_id.startswith("q:"):
        try:
            return int(format_id[2:])
        except ValueError:
            return None
    match = re.search(r"height<=(\d+)", format_id)
    if match:
        return int(match.group(1))
    if format_id in ("18", "b", "bv*+ba/b", "worst"):
        return 360
    return None


def format_id_to_ytdl(format_id: str) -> str:
    """Как у Cobalt/Y2Mate: качество → yt-dlp с цепочкой fallback."""
    if format_id.startswith("q:"):
        try:
            height = int(format_id[2:])
        except ValueError:
            return "b/bv*+ba/b/18"
        return "/".join([
            f"best[height<={height}][ext=mp4][vcodec!=none][acodec!=none]",
            f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]",
            f"bestvideo[height<={height}]+bestaudio",
            f"best[height<={height}]",
            "18",
            "b",
        ])

    if format_id == "audio":
        return "bestaudio[ext=m4a]/bestaudio/bestaudio"

    if format_id == "b":
        return "b/bv*+ba/b/18/worst"

    if format_id == "bv*+ba/b":
        return "bv*+ba/b/bestvideo+bestaudio/best/b"

    return format_id


def estimate_quality_filesize(info: dict, height: int) -> str:
    progressive_id = pick_progressive_format(info, height)
    if progressive_id:
        for fmt in info.get("formats", []):
            if str(fmt.get("format_id")) == progressive_id:
                return format_size(fmt.get("filesize") or fmt.get("filesize_approx"))

    video_sz = 0
    audio_sz = 0
    for fmt in info.get("formats", []):
        if not is_useful_format(fmt):
            continue
        size = fmt.get("filesize") or fmt.get("filesize_approx") or 0
        fmt_height = fmt.get("height") or 0
        if fmt.get("vcodec") != "none" and fmt.get("acodec") == "none" and fmt_height <= height:
            video_sz = max(video_sz, size)
        if fmt.get("acodec") != "none" and fmt.get("vcodec") == "none":
            audio_sz = max(audio_sz, size)

    if video_sz or audio_sz:
        return format_size(video_sz + audio_sz)
    return "—"


def youtube_competitor_formats(info: dict) -> list[dict]:
    max_h = max_video_height(info)
    formats: list[dict] = []

    formats.append({
        "format_id": "b",
        "label": "Авто (рекомендуется)",
        "ext": "mp4",
        "resolution": "авто",
        "filesize": "—",
        "has_video": True,
        "has_audio": True,
        "quality": 99999,
        "height": max_h or 0,
        "recommended": True,
    })

    for height in (1080, 720, 480, 360, 240):
        if max_h and height > max_h:
            continue
        formats.append({
            "format_id": f"q:{height}",
            "label": f"MP4 · {height}p",
            "ext": "mp4",
            "resolution": f"{height}p",
            "filesize": estimate_quality_filesize(info, height),
            "has_video": True,
            "has_audio": True,
            "quality": height,
            "height": height,
            "recommended": False,
        })

    formats.append({
        "format_id": "bv*+ba/b",
        "label": "MP4 · макс. качество",
        "ext": "mp4",
        "resolution": f"{max_h}p" if max_h else "макс.",
        "filesize": "—",
        "has_video": True,
        "has_audio": True,
        "quality": max_h or 9999,
        "height": max_h or 9999,
        "recommended": False,
    })

    audio_id = pick_audio_format(info)
    formats.append({
        "format_id": "audio" if not audio_id else audio_id,
        "label": "MP3 · только аудио",
        "ext": "m4a",
        "resolution": "аудио",
        "filesize": "—",
        "has_video": False,
        "has_audio": True,
        "quality": 0,
        "height": 0,
        "recommended": False,
    })

    return formats


def pick_progressive_format(info: dict, max_height: Optional[int] = None) -> Optional[str]:
    candidates: list[tuple[int, str]] = []
    for fmt in info.get("formats", []):
        if not is_useful_format(fmt):
            continue
        if fmt.get("vcodec") == "none" or fmt.get("acodec") == "none":
            continue
        height = fmt.get("height") or 0
        if max_height and height > max_height:
            continue
        candidates.append((height, str(fmt["format_id"])))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


def pick_audio_format(info: dict) -> Optional[str]:
    candidates: list[tuple[int, str]] = []
    for fmt in info.get("formats", []):
        if not is_useful_format(fmt):
            continue
        if fmt.get("vcodec") != "none":
            continue
        if fmt.get("acodec") == "none":
            continue
        abr = fmt.get("abr") or fmt.get("tbr") or 0
        candidates.append((abr, str(fmt["format_id"])))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


def max_video_height(info: dict) -> int:
    heights = [
        f.get("height") or 0
        for f in info.get("formats", [])
        if is_useful_format(f) and f.get("vcodec") != "none"
    ]
    return max(heights) if heights else 0


def build_youtube_merged_formats(info: dict) -> list[dict]:
    progressive_heights = {
        f.get("height") or 0
        for f in info.get("formats", [])
        if is_useful_format(f) and f.get("vcodec") != "none" and f.get("acodec") != "none"
    }
    video_heights = sorted(
        {
            f.get("height") or 0
            for f in info.get("formats", [])
            if is_useful_format(f) and f.get("vcodec") != "none" and f.get("height")
        },
        reverse=True,
    )

    merged = []
    seen_heights = set()
    for height in video_heights:
        if height in progressive_heights or height in seen_heights:
            continue
        seen_heights.add(height)
        fmt_id = f"bestvideo[height<={height}]+bestaudio/best[height<={height}]"
        merged.append({
            "format_id": fmt_id,
            "label": f"MP4 · {height}p",
            "ext": "mp4",
            "resolution": f"{height}p",
            "filesize": "—",
            "has_video": True,
            "has_audio": True,
            "quality": height,
            "height": height,
            "recommended": False,
        })
    return merged


def is_virtual_format(format_id: str) -> bool:
    if format_id.startswith("q:"):
        return True
    if format_id in ("18", "b", "worst", "best", "audio"):
        return False
    if not format_id:
        return True
    return bool(re.search(r"[\[\+\*]", format_id)) or format_id in ("bv*+ba/b", "bestaudio")


def youtube_reliable_formats() -> list[str]:
    return ["b", "18", "worst", "bv*+ba/b", "bestvideo+bestaudio/best", "best"]


def resolve_format_for_download(
    url: str,
    format_id: str,
    cookies: Optional[str] = None,
) -> Optional[str]:
    if not is_youtube_url(url):
        return format_id

    if format_id in ("18", "b", "worst", "audio"):
        return format_id_to_ytdl(format_id)

    if format_id.startswith("q:"):
        return format_id_to_ytdl(format_id)

    try:
        info = ytdl_extract(
            url,
            download=False,
            user_cookies=cookies,
            fast=True,
        )
        available = {
            str(f["format_id"])
            for f in info.get("formats", [])
            if is_useful_format(f)
        }

        if format_id in available:
            return format_id

        if format_id == "bestaudio" or format_id == "audio":
            audio = pick_audio_format(info)
            return audio or "bestaudio"

        max_height = parse_preset_height(format_id)
        if max_height:
            progressive = pick_progressive_format(info, max_height)
            if progressive:
                return progressive

        for fmt in info.get("formats", []):
            if not is_useful_format(fmt):
                continue
            if fmt.get("vcodec") != "none" and fmt.get("acodec") != "none":
                return str(fmt["format_id"])
    except Exception:
        pass

    if is_virtual_format(format_id):
        return format_id_to_ytdl(format_id)
    return None


def build_download_format_attempts(
    format_id: str,
    url: str,
    cookies: Optional[str] = None,
) -> list[str]:
    if not is_youtube_url(url):
        return [format_id]

    attempts: list[str] = [format_id_to_ytdl(format_id)]

    resolved = resolve_format_for_download(url, format_id, cookies)
    if resolved and re.fullmatch(r"\d+", str(resolved)):
        attempts.insert(0, resolved)

    attempts.append(format_id_to_ytdl("b"))

    return list(dict.fromkeys(attempts))[:3]


def store_download_token(url: str, format_id: str, cookies: Optional[str]) -> str:
    cleanup_download_tokens()
    token = str(uuid.uuid4())
    DOWNLOAD_TOKENS[token] = {
        "url": url.strip(),
        "format_id": format_id,
        "cookies": cookies,
        "expires": time.time() + TOKEN_TTL_SEC,
        "status": "pending",
        "error": None,
        "message": "В очереди",
        "file_path": None,
        "filename": None,
        "tmp_dir": None,
    }
    return token


def cleanup_download_tokens() -> None:
    now = time.time()
    expired = [key for key, job in DOWNLOAD_TOKENS.items() if job["expires"] < now]
    for key in expired:
        job = DOWNLOAD_TOKENS.pop(key, None)
        if job and job.get("tmp_dir"):
            shutil.rmtree(job["tmp_dir"], ignore_errors=True)


def get_download_job(token: str) -> Optional[dict]:
    cleanup_download_tokens()
    job = DOWNLOAD_TOKENS.get(token)
    if not job or job["expires"] < time.time():
        return None
    return job


def youtube_simple_formats() -> list[dict]:
    return youtube_competitor_formats({"formats": []})


def is_youtube_url(url: str) -> bool:
    return bool(re.search(r"(youtube\.com|youtu\.be|youtube-nocookie\.com)", url, re.I))


def is_youtube_info(info: dict, source_url: str = "") -> bool:
    key = (info.get("extractor_key") or "").lower()
    url = info.get("webpage_url") or info.get("original_url") or source_url or ""
    return "youtube" in key or is_youtube_url(url)


def pick_thumbnail(info: dict) -> Optional[str]:
    video_id = info.get("id")
    for thumb in reversed(info.get("thumbnails") or []):
        url = thumb.get("url") or ""
        if url and ".webp" not in url.lower():
            return url

    url = info.get("thumbnail") or ""
    if url:
        if ".webp" in url.lower():
            return url.replace("vi_webp/", "vi/").replace(".webp", ".jpg")
        return url

    if video_id:
        return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    return None


def youtube_quality_presets() -> list[dict]:
    presets = [
        ("bv*+ba/b", "MP4 · лучшее качество", 99999, True),
        ("b", "MP4 · хорошее качество", 5000, False),
        ("bestvideo[height<=1080]+bestaudio/best[height<=1080]", "MP4 · 1080p", 1080, False),
        ("bestvideo[height<=720]+bestaudio/best[height<=720]", "MP4 · 720p", 720, False),
        ("bestvideo[height<=480]+bestaudio/best[height<=480]", "MP4 · 480p", 480, False),
        ("bestvideo[height<=360]+bestaudio/best[height<=360]", "MP4 · 360p", 360, False),
        ("bestaudio", "M4A · только аудио", 0, False),
    ]
    result = []
    for fmt_id, label, height, recommended in presets:
        result.append({
            "format_id": fmt_id,
            "label": label,
            "ext": "mp4" if fmt_id != "bestaudio" else "m4a",
            "resolution": f"{height}p" if height else "—",
            "filesize": "—",
            "has_video": fmt_id != "bestaudio",
            "has_audio": True,
            "quality": height,
            "height": height,
            "recommended": recommended,
        })
    return result


def merge_infos(infos: list[dict]) -> dict:
    best = max(
        infos,
        key=lambda i: (count_useful_formats(i), len(i.get("title") or "")),
    )
    merged = dict(best)
    fmt_map: dict[str, dict] = {}
    for info in infos:
        for fmt in info.get("formats", []):
            fid = fmt.get("format_id")
            if fid and is_useful_format(fmt):
                fmt_map[str(fid)] = fmt
    merged["formats"] = list(fmt_map.values())
    return merged


def build_format_list(info: dict, source_url: str = "") -> list[dict]:
    formats = []
    seen_ids: set[str] = set()
    seen_labels: set[str] = set()

    for fmt in info.get("formats", []):
        if not is_useful_format(fmt):
            continue

        fmt_id = str(fmt.get("format_id", ""))
        if not fmt_id or fmt_id in seen_ids:
            continue
        seen_ids.add(fmt_id)

        has_video = fmt.get("vcodec") != "none"
        has_audio = fmt.get("acodec") != "none"
        label = get_format_label(fmt)
        if label in seen_labels:
            label = f"{label} · #{fmt_id}"
        seen_labels.add(label)

        formats.append({
            "format_id": fmt_id,
            "label": label,
            "ext": fmt.get("ext", "mp4"),
            "resolution": fmt.get("resolution") or (f"{fmt.get('height')}p" if fmt.get("height") else "—"),
            "filesize": format_size(fmt.get("filesize") or fmt.get("filesize_approx")),
            "has_video": has_video,
            "has_audio": has_audio,
            "quality": fmt.get("quality") or 0,
            "height": fmt.get("height") or 0,
            "recommended": has_video and has_audio,
        })

    if is_youtube_info(info, source_url):
        competitor = youtube_competitor_formats(info)
        seen_ids = {f["format_id"] for f in competitor}

        real_progressive = [
            f for f in formats
            if f["has_video"] and f["has_audio"] and f["filesize"] != "—"
        ]
        real_progressive.sort(key=lambda f: (f["height"], f["quality"]), reverse=True)

        for item in real_progressive:
            height = item["height"]
            if height and f"q:{height}" in seen_ids:
                for preset in competitor:
                    if preset["format_id"] == f"q:{height}" and preset["filesize"] == "—":
                        preset["filesize"] = item["filesize"]
                        preset["format_id"] = item["format_id"]
                        preset["label"] = f"MP4 · {height}p"
                        seen_ids.add(item["format_id"])
                        break
                continue
            if item["format_id"] not in seen_ids:
                entry = dict(item)
                entry["recommended"] = False
                competitor.append(entry)
                seen_ids.add(entry["format_id"])

        audio_id = pick_audio_format(info)
        if audio_id:
            for preset in competitor:
                if preset.get("label", "").startswith("MP3"):
                    preset["format_id"] = audio_id
                    for fmt in info.get("formats", []):
                        if str(fmt.get("format_id")) == audio_id:
                            preset["filesize"] = format_size(
                                fmt.get("filesize") or fmt.get("filesize_approx")
                            )
                            break
                    break

        formats = competitor

    formats.sort(
        key=lambda f: (f["recommended"], f["has_video"], f["has_audio"], f["height"], f["quality"]),
        reverse=True,
    )

    if not is_youtube_info(info, source_url):
        real_ids = {
            f["format_id"]
            for f in formats
            if f["filesize"] != "—" and not re.search(r"[\[\+\*/]", f["format_id"])
        }
        if real_ids:
            for f in formats:
                if re.search(r"[\[\+\*/]", f["format_id"]) or f["format_id"] in ("bv*+ba/b", "b", "bestaudio", "worst"):
                    f["recommended"] = False
            for f in formats:
                if f["format_id"] in real_ids and f["has_video"] and f["has_audio"]:
                    f["recommended"] = True
                    break

    return formats


def build_ytdl_opts(
    extra: Optional[dict] = None,
    browser: Optional[str] = None,
    use_cookies: bool = True,
    cookiefile: Optional[str] = None,
    player_clients: Optional[list[str]] = None,
) -> dict:
    clients = player_clients or default_youtube_clients(
        with_cookies=bool(cookiefile and Path(cookiefile).is_file())
    )
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "nocheckcertificate": True,
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 5,
        "extractor_args": {
            "youtube": {
                "player_client": clients,
            }
        },
    }
    if extra:
        opts.update(extra)

    if not use_cookies:
        return opts

    if cookiefile and Path(cookiefile).is_file():
        opts["cookiefile"] = cookiefile
        return opts

    cookies_file = os.environ.get("YTDLP_COOKIES_FILE", "").strip()
    if not cookies_file and COOKIES_FILE.is_file():
        cookies_file = str(COOKIES_FILE)

    if cookies_file and Path(cookies_file).is_file():
        opts["cookiefile"] = cookies_file
        return opts

    if IS_RENDER:
        return opts

    if browser:
        opts["cookiesfrombrowser"] = (browser,)
    else:
        browser_env = os.environ.get("YTDLP_COOKIES_BROWSER", "").strip()
        if browser_env:
            opts["cookiesfrombrowser"] = (browser_env,)
        else:
            opts["cookiesfrombrowser"] = ("chrome",)

    return opts


def cookie_browser_fallbacks() -> list[str]:
    env = os.environ.get("YTDLP_COOKIES_BROWSER", "").strip()
    if env:
        return [b.strip() for b in env.split(",") if b.strip()]
    return ["chrome", "safari", "firefox", "brave", "edge"]


def count_useful_formats(info: dict) -> int:
    return len([f for f in info.get("formats", []) if is_useful_format(f)])


def is_valid_info(info: dict) -> bool:
    return bool(info.get("title")) or count_useful_formats(info) > 0


def fallback_formats() -> list[dict]:
    return youtube_competitor_formats({"formats": []})


def build_extract_attempts(
    user_cookie_path: Optional[str],
    fast: bool,
    cookies_only: bool = False,
) -> list[tuple[Optional[str], Optional[str], bool, Optional[list[str]]]]:
    if user_cookie_path and cookies_only:
        client_sets = [
            ["web", "tv"],
            ["tv", "web"],
            ["tv_embedded", "web"],
            ["web"],
            ["android_vr"],
            ["ios", "android"],
        ]
        return [(user_cookie_path, None, True, clients) for clients in client_sets]

    client_sets = (
        [["web", "tv"], ["android_vr"], ["tv"], ["ios"]]
        if fast and user_cookie_path
        else (
            [["android_vr"], ["tv"], ["ios"], ["android"]]
            if fast
            else [
                ["web", "tv"],
                ["android_vr"],
                ["tv"],
                ["tv_embedded"],
                ["ios"],
                ["android"],
                ["mweb"],
                ["ios", "android"],
                None,
            ]
        )
    )

    attempts: list[tuple[Optional[str], Optional[str], bool, Optional[list[str]]]] = []

    if user_cookie_path:
        for clients in client_sets:
            attempts.append((user_cookie_path, None, True, clients))

    if not cookies_only:
        for clients in client_sets:
            if not user_cookie_path:
                attempts.append((None, None, True, clients))
            attempts.append((None, None, False, clients))

        if not IS_RENDER and not user_cookie_path:
            for browser in cookie_browser_fallbacks()[:2]:
                attempts.append((None, browser, True, None))

    return attempts


def ytdl_extract(
    url: str,
    extra: Optional[dict] = None,
    download: bool = False,
    user_cookies: Optional[str] = None,
    fast: bool = False,
) -> dict:
    base_extra = dict(extra or {})
    if not download:
        base_extra.setdefault("skip_download", True)
        base_extra.setdefault("ignore_no_formats_error", True)
    base_extra.setdefault("extract_flat", False)

    with temp_cookie_file(user_cookies) as user_cookie_path:
        use_user_only = bool(download and user_cookies and user_cookies.strip())
        attempts = build_extract_attempts(
            user_cookie_path,
            fast=fast or not download,
            cookies_only=use_user_only,
        )
        collected: list[dict] = []
        last_error: Optional[Exception] = None

        for cookiefile, browser, use_cookies, clients in attempts:
            try:
                opts = build_ytdl_opts(
                    base_extra,
                    browser=browser,
                    use_cookies=use_cookies,
                    cookiefile=cookiefile,
                    player_clients=clients,
                )
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=download)
                if not is_valid_info(info):
                    continue
                if fast or not download:
                    return info
                collected.append(info)
            except yt_dlp.utils.DownloadError as e:
                last_error = e
                if is_retryable_ytdl_error(e):
                    continue
                raise

        if download and user_cookie_path and use_user_only and last_error:
            relaxed = build_extract_attempts(user_cookie_path, fast=False, cookies_only=False)
            for cookiefile, browser, use_cookies, clients in relaxed:
                if not cookiefile:
                    continue
                try:
                    opts = build_ytdl_opts(
                        base_extra,
                        browser=browser,
                        use_cookies=use_cookies,
                        cookiefile=cookiefile,
                        player_clients=clients,
                    )
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        info = ydl.extract_info(url, download=download)
                    if not is_valid_info(info):
                        continue
                    collected.append(info)
                except yt_dlp.utils.DownloadError as e:
                    last_error = e
                    if is_retryable_ytdl_error(e):
                        continue
                    raise

        if collected:
            return merge_infos(collected)

        if last_error:
            raise last_error
        raise yt_dlp.utils.DownloadError("Не удалось получить видео")


YOUTUBE_COOKIE_HINT = (
    "YouTube временно недоступен. Попробуйте «Авто» или повторите через минуту."
)

YOUTUBE_COOKIE_STALE_HINT = (
    "Cookies устарели. Откройте youtube.com в Chrome, обновите страницу (F5) "
    "и нажмите «Скачать» снова."
)


def has_user_cookies(cookies: Optional[str]) -> bool:
    return bool(cookies and cookies.strip() and "youtube" in cookies.lower())


def friendly_ytdl_error(err: Exception, had_user_cookies: bool = False) -> str:
    msg = str(err).lower()
    if "drm" in msg:
        return "Это видео защищено DRM — скачать его нельзя."
    if is_format_unavailable_error(err):
        return "Не удалось скачать в выбранном качестве. Обновите youtube.com (F5) и выберите «Скачать видео (рекомендуется)»."
    if is_bot_ytdl_error(err):
        return YOUTUBE_COOKIE_STALE_HINT if had_user_cookies else YOUTUBE_COOKIE_HINT
    msg = str(err)
    if "player response" in msg.lower():
        return YOUTUBE_COOKIE_STALE_HINT if had_user_cookies else YOUTUBE_COOKIE_HINT
    if msg.startswith("ERROR:"):
        msg = msg.split(":", 1)[1].strip()
    return msg[:300]


def is_bot_error(err: Exception) -> bool:
    return is_bot_ytdl_error(err)


def is_useful_format(fmt: dict) -> bool:
    if fmt.get("format_id") == "storyboard":
        return False
    if fmt.get("format_id", "").startswith("sb"):
        return False
    if fmt.get("vcodec") == "none" and fmt.get("acodec") == "none":
        return False
    return bool(fmt.get("format_id"))


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/api/ping")
async def ping():
    return {
        "ok": True,
        "mode": "render" if IS_RENDER else ("vps" if os.environ.get("PUBLIC_URL") else "local"),
        "is_render": IS_RENDER,
        "public_url": PUBLIC_URL,
    }


@app.get("/api/config")
async def get_config():
    return {
        "apiUrl": PUBLIC_URL or None,
        "isProduction": bool(PUBLIC_URL),
    }


class YoutubeStreamRequest(BaseModel):
    url: str
    format_id: str


@app.post("/api/youtube/stream")
async def youtube_stream_url(req: YoutubeStreamRequest):
    url = youtube_innertube.normalize_url(req.url.strip())
    video_id = youtube_innertube.extract_youtube_id(url)
    if not video_id:
        raise HTTPException(400, "Неверная ссылка YouTube")

    try:
        player = await asyncio.wait_for(
            asyncio.to_thread(youtube_innertube.fetch_innertube_player, video_id),
            timeout=20.0 if IS_RENDER else 45.0,
        )
        title = sanitize_filename((player.get("videoDetails") or {}).get("title") or "video")
        stream = youtube_innertube.pick_innertube_stream(video_id, req.format_id)
        ext = stream["ext"] if str(stream["ext"]).startswith(".") else f".{stream['ext']}"
        return {
            "url": stream["url"],
            "filename": f"{title}{ext}",
            "note": stream.get("note"),
        }
    except asyncio.TimeoutError:
        raise HTTPException(504, "YouTube отвечает слишком долго. Попробуйте через минуту.")
    except Exception as e:
        raise HTTPException(400, str(e)[:300])


@app.get("/")
async def root():
    return FileResponse(
        STATIC_DIR / "index.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/terms")
async def terms_page():
    return FileResponse(
        STATIC_DIR / "terms.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/privacy")
async def privacy_page():
    return FileResponse(
        STATIC_DIR / "privacy.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/api/extension/download")
async def download_extension():
    if not EXTENSION_DIR.exists():
        raise HTTPException(404, "Папка расширения не найдена")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in EXTENSION_DIR.rglob("*"):
            if file.is_file():
                arcname = file.relative_to(EXTENSION_DIR.parent)
                zf.write(file, arcname)

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="kaktus-zagruzka-extension.zip"'},
    )


@app.post("/api/analyze")
async def analyze_video(req: AnalyzeRequest):
    url = youtube_innertube.normalize_url(req.url.strip())
    if not url:
        raise HTTPException(400, "Вставьте ссылку на видео")

    if is_youtube_url(url):
        had_cookies = has_user_cookies(req.cookies)
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(youtube_innertube.innertube_analyze, url, req.cookies),
                timeout=20.0 if IS_RENDER else 45.0,
            )
        except asyncio.TimeoutError:
            raise HTTPException(
                504,
                "YouTube отвечает слишком долго. Подождите минуту и нажмите «Найти форматы» снова.",
            )
        except ValueError as e:
            msg = str(e)
            if "Неверная ссылка" in msg:
                raise HTTPException(400, msg)
            if "429" in msg or "ограничил запросы" in msg:
                raise HTTPException(429, msg)
        except Exception:
            pass

        try:
            ytdl_extra = {"socket_timeout": 12, "retries": 1, "fragment_retries": 1} if IS_RENDER else None
            info = await asyncio.wait_for(
                asyncio.to_thread(ytdl_extract, url, ytdl_extra, False, req.cookies, True),
                timeout=18.0 if IS_RENDER else 35.0,
            )
            if info and (info.get("title") or count_useful_formats(info)):
                if info.get("_type") == "playlist":
                    entries = info.get("entries", [])
                    if entries:
                        info = entries[0] or info
                formats = build_format_list(info, source_url=url)
                if not formats and info.get("title"):
                    formats = youtube_simple_formats()
                if formats:
                    return {
                        "title": info.get("title", "Без названия"),
                        "thumbnail": pick_thumbnail(info),
                        "video_id": info.get("id"),
                        "duration": format_duration(info.get("duration")),
                        "uploader": info.get("uploader") or info.get("channel") or "—",
                        "platform": "YouTube",
                        "formats": formats,
                        "formats_estimated": count_useful_formats(info) == 0,
                        "needs_cookies": not had_cookies,
                    }
        except Exception:
            pass

        if IS_RENDER:
            raise HTTPException(
                503,
                "YouTube блокирует облачный сервер. Установите расширение Chrome — "
                "оно скачивает с вашего ПК (как SaveFrom Helper). "
                "VK, TikTok и другие платформы работают без расширения.",
            )

    info = None
    had_cookies = has_user_cookies(req.cookies)
    try:
        info = ytdl_extract(
            url,
            download=False,
            user_cookies=req.cookies,
            fast=not had_cookies,
        )
    except yt_dlp.utils.DownloadError as e:
        if is_youtube_url(url) and not had_cookies:
            try:
                info = youtube_stub_info(url)
            except ValueError:
                pass
        if info is None:
            raise HTTPException(400, f"Не удалось получить видео: {friendly_ytdl_error(e, had_cookies)}")
    except Exception:
        if is_youtube_url(url) and not had_cookies:
            try:
                info = youtube_stub_info(url)
            except ValueError:
                pass
        if info is None:
            raise HTTPException(400, "Не удалось получить видео. Проверьте ссылку.")

    if not info.get("title") and not count_useful_formats(info):
        raise HTTPException(400, "Видео не найдено. Проверьте ссылку.")

    if info.get("_type") == "playlist":
        entries = info.get("entries", [])
        if not entries:
            raise HTTPException(400, "Плейлист пуст")
        info = entries[0]
        if info is None:
            raise HTTPException(400, "Не удалось получить первое видео из плейлиста")

    formats = build_format_list(info, source_url=url)

    if not formats and info.get("title"):
        formats = youtube_simple_formats() if is_youtube_url(url) else fallback_formats()

    if not formats:
        raise HTTPException(400, "Доступные форматы не найдены. Проверьте ссылку на видео.")

    video_id = info.get("id")
    thumbnail = pick_thumbnail(info)

    return {
        "title": info.get("title", "Без названия"),
        "thumbnail": thumbnail,
        "video_id": video_id,
        "duration": format_duration(info.get("duration")),
        "uploader": info.get("uploader") or info.get("channel") or "—",
        "platform": info.get("extractor_key", "—"),
        "formats": formats,
        "formats_estimated": is_youtube_url(url) and count_useful_formats(info) == 0,
        "needs_cookies": is_youtube_url(url) and not had_cookies,
    }


@app.post("/api/download/prepare")
async def prepare_download(req: DownloadRequest):
    url = youtube_innertube.normalize_url(req.url.strip())
    if not url or not req.format_id:
        raise HTTPException(400, "Укажите ссылку и формат")

    if is_youtube_url(url) and IS_RENDER and not has_user_cookies(req.cookies):
        pass

    token = store_download_token(url, req.format_id, req.cookies)
    asyncio.create_task(process_download_job(token))
    return {"token": token, "url": f"/api/download/token/{token}"}


@app.get("/api/download/status/{token}")
async def download_status(token: str):
    job = get_download_job(token)
    if not job:
        raise HTTPException(404, "Ссылка устарела. Нажмите «Скачать» снова.")
    return {
        "status": job["status"],
        "error": job.get("error"),
        "filename": job.get("filename"),
        "message": job.get("message"),
    }


@app.get("/api/download/token/{token}")
async def download_by_token(token: str):
    job = get_download_job(token)
    if not job:
        raise HTTPException(404, "Ссылка устарела. Нажмите «Скачать» снова.")
    if job["status"] == "error":
        raise HTTPException(400, job.get("error") or "Ошибка скачивания")
    if job["status"] != "ready" or not job.get("file_path"):
        raise HTTPException(425, "Файл ещё готовится. Подождите немного.")

    tmp_dir = Path(job["tmp_dir"]) if job.get("tmp_dir") else None
    return FileResponse(
        job["file_path"],
        media_type="video/mp4",
        filename=job["filename"] or "video.mp4",
        background=_cleanup(tmp_dir) if tmp_dir else None,
    )


@app.post("/api/download")
async def download_video_post(req: DownloadRequest):
    return await _do_download(req.url, req.format_id, req.cookies)


@app.get("/api/download")
async def download_video_get(
    url: str = Query(...),
    format_id: str = Query(...),
):
    return await _do_download(url, format_id, None)


def _download_to_file_sync(
    url: str,
    format_id: str,
    cookies: Optional[str],
    tmp_dir: Path,
) -> tuple[str, str]:
    extra = {
        "format": format_id,
        "outtmpl": str(tmp_dir / "%(title)s.%(ext)s"),
        "merge_output_format": "mp4",
        "concurrent_fragment_downloads": 4,
        "socket_timeout": 60,
        "format_sort": ["res", "codec:h264", "ext:mp4:m4a", "size"],
    }

    info = ytdl_extract(url, extra=extra, download=True, user_cookies=cookies)

    with yt_dlp.YoutubeDL(build_ytdl_opts(extra, use_cookies=False)) as ydl:
        filename = ydl.prepare_filename(info)

    if not os.path.exists(filename):
        for f in tmp_dir.iterdir():
            if f.is_file():
                filename = str(f)
                break

    if not os.path.exists(filename):
        raise yt_dlp.utils.DownloadError("Файл не был создан")

    title = sanitize_filename(info.get("title", "video"))
    ext = Path(filename).suffix or ".mp4"
    safe_name = f"{title}{ext}"
    return filename, safe_name


def _innertube_download_sync(url: str, format_id: str, tmp_dir: Path) -> tuple[str, str]:
    video_id = youtube_innertube.extract_youtube_id(url)
    if not video_id:
        raise ValueError("Неверная ссылка YouTube")

    player = youtube_innertube.fetch_innertube_player(video_id)
    title = sanitize_filename((player.get("videoDetails") or {}).get("title") or "video")
    stream = youtube_innertube.pick_innertube_stream(video_id, format_id)
    ext = stream["ext"] if str(stream["ext"]).startswith(".") else f".{stream['ext']}"
    safe_name = f"{title}{ext}"
    dest = tmp_dir / safe_name
    youtube_innertube.innertube_download_to_path(video_id, format_id, str(dest))
    return str(dest), safe_name


def _download_to_file_with_fallbacks(
    url: str,
    format_id: str,
    cookies: Optional[str],
    tmp_dir: Path,
) -> tuple[str, str]:
    if is_youtube_url(url):
        try:
            return _innertube_download_sync(url, format_id, tmp_dir)
        except Exception as e:
            for f in tmp_dir.iterdir():
                if f.is_file():
                    f.unlink()
            if IS_RENDER or not has_user_cookies(cookies):
                raise yt_dlp.utils.DownloadError(str(e)[:300])

    attempts = build_download_format_attempts(format_id, url, cookies)
    last_error: Optional[Exception] = None

    for fmt_attempt in attempts:
        try:
            for f in tmp_dir.iterdir():
                if f.is_file():
                    f.unlink()
            return _download_to_file_sync(url, fmt_attempt, cookies, tmp_dir)
        except yt_dlp.utils.DownloadError as e:
            last_error = e
            continue

    if last_error:
        raise last_error
    raise yt_dlp.utils.DownloadError("Не удалось скачать видео")


async def process_download_job(token: str) -> None:
    job = DOWNLOAD_TOKENS.get(token)
    if not job or job["status"] != "pending":
        return

    job["status"] = "processing"
    job["message"] = "Готовим файл..."
    tmp_dir = DOWNLOADS_DIR / token
    tmp_dir.mkdir(parents=True, exist_ok=True)
    job["tmp_dir"] = str(tmp_dir)

    url = job["url"]
    cookies = job.get("cookies")
    selected_format = job["format_id"]

    try:
        file_path, safe_name = await asyncio.wait_for(
            asyncio.to_thread(
                _download_to_file_with_fallbacks,
                url,
                selected_format,
                cookies,
                tmp_dir,
            ),
            timeout=900,
        )
        job["file_path"] = file_path
        job["filename"] = safe_name
        job["status"] = "ready"
        job["message"] = "Файл готов"
    except asyncio.TimeoutError:
        job["status"] = "error"
        job["error"] = "Слишком долго. Выберите «Авто» и попробуйте снова."
        shutil.rmtree(tmp_dir, ignore_errors=True)
    except yt_dlp.utils.DownloadError as e:
        job["status"] = "error"
        job["error"] = f"Ошибка скачивания: {friendly_ytdl_error(e, has_user_cookies(cookies))}"
        shutil.rmtree(tmp_dir, ignore_errors=True)
    except Exception as e:
        job["status"] = "error"
        job["error"] = f"Ошибка: {str(e)[:200]}"
        shutil.rmtree(tmp_dir, ignore_errors=True)


async def _do_download_once(
    url: str,
    format_id: str,
    cookies: Optional[str],
    tmp_dir: Path,
) -> FileResponse:
    file_path, safe_name = await asyncio.to_thread(
        _download_to_file_with_fallbacks,
        url,
        format_id,
        cookies,
        tmp_dir,
    )

    return FileResponse(
        file_path,
        media_type="video/mp4",
        filename=safe_name,
        background=_cleanup(tmp_dir),
    )


async def _do_download(url: str, format_id: str, cookies: Optional[str]):
    url = youtube_innertube.normalize_url(url.strip())
    if not url or not format_id:
        raise HTTPException(400, "Укажите ссылку и формат")

    if is_youtube_url(url) and IS_RENDER and not has_user_cookies(cookies):
        pass

    job_id = str(uuid.uuid4())
    tmp_dir = DOWNLOADS_DIR / job_id
    tmp_dir.mkdir(parents=True)

    try:
        return await _do_download_once(url, format_id, cookies, tmp_dir)
    except yt_dlp.utils.DownloadError as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(
            400,
            f"Ошибка скачивания: {friendly_ytdl_error(e, has_user_cookies(cookies))}",
        )
    except HTTPException:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(500, f"Ошибка: {str(e)}")


def _cleanup(path: Path):
    def cleanup():
        shutil.rmtree(path, ignore_errors=True)
    return cleanup
