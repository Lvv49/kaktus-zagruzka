import json
import re
import ssl
import time
import urllib.error
import urllib.request
from typing import Any, Optional

WEB_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
IOS_UA = "com.google.ios.youtube/20.10.3 (iPhone16,2; U; CPU iOS 18_0 like Mac OS X)"
ANDROID_VR_UA = "com.google.android.apps.youtube.vr.oculus/1.49.10 (Linux; U; Android 12L)"
FALLBACK_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHL6lhmF_0cBqnWkbc"

PLAYER_CACHE: dict[str, dict[str, Any]] = {}
API_KEY_CACHE: dict[str, Any] = {"key": None, "ts": 0}
CACHE_TTL = 600
API_KEY_TTL = 3600

_SSL_CTX = ssl.create_default_context()
try:
    import certifi

    _SSL_CTX.load_verify_locations(certifi.where())
except Exception:
    _SSL_CTX.check_hostname = False
    _SSL_CTX.verify_mode = ssl.CERT_NONE


def normalize_url(url: str) -> str:
    u = (url or "").strip().rstrip("\\")
    if u.startswith("//"):
        u = f"https:{u}"
    if re.match(r"^www\.", u, re.I):
        u = f"https://{u}"
    return u


def extract_youtube_id(url: str) -> Optional[str]:
    url = normalize_url(url)
    patterns = [
        r"(?:v=|/embed/|/v/|/shorts/|youtu\.be/)([\w-]{11})",
        r"^([\w-]{11})$",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def _cache_player(video_id: str, player: dict) -> None:
    PLAYER_CACHE[video_id] = {"player": player, "ts": time.time()}


def get_cached_player(video_id: str) -> Optional[dict]:
    entry = PLAYER_CACHE.get(video_id)
    if not entry or time.time() - entry["ts"] > CACHE_TTL:
        return None
    return entry["player"]


def _urlopen(req: urllib.request.Request, timeout: int = 30):
    return urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX)


def get_innertube_api_key() -> str:
    if API_KEY_CACHE["key"] and time.time() - API_KEY_CACHE["ts"] < API_KEY_TTL:
        return API_KEY_CACHE["key"]

    req = urllib.request.Request(
        "https://www.youtube.com/",
        headers={"User-Agent": WEB_UA, "Accept-Language": "en-US,en;q=0.9"},
    )
    try:
        with _urlopen(req, timeout=20) as resp:
            html = resp.read().decode("utf-8", errors="replace")
        match = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
        key = match.group(1) if match else FALLBACK_API_KEY
    except Exception:
        key = FALLBACK_API_KEY

    API_KEY_CACHE["key"] = key
    API_KEY_CACHE["ts"] = time.time()
    return key


def _resolve_format_url(fmt: dict) -> Optional[str]:
    if fmt.get("url"):
        return fmt["url"]
    cipher = fmt.get("signatureCipher") or fmt.get("cipher")
    if not cipher:
        return None
    params: dict[str, str] = {}
    for part in cipher.split("&"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        params[key] = urllib.request.unquote(value.replace("+", " "))
    if not params.get("url") or params.get("s"):
        return None
    url = params["url"]
    if params.get("sig") and params.get("sp"):
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}{params['sp']}={urllib.request.quote(params['sig'])}"
    return url


def _parse_formats(player: dict) -> tuple[list[dict], list[dict]]:
    streaming = player.get("streamingData") or {}
    progressive = []
    adaptive = []
    for fmt in streaming.get("formats") or []:
        url = _resolve_format_url(fmt)
        if url:
            progressive.append({**fmt, "url": url})
    for fmt in streaming.get("adaptiveFormats") or []:
        url = _resolve_format_url(fmt)
        if url:
            adaptive.append({**fmt, "url": url})
    return progressive, adaptive


def _player_is_usable(player: dict) -> bool:
    if not player or not player.get("streamingData"):
        return False
    progressive, adaptive = _parse_formats(player)
    return bool(progressive or adaptive)


def _parse_json_after_marker(html: str, marker: str) -> Optional[dict]:
    idx = html.find(marker)
    if idx < 0:
        return None
    start = html.find("{", idx)
    if start < 0:
        return None

    depth = 0
    in_string = False
    escaped = False

    for i in range(start, len(html)):
        ch = html[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(html[start : i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _is_skippable_error(reason: str) -> bool:
    text = (reason or "").lower()
    return any(
        phrase in text
        for phrase in (
            "no longer supported",
            "не поддерживается",
            "application or device",
            "приложении или на этом устройстве",
            "page needs to be reloaded",
        )
    )


def _innertube_request(video_id: str, client: dict) -> dict:
    api_key = get_innertube_api_key()
    body = json.dumps({
        "context": {
            "client": {**client["context"], "hl": "en", "gl": "US"},
            "user": {},
        },
        "videoId": video_id,
    }).encode()
    req = urllib.request.Request(
        f"https://www.youtube.com/youtubei/v1/player?key={api_key}",
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": client["userAgent"],
            "Origin": "https://www.youtube.com",
            "Referer": f"https://www.youtube.com/watch?v={video_id}",
        },
        method="POST",
    )
    with _urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def _fetch_player_from_watch_page(video_id: str) -> dict:
    req = urllib.request.Request(
        f"https://www.youtube.com/watch?v={video_id}&bpctr=9999999999&has_verified=1",
        headers={
            "User-Agent": WEB_UA,
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with _urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    player = _parse_json_after_marker(html, "ytInitialPlayerResponse")
    if player and _player_is_usable(player):
        return player
    raise ValueError("Не удалось прочитать страницу YouTube")


def fetch_innertube_player(video_id: str) -> dict:
    cached = get_cached_player(video_id)
    if cached:
        return cached

    clients = [
        {
            "context": {
                "clientName": "ANDROID",
                "clientVersion": "20.10.38",
                "androidSdkVersion": 30,
                "osName": "Android",
                "osVersion": "11",
            },
            "userAgent": ANDROID_UA,
        },
        {
            "context": {
                "clientName": "ANDROID_VR",
                "clientVersion": "1.49.10",
                "deviceMake": "Oculus",
                "deviceModel": "Quest 3",
                "androidSdkVersion": 32,
            },
            "userAgent": ANDROID_VR_UA,
        },
        {
            "context": {
                "clientName": "IOS",
                "clientVersion": "20.10.3",
                "deviceModel": "iPhone16,2",
                "osVersion": "18.0",
            },
            "userAgent": IOS_UA,
        },
    ]

    last_error = "Не удалось получить видео с YouTube"

    for client in clients:
        try:
            data = _innertube_request(video_id, client)
            if _player_is_usable(data):
                _cache_player(video_id, data)
                return data
            reason = (data.get("playabilityStatus") or {}).get("reason") or ""
            if reason and not _is_skippable_error(reason):
                last_error = reason
        except urllib.error.HTTPError as e:
            last_error = f"YouTube HTTP {e.code}"
        except Exception as e:
            last_error = str(e)

    try:
        player = _fetch_player_from_watch_page(video_id)
        _cache_player(video_id, player)
        return player
    except Exception as e:
        last_error = str(e) or last_error

    raise ValueError(last_error)


def _format_duration(seconds: Any) -> str:
    total = int(seconds or 0)
    if not total:
        return "—"
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _max_height(progressive: list, adaptive: list) -> int:
    heights = []
    for fmt in progressive + adaptive:
        mime = fmt.get("mimeType") or ""
        if mime.startswith("video/"):
            heights.append(fmt.get("height") or 0)
    return max(heights) if heights else 0


def build_innertube_format_list(progressive: list, adaptive: list) -> list[dict]:
    max_h = _max_height(progressive, adaptive)
    formats = [{
        "format_id": "b",
        "label": "Авто (рекомендуется)",
        "ext": "mp4",
        "resolution": "авто",
        "filesize": "—",
        "has_video": True,
        "has_audio": True,
        "quality": 99999,
        "height": max_h,
        "recommended": True,
    }]

    progressive_heights = {f.get("height") for f in progressive if f.get("height")}
    video_heights = {f.get("height") for f in adaptive if (f.get("mimeType") or "").startswith("video/")}

    for height in (1080, 720, 480, 360, 240):
        if max_h and height > max_h:
            continue
        if height not in progressive_heights and not any(h <= height for h in video_heights if h):
            continue
        label = f"MP4 · {height}p"
        if height not in progressive_heights:
            label = f"MP4 · {height}p (видео)"
        formats.append({
            "format_id": f"q:{height}",
            "label": label,
            "ext": "mp4",
            "resolution": f"{height}p",
            "filesize": "—",
            "has_video": True,
            "has_audio": height in progressive_heights,
            "quality": height,
            "height": height,
            "recommended": False,
        })

    if any((f.get("mimeType") or "").startswith("audio/") for f in adaptive):
        formats.append({
            "format_id": "audio",
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


def innertube_analyze(url: str) -> dict:
    video_id = extract_youtube_id(url)
    if not video_id:
        raise ValueError("Неверная ссылка YouTube")

    player = fetch_innertube_player(video_id)
    details = player.get("videoDetails") or {}
    progressive, adaptive = _parse_formats(player)
    if not progressive and not adaptive:
        raise ValueError("Нет доступных форматов для скачивания")

    thumbs = details.get("thumbnail", {}).get("thumbnails") or []
    thumbnail = thumbs[-1]["url"] if thumbs else f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"

    return {
        "title": details.get("title") or "Без названия",
        "thumbnail": thumbnail,
        "video_id": video_id,
        "duration": _format_duration(details.get("lengthSeconds")),
        "uploader": details.get("author") or "—",
        "platform": "YouTube",
        "formats": build_innertube_format_list(progressive, adaptive),
        "formats_estimated": False,
        "needs_cookies": False,
        "via_innertube": True,
    }


def _ext_from_mime(mime: str, fallback: str) -> str:
    if "audio" in mime:
        return "m4a"
    if "webm" in mime:
        return "webm"
    return fallback


def pick_innertube_stream(video_id: str, format_id: str) -> dict:
    player = get_cached_player(video_id) or fetch_innertube_player(video_id)
    progressive, adaptive = _parse_formats(player)
    fmt = (format_id or "b").strip()
    if fmt in ("18", "worst", "bv*+ba/b"):
        fmt = "b"

    if fmt == "audio":
        audios = sorted(
            [f for f in adaptive if (f.get("mimeType") or "").startswith("audio/")],
            key=lambda f: f.get("bitrate") or 0,
            reverse=True,
        )
        if not audios:
            raise ValueError("Аудио недоступно")
        return {
            "url": audios[0]["url"],
            "ext": _ext_from_mime(audios[0].get("mimeType", ""), "m4a"),
            "note": None,
        }

    max_h = int(fmt[2:]) if fmt.startswith("q:") else None
    prog_sorted = sorted(progressive, key=lambda f: f.get("height") or 0, reverse=True)

    if max_h:
        match = next((f for f in prog_sorted if (f.get("height") or 0) <= max_h), None)
        if match:
            return {
                "url": match["url"],
                "ext": _ext_from_mime(match.get("mimeType", ""), "mp4"),
                "note": None,
            }
    elif prog_sorted:
        best = prog_sorted[0]
        return {
            "url": best["url"],
            "ext": _ext_from_mime(best.get("mimeType", ""), "mp4"),
            "note": None,
        }

    videos = sorted(
        [f for f in adaptive if (f.get("mimeType") or "").startswith("video/")],
        key=lambda f: f.get("height") or 0,
        reverse=True,
    )
    if max_h:
        match = next((f for f in videos if (f.get("height") or 0) <= max_h), None)
        if match:
            return {
                "url": match["url"],
                "ext": _ext_from_mime(match.get("mimeType", ""), "mp4"),
                "note": "без звука",
            }
    if videos:
        return {
            "url": videos[0]["url"],
            "ext": _ext_from_mime(videos[0].get("mimeType", ""), "mp4"),
            "note": "без звука",
        }

    raise ValueError("Формат недоступен. Выберите «Авто».")


def innertube_download_to_path(video_id: str, format_id: str, dest_path: str) -> dict:
    stream = pick_innertube_stream(video_id, format_id)
    req = urllib.request.Request(
        stream["url"],
        headers={
            "User-Agent": ANDROID_UA,
            "Referer": f"https://www.youtube.com/watch?v={video_id}",
            "Origin": "https://www.youtube.com",
        },
    )
    with _urlopen(req, timeout=600) as resp, open(dest_path, "wb") as out:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)

    return {"ext": stream["ext"], "note": stream.get("note")}
