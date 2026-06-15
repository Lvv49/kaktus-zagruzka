importScripts('youtube-client.js');

const PRODUCTION_SITE = 'https://kaktus-zagruzka.ru';

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ apiUrl: PRODUCTION_SITE });
  clearYoutubeDownloadRules();
});

clearYoutubeDownloadRules();

function isYoutubeMediaUrl(url) {
  return /googlevideo\.com|youtube\.com\/videoplayback/i.test(url || '');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ping') {
    sendResponse({ ok: true, pong: true });
    return false;
  }

  if (msg.type === 'youtubeAnalyze') {
    analyzeYoutube(msg.url)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'youtubeDownload') {
    resolveYoutubeDownload(msg.url, msg.formatId, true)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'youtubeDownloadAndSave') {
    downloadYoutubeFile(msg.url, msg.formatId)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'download') {
    (async () => {
      try {
        if (isYoutubeMediaUrl(msg.url) && msg.videoId) {
          await setupYoutubeDownloadRules(msg.videoId);
          try {
            await downloadViaDirect(msg);
            return;
          } catch {
            await downloadYoutubeViaFetch(
              { url: msg.url, filename: msg.filename },
              msg.videoId,
            );
            return;
          }
        }
        await downloadViaDirect(msg);
      } finally {
        if (msg.videoId) await clearYoutubeDownloadRules();
      }
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  return false;
});

function downloadViaDirect(msg) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: msg.url,
      filename: msg.filename,
      saveAs: false,
      conflictAction: 'uniquify',
    }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve({ ok: true, id });
    });
  });
}
