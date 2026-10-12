// MV3 service worker. Content scripts cannot create Workers from extension
// URLs, so the Stockfish worker lives in an offscreen document (extension
// origin). This file relays UCI commands/lines between the content script and
// the offscreen document.
//
// IMPORTANT: MV3 service workers are terminated after ~30s idle and restart
// with empty memory. Everything below must be resilient to that: the offscreen
// document outlives the worker, and the target tab id is stored in
// chrome.storage.session.
"use strict";

var OFFSCREEN_URL = "offscreen.html";
var creating = null;
var offscreenReady = false;
var queue = [];
var memTabId = null;

function isOffscreenAlive() {
  if (chrome.offscreen && typeof chrome.offscreen.hasDocument === "function") {
    return chrome.offscreen.hasDocument();
  }
  return Promise.resolve(false);
}

function ensureOffscreen() {
  return isOffscreenAlive().then(function (alive) {
    if (alive) {
      // The offscreen document (and its engine worker) outlives service worker
      // restarts. Treat it as ready so commands don't stall in the queue.
      offscreenReady = true;
      return;
    }
    if (creating) return creating;
    offscreenReady = false;
    queue = [];
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["WORKERS"],
        justification: "Run the bundled Stockfish engine in a Web Worker.",
      })
      .catch(function (e) {
        console.error("[chesscheat] failed to create offscreen document", e);
      })
      .then(function () {
        creating = null;
      });
    return creating;
  });
}

function forwardToOffscreen(msg) {
  var payload = Object.assign({}, msg, { from: "background", to: "offscreen" });
  if (offscreenReady) {
    chrome.runtime.sendMessage(payload, function () {
      void chrome.runtime.lastError;
    });
  } else {
    queue.push(payload);
  }
}

function flushQueue() {
  offscreenReady = true;
  var pending = queue;
  queue = [];
  pending.forEach(function (payload) {
    chrome.runtime.sendMessage(payload, function () {
      void chrome.runtime.lastError;
    });
  });
}

function rememberTab(tabId) {
  memTabId = tabId;
  try {
    chrome.storage.session.set({ chesscheatTabId: tabId });
  } catch (e) {}
}

function resolveTabId() {
  if (memTabId != null) return Promise.resolve(memTabId);
  return new Promise(function (resolve) {
    try {
      chrome.storage.session.get("chesscheatTabId", function (res) {
        resolve(res && res.chesscheatTabId != null ? res.chesscheatTabId : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.__chesscheat !== true) return;

  if (msg.from === "content") {
    if (sender.tab && sender.tab.id != null) rememberTab(sender.tab.id);
    ensureOffscreen().then(function () {
      forwardToOffscreen(msg);
      sendResponse({ ok: true });
    });
    // Keep the message channel (and the service worker) alive until we finish.
    return true;
  }

  if (msg.from === "offscreen") {
    if (msg.type === "ready") {
      flushQueue();
      sendResponse({ ok: true });
      return true;
    }
    resolveTabId().then(function (tabId) {
      if (tabId != null) {
        chrome.tabs.sendMessage(
          tabId,
          Object.assign({}, msg, { from: "offscreen" }),
          function () {
            void chrome.runtime.lastError;
          }
        );
      }
      sendResponse({ ok: true });
    });
    return true;
  }
});
