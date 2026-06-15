const INNERTUBE_CLIENTS = [
  {
    context: {
      clientName: 'ANDROID',
      clientVersion: '19.29.37',
      androidSdkVersion: 30,
      osName: 'Android',
      osVersion: '11',
    },
    userAgent: 'com.google.android.youtube/19.29.37 (Linux; U; Android 11) gzip',
  },
  {
    context: {
      clientName: 'WEB',
      clientVersion: '2.20241120.01.00',
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  },
  {
    context: {
      clientName: 'IOS',
      clientVersion: '19.29.3',
      deviceModel: 'iPhone14,3',
      osVersion: '17.0',
    },
    userAgent: 'com.google.ios.youtube/19.29.3 (iPhone14,3; U; CPU iOS 17_0 like Mac OS X)',
  },
];

const playerCache = new Map();
let cachedApiKey = null;

function extractVideoId(url) {
  const patterns = [
    /(?:v=|\/embed\/|\/v\/|\/shorts\/|youtu\.be\/)([\w-]{11})/,
    /^([\w-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
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

async function getYoutubeCookieList() {
  const all = [];
  const domains = ['.youtube.com', 'youtube.com', '.google.com', 'google.com'];
  for (const domain of domains) {
    try {
      all.push(...await chrome.cookies.getAll({ domain }));
    } catch {}
  }

  const seen = new Set();
  return all.filter((cookie) => {
    const key = `${cookie.domain}|${cookie.name}|${cookie.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return cookie.domain.includes('youtube') || cookie.domain.includes('google');
  });
}

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function authorizationHeader(cookies) {
  const sap = cookies.find((c) => c.name === '__Secure-3PAPISID' || c.name === 'SAPISID');
  if (!sap) return null;
  const ts = Math.floor(Date.now() / 1000);
  const input = `${ts} ${sap.value} https://www.youtube.com`;
  const hashBuffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `SAPISIDHASH ${ts}_${hash}`;
}

async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const stored = await chrome.storage.local.get('innertubeKey');
  if (stored.innertubeKey) {
    cachedApiKey = stored.innertubeKey;
    return cachedApiKey;
  }

  const res = await fetch('https://www.youtube.com/');
  const html = await res.text();
  const match = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  cachedApiKey = match ? match[1] : 'AIzaSyAO_FJ2SlqU8Q4STEHL6lhmF_0cBqnWkbc';
  await chrome.storage.local.set({ innertubeKey: cachedApiKey });
  return cachedApiKey;
}

async function fetchPlayer(videoId) {
  const cookies = await getYoutubeCookieList();
  if (cookies.length < 2) {
    throw new Error('Зайдите на youtube.com в Chrome и войдите в аккаунт');
  }

  const apiKey = await getApiKey();
  const auth = await authorizationHeader(cookies);
  let lastError = null;

  for (const client of INNERTUBE_CLIENTS) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        Cookie: cookieHeader(cookies),
        'User-Agent': client.userAgent,
        Origin: 'https://www.youtube.com',
        Referer: `https://www.youtube.com/watch?v=${videoId}`,
      };
      if (auth) {
        headers.Authorization = auth;
        headers['X-Origin'] = 'https://www.youtube.com';
      }

      const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          context: {
            client: { ...client.context, hl: 'ru', gl: 'RU' },
          },
          videoId,
        }),
      });

      const data = await res.json();
      const status = data.playabilityStatus?.status;
      if (status === 'LOGIN_REQUIRED') {
        throw new Error('Войдите в аккаунт на youtube.com');
      }
      if (status === 'UNPLAYABLE') {
        throw new Error(data.playabilityStatus?.reason || 'Видео недоступно');
      }
      if (status && status !== 'OK') {
        throw new Error(data.playabilityStatus?.reason || 'Видео недоступно');
      }
      if (data.streamingData) {
        return data;
      }
      lastError = new Error('Нет потоков для скачивания');
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Не удалось получить видео с YouTube');
}

function parseRawFormats(player) {
  const streaming = player.streamingData || {};
  const progressive = (streaming.formats || []).filter((f) => f.url);
  const adaptive = (streaming.adaptiveFormats || []).filter((f) => f.url);
  return { progressive, adaptive };
}

function maxHeight(progressive, adaptive) {
  const heights = [...progressive, ...adaptive]
    .filter((f) => f.mimeType?.startsWith('video/'))
    .map((f) => f.height || 0);
  return heights.length ? Math.max(...heights) : 0;
}

function buildCompetitorFormats(progressive, adaptive) {
  const maxH = maxHeight(progressive, adaptive);
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
    formats.push({
      format_id: `q:${height}`,
      label: `MP4 · ${height}p`,
      ext: 'mp4',
      resolution: `${height}p`,
      filesize: '—',
    });
  }

  formats.push({
    format_id: 'audio',
    label: 'MP3 · только аудио',
    ext: 'm4a',
    resolution: 'аудио',
    filesize: '—',
  });

  return formats;
}

function pickDownloadFormat(progressive, adaptive, formatId) {
  if (formatId === 'audio') {
    const audios = adaptive
      .filter((f) => f.mimeType?.startsWith('audio/'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (!audios.length) throw new Error('Аудио недоступно');
    return { url: audios[0].url, ext: 'm4a' };
  }

  const maxH = formatId.startsWith('q:') ? parseInt(formatId.slice(2), 10) : null;
  const progressiveSorted = progressive
    .slice()
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (maxH) {
    const match = progressiveSorted.find((f) => (f.height || 0) <= maxH);
    if (match) return { url: match.url, ext: 'mp4' };
  } else if (progressiveSorted.length) {
    return { url: progressiveSorted[0].url, ext: 'mp4' };
  }

  const videos = adaptive
    .filter((f) => f.mimeType?.startsWith('video/'))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (maxH) {
    const match = videos.find((f) => (f.height || 0) <= maxH);
    if (match) return { url: match.url, ext: 'mp4', note: 'без звука' };
  }
  if (videos.length) {
    return { url: videos[0].url, ext: 'mp4', note: 'без звука' };
  }

  throw new Error('Формат недоступен. Выберите «Авто».');
}

async function analyzeYoutube(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Неверная ссылка YouTube');

  const player = await fetchPlayer(videoId);
  const details = player.videoDetails || {};
  const { progressive, adaptive } = parseRawFormats(player);

  playerCache.set(videoId, {
    progressive,
    adaptive,
    title: details.title || 'video',
  });

  const thumbs = details.thumbnail?.thumbnails || [];
  const thumbnail = thumbs[thumbs.length - 1]?.url
    || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  return {
    ok: true,
    title: details.title || 'Без названия',
    thumbnail,
    video_id: videoId,
    duration: formatDuration(parseInt(details.lengthSeconds || '0', 10)),
    uploader: details.author || '—',
    platform: 'YouTube',
    formats: buildCompetitorFormats(progressive, adaptive),
    formats_estimated: false,
    via_extension: true,
  };
}

async function resolveYoutubeDownload(url, formatId) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Неверная ссылка YouTube');

  let cache = playerCache.get(videoId);
  if (!cache) {
    await analyzeYoutube(url);
    cache = playerCache.get(videoId);
  }

  const picked = pickDownloadFormat(cache.progressive, cache.adaptive, formatId);
  const safeTitle = (cache.title || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 100);
  return {
    ok: true,
    url: picked.url,
    filename: `${safeTitle || 'video'}.${picked.ext}`,
    note: picked.note || null,
  };
}
