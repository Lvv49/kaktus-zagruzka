/* YouTube через браузер пользователя (обход блокировки VPS) */
const YT_BROWSER = (() => {
  const API_KEY_FALLBACK = 'AIzaSyAO_FJ2SlqU8Q4STEHL6lhmF_0cBqnWkbc';
  const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';
  const IOS_UA = 'com.google.ios.youtube/20.10.3 (iPhone16,2; U; CPU iOS 18_0 like Mac OS X)';
  const STORAGE_PREFIX = 'kaktus_yt_';

  const CLIENTS = [
    { context: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11' }, userAgent: ANDROID_UA },
    { context: { clientName: 'IOS', clientVersion: '20.10.3', deviceModel: 'iPhone16,2', osVersion: '18.0' }, userAgent: IOS_UA },
  ];

  let cachedApiKey = null;

  function extractId(url) {
    const u = (url || '').trim();
    const m = u.match(/(?:v=|\/embed\/|\/v\/|\/shorts\/|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  function formatDuration(seconds) {
    const total = Number(seconds) || 0;
    if (!total) return '—';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function resolveUrl(fmt) {
    if (!fmt) return null;
    if (fmt.url) return fmt.url;
    const cipher = fmt.signatureCipher || fmt.cipher;
    if (!cipher) return null;
    const params = {};
    cipher.split('&').forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) params[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
    });
    if (!params.url || params.s) return null;
    let url = params.url;
    if (params.sig && params.sp) {
      url += (url.includes('?') ? '&' : '?') + `${params.sp}=${encodeURIComponent(params.sig)}`;
    }
    return url;
  }

  function parseFormats(player) {
    const streaming = player.streamingData || {};
    const progressive = (streaming.formats || []).map((f) => ({ ...f, url: resolveUrl(f) })).filter((f) => f.url);
    const adaptive = (streaming.adaptiveFormats || []).map((f) => ({ ...f, url: resolveUrl(f) })).filter((f) => f.url);
    return { progressive, adaptive };
  }

  function hasStreams(progressive, adaptive) {
    return progressive.length + adaptive.length > 0;
  }

  function buildFormats(progressive, adaptive) {
    const progHeights = new Set(progressive.map((f) => f.height).filter(Boolean));
    const vidHeights = adaptive.filter((f) => (f.mimeType || '').startsWith('video/')).map((f) => f.height).filter(Boolean);
    const maxH = Math.max(0, ...[...progHeights, ...vidHeights]);
    const formats = [{
      format_id: 'b',
      label: 'Авто (рекомендуется)',
      ext: 'mp4',
      resolution: 'авто',
      filesize: '—',
      recommended: true,
    }];
    for (const height of [1080, 720, 480, 360, 240]) {
      if (maxH && height > maxH) continue;
      const hasP = [...progHeights].some((h) => h <= height);
      const hasV = vidHeights.some((h) => h <= height);
      if (!hasP && !hasV) continue;
      formats.push({
        format_id: `q:${height}`,
        label: hasP ? `MP4 · ${height}p` : `MP4 · ${height}p (видео)`,
        ext: 'mp4',
        resolution: `${height}p`,
        filesize: '—',
      });
    }
    if (adaptive.some((f) => (f.mimeType || '').startsWith('audio/'))) {
      formats.push({
        format_id: 'audio',
        label: 'MP3 · только аудио',
        ext: 'm4a',
        resolution: 'аудио',
        filesize: '—',
      });
    }
    return formats;
  }

  async function getApiKey() {
    if (cachedApiKey) return cachedApiKey;
    const res = await fetch('https://www.youtube.com/', { headers: { 'User-Agent': WEB_UA } });
    const html = await res.text();
    const match = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    cachedApiKey = match ? match[1] : API_KEY_FALLBACK;
    return cachedApiKey;
  }

  async function fetchPlayer(videoId) {
    const apiKey = await getApiKey();
    let lastError = 'Не удалось получить видео';

    for (const client of CLIENTS) {
      try {
        const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': client.userAgent,
            Origin: 'https://www.youtube.com',
            Referer: `https://www.youtube.com/watch?v=${videoId}`,
          },
          body: JSON.stringify({
            context: { client: { ...client.context, hl: 'en', gl: 'US' }, user: {} },
            videoId,
          }),
        });
        if (!res.ok) {
          lastError = `YouTube HTTP ${res.status}`;
          continue;
        }
        const player = await res.json();
        const { progressive, adaptive } = parseFormats(player);
        if (hasStreams(progressive, adaptive)) {
          return { player, progressive, adaptive };
        }
        const reason = player.playabilityStatus?.reason;
        if (reason) lastError = reason;
      } catch (e) {
        lastError = e.message || String(e);
      }
    }

    throw new Error(lastError);
  }

  function saveStreams(videoId, progressive, adaptive, title) {
    sessionStorage.setItem(`${STORAGE_PREFIX}${videoId}`, JSON.stringify({
      progressive,
      adaptive,
      title,
      ts: Date.now(),
    }));
  }

  function loadStreams(videoId) {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${videoId}`);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (Date.now() - data.ts > 3600000) return null;
      return data;
    } catch {
      return null;
    }
  }

  function extFromMime(mime, fallback) {
    if (!mime) return fallback;
    if (mime.includes('audio')) return 'm4a';
    if (mime.includes('webm')) return 'webm';
    return 'mp4';
  }

  function pickStream(progressive, adaptive, formatId) {
    const fmt = (formatId || 'b').trim();
    if (fmt === 'audio') {
      const audios = adaptive.filter((f) => (f.mimeType || '').startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (!audios.length) throw new Error('Аудио недоступно');
      return { url: audios[0].url, ext: extFromMime(audios[0].mimeType, 'm4a') };
    }

    const maxH = fmt.startsWith('q:') ? parseInt(fmt.slice(2), 10) : null;
    const prog = progressive.slice().sort((a, b) => (b.height || 0) - (a.height || 0));
    if (maxH) {
      const m = prog.find((f) => (f.height || 0) <= maxH);
      if (m) return { url: m.url, ext: extFromMime(m.mimeType, 'mp4') };
    } else if (prog.length) {
      return { url: prog[0].url, ext: extFromMime(prog[0].mimeType, 'mp4') };
    }

    const videos = adaptive.filter((f) => (f.mimeType || '').startsWith('video/'))
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    if (maxH) {
      const m = videos.find((f) => (f.height || 0) <= maxH);
      if (m) return { url: m.url, ext: extFromMime(m.mimeType, 'mp4'), note: 'без звука' };
    } else if (videos.length) {
      return { url: videos[0].url, ext: extFromMime(videos[0].mimeType, 'mp4'), note: 'без звука' };
    }
    throw new Error('Формат недоступен');
  }

  async function analyze(url) {
    const videoId = extractId(url);
    if (!videoId) throw new Error('Неверная ссылка YouTube');

    const { player, progressive, adaptive } = await fetchPlayer(videoId);
    const details = player.videoDetails || {};
    saveStreams(videoId, progressive, adaptive, details.title || 'video');

    const thumbs = details.thumbnail?.thumbnails || [];
    return {
      title: details.title || 'Без названия',
      thumbnail: thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      video_id: videoId,
      duration: formatDuration(details.lengthSeconds),
      uploader: details.author || '—',
      platform: 'YouTube',
      formats: buildFormats(progressive, adaptive),
      via_browser: true,
    };
  }

  async function download(url, formatId) {
    const videoId = extractId(url);
    const cached = loadStreams(videoId);
    if (!cached) throw new Error('Сессия истекла. Нажмите «Найти форматы» снова.');
    const stream = pickStream(cached.progressive, cached.adaptive, formatId);
    const filename = `${(cached.title || 'video').replace(/[<>:"/\\|?*]+/g, '_').slice(0, 80)}.${stream.ext}`;

    try {
      const res = await fetch(stream.url, { referrerPolicy: 'strict-origin-when-cross-origin' });
      if (!res.ok) throw new Error('fetch failed');
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(blobUrl);
      return { ok: true, note: stream.note || '' };
    } catch {
      const a = document.createElement('a');
      a.href = stream.url;
      a.download = filename;
      a.target = '_blank';
      a.rel = 'noopener';
      a.click();
      return { ok: true, note: stream.note || 'откройте вкладку и сохраните вручную' };
    }
  }

  return { analyze, download, extractId };
})();
