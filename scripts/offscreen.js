// Offscreen document (extension origin). It is allowed to create a Worker
// from an extension URL, which the content script is not. It owns the
// Stockfish worker and relays UCI output back to the service worker.
"use strict";

var ENGINE_URL = "engine/stockfish-19-lite-single.js";
var engine = null;

function toBackground(msg) {
  msg.__chesscheat = true;
  msg.from = "offscreen";
  try {
    chrome.runtime.sendMessage(msg);
  } catch (e) {
    console.error("[chesscheat] offscreen could not message background", e);
  }
}

function getEngine() {
  if (engine) return engine;
  try {
    engine = new Worker(chrome.runtime.getURL(ENGINE_URL));
  } catch (e) {
    console.error("[chesscheat] offscreen failed to create worker", e);
    toBackground({ type: "error", message: String(e) });
    return null;
  }
  engine.onmessage = function (e) {
    var text = typeof e.data === "string" ? e.data : "";
    text.split("\n").forEach(function (line) {
      if (line) toBackground({ type: "line", line: line });
    });
  };
  engine.onerror = function (e) {
    toBackground({ type: "error", message: (e && e.message) || "worker error" });
  };
  return engine;
}

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.__chesscheat !== true || msg.to !== "offscreen") return;
  if (msg.type === "cmd") {
    var w = getEngine();
    if (w) w.postMessage(msg.cmd);
  } else if (msg.type === "terminate") {
    if (engine) {
      try {
        engine.terminate();
      } catch (e) {}
      engine = null;
    }
  }
});

getEngine();
toBackground({ type: "ready" });
