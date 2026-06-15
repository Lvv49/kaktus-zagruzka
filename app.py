import os
import re
import shutil
import tempfile
import uuid
import zipfile
import io
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

PUBLIC_URL = (
    os.environ.get("PUBLIC_URL")
    or os.environ.get("RENDER_EXTERNAL_URL", "")
).rstrip("/")

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

    return " · ".join(parts)


def is_useful_format(fmt: dict) -> bool:
    if fmt.get("format_id") == "storyboard":
        return False
    if fmt.get("vcodec") == "none" and fmt.get("acodec") == "none":
        return False
    if fmt.get("url") is None and fmt.get("manifest_url") is None:
        return False
    return True


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

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": False,
        "nocheckcertificate": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        raise HTTPException(400, f"Не удалось получить видео: {str(e)}")
    except Exception as e:
        raise HTTPException(500, f"Ошибка сервера: {str(e)}")

    if info.get("_type") == "playlist":
        entries = info.get("entries", [])
        if not entries:
            raise HTTPException(400, "Плейлист пуст")
        info = entries[0]
        if info is None:
            raise HTTPException(400, "Не удалось получить первое видео из плейлиста")

    formats = []
    seen_labels = set()
    for fmt in info.get("formats", []):
        if not is_useful_format(fmt):
            continue

        has_video = fmt.get("vcodec") != "none"
        has_audio = fmt.get("acodec") != "none"
        label = get_format_label(fmt)

        if label in seen_labels:
            continue
        seen_labels.add(label)

        formats.append({
            "format_id": fmt.get("format_id"),
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

    formats.sort(
        key=lambda f: (f["recommended"], f["has_video"], f["has_audio"], f["height"], f["quality"]),
        reverse=True,
    )

    if not formats:
        raise HTTPException(400, "Доступные форматы не найдены")

    return {
        "title": info.get("title", "Без названия"),
        "thumbnail": info.get("thumbnail"),
        "duration": format_duration(info.get("duration")),
        "uploader": info.get("uploader") or info.get("channel") or "—",
        "platform": info.get("extractor_key", "—"),
        "formats": formats,
    }


@app.get("/api/download")
async def download_video(
    url: str = Query(...),
    format_id: str = Query(...),
):
    url = url.strip()
    if not url or not format_id:
        raise HTTPException(400, "Укажите ссылку и формат")

    job_id = str(uuid.uuid4())
    tmp_dir = DOWNLOADS_DIR / job_id
    tmp_dir.mkdir(parents=True)

    ydl_opts = {
        "format": format_id,
        "outtmpl": str(tmp_dir / "%(title)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "nocheckcertificate": True,
        "merge_output_format": "mp4",
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
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
