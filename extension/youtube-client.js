const INNERTUBE_CLIENTS = [
  {
    context: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      androidSdkVersion: 30,
      osName: 'Android',
      osVersion: '11',
    },
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    withCookies: false,
  },
  {
    context: {
      clientName: 'IOS',
      clientVersion: '20.10.3',
      deviceModel: 'iPhone16,2',
      osVersion: '18.0',
    },
    userAgent: 'com.google.ios.youtube/20.10.3 (iPhone16,2; U; CPU iOS 18_0 like Mac OS X)',
    withCookies: false,
  },
  {
    context: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      androidSdkVersion: 30,
      osName: 'Android',
      osVersion: '11',
    },
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    withCookies: true,
  },
  {
    context: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.49.10',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      androidSdkVersion: 32,
    },
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.49.10 (Linux; U; Android 12L)',
    withCookies: true,
  },
  {
    context: {
      clientName: 'IOS',
      clientVersion: '20.10.3',
      deviceModel: 'iPhone16,2',
      osVersion: '18.0',
    },
    userAgent: 'com.google.ios.youtube/20.10.3 (iPhone16,2; U; CPU iOS 18_0 like Mac OS X)',
    withCookies: true,
  },
];

const WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DNR_RULE_ID = 91001;
let cachedApiKey = null;

function normalizeYoutubeUrl(url) {
  return (url || '').trim().replace(/\\+$/g, '');
}

function extractVideoId(url) {
  const clean = normalizeYoutubeUrl(url);
  const patterns = [
    /(?:v=|\/embed\/|\/v\/|\/shorts\/|youtu\.be\/)([\w-]{11})/,
    /^([\w-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function hasFormats(progressive, adaptive) {
  return (progressive?.length || 0) + (adaptive?.length || 0) > 0;
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

async function buildYoutubeHeaders(videoId, userAgent, withCookies = true) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
    Origin: 'https://www.youtube.com',
    Referer: `https://www.youtube.com/watch?v=${videoId}`,
  };
  if (!withCookies) return headers;

  const cookies = await getYoutubeCookieList();
  if (!cookies.length) return headers;

  headers.Cookie = cookieHeader(cookies);
  const auth = await authorizationHeader(cookies);
  if (auth) {
    headers.Authorization = auth;
    headers['X-Origin'] = 'https://www.youtube.com';
  }
  return headers;
}

function isSkippableInnertubeError(reason) {
  const text = (reason || '').toLowerCase();
  return (
    text.includes('no longer supported')
    || text.includes('не поддерживается')
    || text.includes('application or device')
    || text.includes('приложении или на этом устройстве')
    || text.includes('page needs to be reloaded')
  );
}

async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const stored = await chrome.storage.local.get('innertubeKey');
  if (stored.innertubeKey) {
    cachedApiKey = stored.innertubeKey;
    return cachedApiKey;
  }

  const res = await fetch('https://www.youtube.com/', {
    headers: { 'User-Agent': WEB_USER_AGENT },
  });
  const html = await res.text();
  const match = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  cachedApiKey = match ? match[1] : 'AIzaSyAO_FJ2SlqU8Q4STEHL6lhmF_0cBqnWkbc';
  await chrome.storage.local.set({ innertubeKey: cachedApiKey });
  return cachedApiKey;
}

function parseJsonObjectAfterMarker(html, marker) {
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const start = html.indexOf('{', idx);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function resolveFormatUrl(fmt) {
  if (!fmt) return null;
  if (fmt.url) return fmt.url;

  const cipher = fmt.signatureCipher || fmt.cipher;
  if (!cipher) return null;

  const params = {};
  for (const part of cipher.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    params[key] = decodeURIComponent(value.replace(/\+/g, ' '));
  }

  if (!params.url) return null;
  let url = params.url;

  if (params.s) return null;
  if (params.sig && params.sp) {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}${params.sp}=${encodeURIComponent(params.sig)}`;
  }
  return url;
}

function parseRawFormats(player) {
  const streaming = player.streamingData || {};
  const progressive = (streaming.formats || [])
    .map((f) => ({ ...f, url: resolveFormatUrl(f) }))
    .filter((f) => f.url);
  const adaptive = (streaming.adaptiveFormats || [])
    .map((f) => ({ ...f, url: resolveFormatUrl(f) }))
    .filter((f) => f.url);
  return { progressive, adaptive };
}

function playerIsUsable(player) {
  if (!player?.streamingData) return false;
  const { progressive, adaptive } = parseRawFormats(player);
  return progressive.length + adaptive.length > 0;
}

function validatePlayer(player, videoId) {
  const status = player?.playabilityStatus?.status;
  if (status === 'LOGIN_REQUIRED') {
    throw new Error('Войдите в аккаунт на youtube.com');
  }
  if (status === 'UNPLAYABLE') {
    throw new Error(player.playabilityStatus?.reason || 'Видео недоступно');
  }
  if (status && status !== 'OK' && !playerIsUsable(player)) {
    throw new Error(player.playabilityStatus?.reason || 'Видео недоступно');
  }
  if (!playerIsUsable(player)) {
    throw new Error('Нет потоков для скачивания. Обновите youtube.com (F5).');
  }
  return player;
}

async function fetchPlayerFromWatchPage(videoId) {
  const cookies = await getYoutubeCookieList();
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999&has_verified=1`, {
    headers: {
      Cookie: cookieHeader(cookies),
      'User-Agent': WEB_USER_AGENT,
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  const html = await res.text();
  const player = parseJsonObjectAfterMarker(html, 'ytInitialPlayerResponse');
  if (player?.videoDetails?.videoId === videoId || playerIsUsable(player)) {
    return validatePlayer(player, videoId);
  }
  throw new Error('Не удалось прочитать страницу YouTube');
}

async function fetchPlayerFromInnertube(videoId) {
  const apiKey = await getApiKey();
  let lastError = null;

  for (const client of INNERTUBE_CLIENTS) {
    try {
      const headers = await buildYoutubeHeaders(videoId, client.userAgent, client.withCookies);
      const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          context: {
            client: { ...client.context, hl: 'en', gl: 'US' },
            user: {},
          },
          videoId,
        }),
      });

      const data = await res.json();
      if (playerIsUsable(data)) {
        return validatePlayer(data, videoId);
      }

      const reason = data.playabilityStatus?.reason || '';
      if (!isSkippableInnertubeError(reason)) {
        lastError = new Error(reason || 'Нет потоков для скачивания');
      }
    } catch (err) {
      if (!isSkippableInnertubeError(err.message)) {
        lastError = err;
      }
    }
  }

  if (lastError) throw lastError;
  throw new Error('Не удалось получить видео. Зайдите на youtube.com, войдите в аккаунт и обновите страницу (F5).');
}

async function fetchPlayerFromOpenTab(videoId) {
  const tabs = await chrome.tabs.query({ url: ['*://www.youtube.com/*', '*://youtube.com/*'] });
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !tab.url.includes(videoId)) continue;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const player = window.ytInitialPlayerResponse
            || (typeof ytInitialPlayerResponse !== 'undefined' ? ytInitialPlayerResponse : null);
          return player;
        },
      });
      const player = results?.[0]?.result;
      if (playerIsUsable(player)) {
        return validatePlayer(player, videoId);
      }
    } catch {}
  }
  return null;
}

async function fetchPlayer(videoId, preferInnertube = false) {
  const fetchers = preferInnertube
    ? [fetchPlayerFromInnertube, fetchPlayerFromWatchPage, fetchPlayerFromOpenTab]
    : [fetchPlayerFromInnertube, fetchPlayerFromWatchPage, fetchPlayerFromOpenTab];

  const errors = [];
  for (const fetcher of fetchers) {
    try {
      const player = await fetcher(videoId);
      if (player) return player;
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }

  throw new Error(errors[0] || 'Не удалось получить видео с YouTube');
}

function maxHeight(progressive, adaptive) {
  const heights = [...progressive, ...adaptive]
    .filter((f) => f.mimeType?.startsWith('video/'))
    .map((f) => f.height || 0);
  return heights.length ? Math.max(...heights) : 0;
}

function buildCompetitorFormats(progressive, adaptive) {
  const progressiveHeights = new Set(
    progressive.map((f) => f.height).filter(Boolean),
  );
  const videoHeights = adaptive
    .filter((f) => f.mimeType?.startsWith('video/'))
    .map((f) => f.height)
    .filter(Boolean);
  const maxH = maxHeight(progressive, adaptive);
  const hasAudio = adaptive.some((f) => f.mimeType?.startsWith('audio/'));

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
    const hasProgressive = [...progressiveHeights].some((h) => h <= height);
    const hasVideo = videoHeights.some((h) => h <= height);
    if (!hasProgressive && !hasVideo) continue;
    formats.push({
      format_id: `q:${height}`,
      label: hasProgressive ? `MP4 · ${height}p` : `MP4 · ${height}p (видео)`,
      ext: 'mp4',
      resolution: `${height}p`,
      filesize: '—',
    });
  }

  if (hasAudio) {
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

function extFromMime(mimeType, fallback) {
  if (!mimeType) return fallback;
  if (mimeType.includes('audio/mp4') || mimeType.includes('audio/m4a')) return 'm4a';
  if (mimeType.includes('video/webm')) return 'webm';
  if (mimeType.includes('video/mp4')) return 'mp4';
  return fallback;
}

function pickDownloadFormat(progressive, adaptive, formatId) {
  const fmt = (formatId || 'b').trim();
  const normalized = fmt === '18' || fmt === 'worst' ? 'b' : fmt;

  if (normalized === 'audio') {
    const audios = adaptive
      .filter((f) => f.mimeType?.startsWith('audio/'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (!audios.length) throw new Error('Аудио недоступно');
    return {
      url: audios[0].url,
      ext: extFromMime(audios[0].mimeType, 'm4a'),
    };
  }

  const maxH = normalized.startsWith('q:') ? parseInt(normalized.slice(2), 10) : null;
  const progressiveSorted = progressive
    .slice()
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (maxH) {
    const match = progressiveSorted.find((f) => (f.height || 0) <= maxH);
    if (match) {
      return { url: match.url, ext: extFromMime(match.mimeType, 'mp4') };
    }
  } else if (progressiveSorted.length) {
    const best = progressiveSorted[0];
    return { url: best.url, ext: extFromMime(best.mimeType, 'mp4') };
  }

  const videos = adaptive
    .filter((f) => f.mimeType?.startsWith('video/'))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (maxH) {
    const match = videos.find((f) => (f.height || 0) <= maxH);
    if (match) {
      return {
        url: match.url,
        ext: extFromMime(match.mimeType, 'mp4'),
        note: 'без звука',
      };
    }
  }
  if (videos.length) {
    const best = videos[0];
    return {
      url: best.url,
      ext: extFromMime(best.mimeType, 'mp4'),
      note: 'без звука',
    };
  }

  throw new Error('Нет доступных форматов. Обновите youtube.com (F5) и попробуйте снова.');
}

async function analyzeYoutube(url) {
  const cleanUrl = normalizeYoutubeUrl(url);
  const videoId = extractVideoId(cleanUrl);
  if (!videoId) throw new Error('Неверная ссылка YouTube');

  const player = await fetchPlayer(videoId);
  const details = player.videoDetails || {};
  const { progressive, adaptive } = parseRawFormats(player);

  if (!hasFormats(progressive, adaptive)) {
    throw new Error('YouTube не отдал ссылки на файл. Обновите youtube.com (F5).');
  }

  await chrome.storage.session.set({
    [`yt_${videoId}`]: {
      progressive,
      adaptive,
      title: details.title || 'video',
      ts: Date.now(),
    },
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

async function getMediaFetchHeaders(videoId) {
  const cookies = await getYoutubeCookieList();
  const auth = await authorizationHeader(cookies);
  const headers = {
    Referer: `https://www.youtube.com/watch?v=${videoId}`,
    Origin: 'https://www.youtube.com',
    'User-Agent': WEB_USER_AGENT,
    Accept: '*/*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    Cookie: cookieHeader(cookies),
  };
  if (auth) headers.Authorization = auth;
  return headers;
}

async function setupYoutubeDownloadRules(videoId) {
  const cookies = await getYoutubeCookieList();
  const cookieStr = cookieHeader(cookies).slice(0, 7000);
  const requestHeaders = [
    { header: 'Referer', operation: 'set', value: `https://www.youtube.com/watch?v=${videoId}` },
    { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' },
    {
      header: 'User-Agent',
      operation: 'set',
      value: WEB_USER_AGENT,
    },
  ];
  if (cookieStr) {
    requestHeaders.push({ header: 'Cookie', operation: 'set', value: cookieStr });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [{
      id: DNR_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders,
      },
      condition: {
        regexFilter: '^https://.*(googlevideo\\.com|youtube\\.com).*',
        resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'other'],
      },
    }],
  });
}

async function resolveYoutubeDownload(url, formatId, forceRefresh = true) {
  const cleanUrl = normalizeYoutubeUrl(url);
  const videoId = extractVideoId(cleanUrl);
  if (!videoId) throw new Error('Неверная ссылка YouTube');

  let progressive = [];
  let adaptive = [];
  let title = 'video';

  const cached = await chrome.storage.session.get(`yt_${videoId}`);
  const entry = cached[`yt_${videoId}`];
  if (entry && Date.now() - entry.ts < 10 * 60 * 1000 && hasFormats(entry.progressive, entry.adaptive)) {
    progressive = entry.progressive;
    adaptive = entry.adaptive;
    title = entry.title || title;
  }

  const tryPick = () => {
    if (!hasFormats(progressive, adaptive)) return null;
    try {
      return pickDownloadFormat(progressive, adaptive, formatId);
    } catch {
      return null;
    }
  };

  let picked = !forceRefresh ? tryPick() : null;
  if (!picked) {
    const player = await fetchPlayer(videoId, true);
    const details = player.videoDetails || {};
    title = details.title || title;
    ({ progressive, adaptive } = parseRawFormats(player));

    if (!hasFormats(progressive, adaptive)) {
      throw new Error('YouTube не отдал ссылки на файл. Обновите youtube.com (F5).');
    }

    await chrome.storage.session.set({
      [`yt_${videoId}`]: { progressive, adaptive, title, ts: Date.now() },
    });
    picked = pickDownloadFormat(progressive, adaptive, formatId);
  }
  const safeTitle = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 100);
  return {
    ok: true,
    url: picked.url,
    filename: `${safeTitle || 'video'}.${picked.ext}`,
    videoId,
    note: picked.note || null,
  };
}

async function downloadYoutubeFile(url, formatId) {
  const resolved = await resolveYoutubeDownload(url, formatId, true);
  await setupYoutubeDownloadRules(resolved.videoId);

  try {
    const started = await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: resolved.url,
        filename: resolved.filename,
        saveAs: false,
        conflictAction: 'uniquify',
      }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(id);
      });
    });

    await waitForDownloadComplete(started, url, formatId, resolved);
  } catch (directErr) {
    await downloadYoutubeViaFetch(resolved, resolved.videoId);
  }

  return {
    ok: true,
    filename: resolved.filename,
    note: resolved.note,
  };
}

async function waitForDownloadComplete(downloadId, sourceUrl, formatId, resolved, timeoutMs = 45000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const items = await chrome.downloads.search({ id: downloadId });
    const item = items[0];
    if (!item) return false;

    if (item.state === 'complete') {
      if ((item.totalBytes || 0) > 10000) return true;
      throw new Error('Скачан пустой файл. Обновите youtube.com (F5) и выберите «Авто».');
    }

    if (item.state === 'interrupted') {
      const fresh = await resolveYoutubeDownload(sourceUrl, formatId, true);
      await downloadYoutubeViaFetch(fresh, fresh.videoId);
      return true;
    }

    await sleep(500);
  }

  const fresh = await resolveYoutubeDownload(sourceUrl, formatId, true);
  await downloadYoutubeViaFetch(fresh, fresh.videoId);
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadYoutubeViaFetch(resolved, videoId) {
  const headers = await getMediaFetchHeaders(videoId);
  const response = await fetch(resolved.url, {
    method: 'GET',
    headers,
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`YouTube вернул ошибку ${response.status}. Обновите youtube.com (F5).`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/')) {
    throw new Error('YouTube заблокировал ссылку. Обновите youtube.com и выберите «Авто».');
  }

  const blob = await response.blob();
  if (blob.size < 10000) {
    throw new Error('Получен пустой файл. Обновите youtube.com (F5).');
  }

  const blobUrl = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: blobUrl,
        filename: resolved.filename,
        saveAs: false,
        conflictAction: 'uniquify',
      }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
        resolve(id);
      });
    });
    return true;
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    throw err;
  }
}
