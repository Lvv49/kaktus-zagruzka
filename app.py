import os
import re
import shutil
import tempfile
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
        ("bestvideo+bestaudio/best", "MP4 · лучшее качество", 99999, True),
        ("bestvideo[height<=2160]+bestaudio/best[height<=2160]", "MP4 · 4K", 2160, False),
        ("bestvideo[height<=1440]+bestaudio/best[height<=1440]", "MP4 · 1440p", 1440, False),
        ("bestvideo[height<=1080]+bestaudio/best[height<=1080]", "MP4 · 1080p", 1080, False),
        ("bestvideo[height<=720]+bestaudio/best[height<=720]", "MP4 · 720p", 720, False),
        ("bestvideo[height<=480]+bestaudio/best[height<=480]", "MP4 · 480p", 480, False),
        ("bestvideo[height<=360]+bestaudio/best[height<=360]", "MP4 · 360p", 360, False),
        ("bestvideo[height<=240]+bestaudio/best[height<=240]", "MP4 · 240p", 240, False),
        ("bestaudio", "M4A · только аудио", 0, False),
        ("worst", "MP4 · минимальный размер", 1, False),
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
        existing_heights = {f["height"] for f in formats if f.get("height")}
        for preset in youtube_quality_presets():
            if preset["format_id"] in seen_ids:
                continue
            if preset["height"] and preset["height"] in existing_heights and preset["height"] < 99999:
                continue
            formats.append(preset)
            seen_ids.add(preset["format_id"])

    formats.sort(
        key=lambda f: (f["recommended"], f["has_video"], f["has_audio"], f["height"], f["quality"]),
        reverse=True,
    )
    return formats


def build_ytdl_opts(
    extra: Optional[dict] = None,
    browser: Optional[str] = None,
    use_cookies: bool = True,
    cookiefile: Optional[str] = None,
    player_clients: Optional[list[str]] = None,
) -> dict:
    clients = player_clients or (
        ["ios", "android", "mweb", "web", "tv_embedded", "web_creator"]
        if IS_RENDER
        else ["ios", "android", "mweb", "web", "tv_embedded"]
    )
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "nocheckcertificate": True,
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
    return [
        {
            "format_id": "bv*+ba/b",
            "label": "MP4 · лучшее качество",
            "ext": "mp4",
            "resolution": "—",
            "filesize": "—",
            "has_video": True,
            "has_audio": True,
            "quality": 9999,
            "height": 0,
            "recommended": True,
        },
        {
            "format_id": "b",
            "label": "MP4 · хорошее качество",
            "ext": "mp4",
            "resolution": "—",
            "filesize": "—",
            "has_video": True,
            "has_audio": True,
            "quality": 5000,
            "height": 0,
            "recommended": False,
        },
    ]


def ytdl_extract(
    url: str,
    extra: Optional[dict] = None,
    download: bool = False,
    user_cookies: Optional[str] = None,
) -> dict:
    base_extra = dict(extra or {})
    if not download:
        base_extra.setdefault("skip_download", True)
        base_extra.setdefault("ignore_no_formats_error", True)
    base_extra.setdefault("extract_flat", False)

    client_sets = [
        None,
        ["ios", "android"],
        ["mweb", "web_creator"],
        ["tv_embedded", "web"],
    ]

    with temp_cookie_file(user_cookies) as user_cookie_path:
        attempts: list[tuple[Optional[str], Optional[str], bool, Optional[list[str]]]] = []

        for clients in client_sets:
            attempts.append((None, None, False, clients))
            if user_cookie_path:
                attempts.append((user_cookie_path, None, True, clients))

        if not user_cookie_path and not IS_RENDER:
            for browser in cookie_browser_fallbacks():
                attempts.append((None, browser, True, None))

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
                collected.append(info)
            except yt_dlp.utils.DownloadError as e:
                last_error = e
                err = str(e).lower()
                if any(
                    word in err
                    for word in ("bot", "sign in", "cookies", "operation not permitted", "could not copy")
                ):
                    continue
                raise

        if collected:
            return merge_infos(collected)

        if last_error:
            raise last_error
        raise yt_dlp.utils.DownloadError("Не удалось получить видео")


YOUTUBE_COOKIE_HINT = (
    "YouTube заблокировал запрос. Проверьте ссылку или попробуйте позже."
)


def is_useful_format(fmt: dict) -> bool:
    if fmt.get("format_id") == "storyboard":
        return False
    if fmt.get("format_id", "").startswith("sb"):
        return False
    if fmt.get("vcodec") == "none" and fmt.get("acodec") == "none":
        return False
    return bool(fmt.get("format_id"))


@app.get("/api/config")
async def get_config():
    return {
        "apiUrl": PUBLIC_URL or None,
        "isProduction": bool(PUBLIC_URL),
    }


@app.get("/")
async def root():
    return FileResponse(STATIC_DIR / "index.html")


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
    url = req.url.strip()
    if not url:
        raise HTTPException(400, "Вставьте ссылку на видео")

    try:
        info = ytdl_extract(url, download=False, user_cookies=req.cookies)
    except yt_dlp.utils.DownloadError as e:
        msg = str(e)
        if "bot" in msg.lower() or "sign in" in msg.lower():
            msg = YOUTUBE_COOKIE_HINT
        raise HTTPException(400, f"Не удалось получить видео: {msg}")
    except Exception as e:
        raise HTTPException(500, f"Ошибка сервера: {str(e)}")

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
        formats = youtube_quality_presets() if is_youtube_url(url) else fallback_formats()

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
    }


@app.post("/api/download")
async def download_video_post(req: DownloadRequest):
    return await _do_download(req.url, req.format_id, req.cookies)


@app.get("/api/download")
async def download_video_get(
    url: str = Query(...),
    format_id: str = Query(...),
):
    return await _do_download(url, format_id, None)


async def _do_download(url: str, format_id: str, cookies: Optional[str]):
    url = url.strip()
    if not url or not format_id:
        raise HTTPException(400, "Укажите ссылку и формат")

    job_id = str(uuid.uuid4())
    tmp_dir = DOWNLOADS_DIR / job_id
    tmp_dir.mkdir(parents=True)

    extra = {
        "format": format_id,
        "outtmpl": str(tmp_dir / "%(title)s.%(ext)s"),
        "merge_output_format": "mp4",
    }

    try:
        info = ytdl_extract(url, extra=extra, download=True, user_cookies=cookies)

        with yt_dlp.YoutubeDL(build_ytdl_opts(extra, use_cookies=False)) as ydl:
            filename = ydl.prepare_filename(info)

        if not os.path.exists(filename):
            for f in tmp_dir.iterdir():
                if f.is_file():
                    filename = str(f)
                    break

        if not os.path.exists(filename):
            raise HTTPException(500, "Файл не был создан")

        title = sanitize_filename(info.get("title", "video"))
        ext = Path(filename).suffix or ".mp4"
        safe_name = f"{title}{ext}"

        return FileResponse(
            filename,
            media_type="application/octet-stream",
            filename=safe_name,
            background=_cleanup(tmp_dir),
        )
    except yt_dlp.utils.DownloadError as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(400, f"Ошибка скачивания: {str(e)}")
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
