importScripts('youtube-client.js');

const PRODUCTION_SITE = 'https://kaktus-zagruzka.onrender.com';

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ apiUrl: PRODUCTION_SITE });
});

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
    resolveYoutubeDownload(msg.url, msg.formatId)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'download') {
    chrome.downloads.download({
      url: msg.url,
      filename: msg.filename,
      saveAs: false,
    }, (id) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, id });
      }
    });
    return true;
  }

  return false;
});
