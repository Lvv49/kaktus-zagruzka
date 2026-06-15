const PRODUCTION_SITE = 'https://kaktus-zagruzka.onrender.com';
const DEFAULT_API = PRODUCTION_SITE;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['apiUrl'], (data) => {
    if (!data.apiUrl) {
      chrome.storage.local.set({ apiUrl: DEFAULT_API });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
});
