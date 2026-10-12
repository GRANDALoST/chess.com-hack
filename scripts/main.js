// Isolated-world content script.
// - Injects the UI button into chess.com's board layout.
// - Talks to scripts/page-bridge.js (MAIN world) to get the exact FEN and to
//   draw chess.com-native arrows/highlights.
// - Runs a bundled Stockfish 19 (single-threaded WASM) in a Web Worker.
// - Falls back to scraping the DOM if chess.com's board API is unavailable.
(function () {
  "use strict";

  var TAG = "chesscheat";
  var FILES = "abcdefgh";
  var DEFAULT_DEPTH = 15;
  var DOM_POLL_MS = 500;
  var INACCURACY_CHANCE = 0.25;
  var INACCURACY_CP = 25;
  var RATING_CHOICES = [800, 1000, 1200, 1500, 1800, 2000, 2200, 2500];
  var BULLET_MOVETIME_MS = 350;

  // Localized UI strings. chrome.i18n picks the browser language automatically
  // from _locales/ (English is the default/fallback).
  function t(key, subs) {
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && chrome.i18n.getMessage) {
        var msg = chrome.i18n.getMessage(key, subs);
        if (msg) return msg;
      }
    } catch (e) {}
    return key;
  }

  var hackRunning = false;
  var depth = DEFAULT_DEPTH;
  var bridgeActive = false;
  var playingColor = "w";
  var lastFen = null;
  var lastBest = null;

  var engineStarted = false;
  var engineReady = false;
  var engineThinking = false;
  var pendingFen = null;
  var searchFen = null;
  var multipv = {};
  var currentMultiPV = 1;

  var autoPlay = false;
  var pendingAutoTimer = null;
  var humanization = "v1";
  var targetRating = 1800;

  var domTimer = null;
  var lastDomFen = null;

  var button = null;
  var statusEl = null;
  var contextLost = false;

  // The isolated world's extension bindings are torn down when the extension
  // is reloaded/updated/disabled while this page stays open. Any chrome.* call
  // then throws "Extension context invalidated". Detect it and tell the user
  // to refresh the page, instead of failing silently.
  function contextAlive() {
    try {
      return !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function onContextLost() {
    if (contextLost) return;
    contextLost = true;
    hackRunning = false;
    stopSearch();
    stopDomFallback();
    clearHighlight();
    if (button) {
      button.disabled = true;
      button.textContent = t("reloadPage");
    }
    console.error("[chesscheat] extension context invalidated. Refresh this tab (F5) to continue.");
  }

  // ---------------------------------------------------------------- messaging
  function sendToMain(msg) {
    msg["__" + TAG] = TAG;
    msg.dir = "to-main";
    window.postMessage(msg, "*");
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d["__" + TAG] !== TAG || d.dir !== "to-content") return;

    if (d.type === "fen") {
      if (!contextAlive()) {
        onContextLost();
        return;
      }
      if (!bridgeActive) console.info("[chesscheat] board API found, using exact FEN");
      bridgeActive = true;
      stopDomFallback();
      handleFen(d.fen, d.playingAs, d.flipped, d.turn);
    } else if (d.type === "no-api") {
      if (bridgeActive) return;
      startDomFallback();
    }
  });

  function colorFromBoard(playingAs) {
    if (playingAs === 1) return "w";
    if (playingAs === 2) return "b";
    if (typeof playingAs === "string") {
      var s = playingAs.toLowerCase();
      if (s === "white" || s === "w") return "w";
      if (s === "black" || s === "b") return "b";
    }
    // Unknown: the board orientation is not the same as our identity, so do
    // not guess. null means "always suggest the move for the side to move".
    return null;
  }

  // ---------------------------------------------------------------- position
  function handleFen(fen, playingAs, flipped, turnNum) {
    if (typeof fen !== "string" || !fen) return;
    var myColor = colorFromBoard(playingAs);
    playingColor = myColor;
    lastFen = fen;
    if (!hackRunning) return;

    var turn = fen.split(" ")[1];
    var myTurn;
    if ((turnNum === 1 || turnNum === 2) && (playingAs === 1 || playingAs === 2)) {
      myTurn = turnNum === playingAs;
    } else if (myColor) {
      myTurn = turn === myColor;
    } else {
      // Identity unknown: never get stuck waiting. We suggest the best move
      // for whoever is to move (on your turn that is your move).
      myTurn = true;
    }
    if (!myTurn) {
      setStatus(t("waiting"));
      clearHighlight();
      stopSearch();
      return;
    }
    requestBestMove(fen);
  }

  // ---------------------------------------------------------------- engine
  // The Stockfish worker runs in an offscreen document (extension origin);
  // content scripts cannot create Workers from extension URLs directly.
  function sendToBackground(msg) {
    msg["__" + TAG] = true;
    msg.from = "content";
    if (!contextAlive()) {
      onContextLost();
      return false;
    }
    try {
      chrome.runtime.sendMessage(msg, function () {
        void (chrome.runtime && chrome.runtime.lastError);
        if (!contextAlive()) onContextLost();
      });
    } catch (e) {
      onContextLost();
      return false;
    }
    return true;
  }

  function post(cmd) {
    sendToBackground({ type: "cmd", cmd: cmd });
  }

  function createEngine() {
    if (engineStarted) return;
    engineStarted = true;
    post("uci");
  }

  function setMultiPV(n) {
    if (n === currentMultiPV) return;
    currentMultiPV = n;
    if (engineStarted) post("setoption name MultiPV value " + n);
  }

  function multiPvForLevel() {
    if (humanization === "v2") return 5;
    if (humanization === "v1") return 3;
    return 1;
  }
  function effectiveDepth() {
    if (humanization !== "v2") return depth;
    var jitter = Math.floor(Math.random() * 4);
    return Math.max(4, depth - jitter);
  }

  function recordInfo(line) {
    var mpv = / multipv (\d+)/.exec(line);
    if (!mpv) return;
    var pv = / pv ([a-h][1-8][a-h][1-8][qrbn]?)/.exec(line);
    if (!pv) return;
    var cp;
    var sc = / score cp (-?\d+)/.exec(line);
    var sm = / score mate (-?\d+)/.exec(line);
    if (sc) cp = parseInt(sc[1], 10);
    else if (sm) {
      var n = parseInt(sm[1], 10);
      cp = n > 0 ? 100000 - n : -100000 - n;
    } else cp = 0;
    multipv[parseInt(mpv[1], 10)] = { cp: cp, move: pv[1] };
  }

  function onEngineLine(line) {
    if (line.indexOf("info ") === 0) {
      recordInfo(line);
    } else if (line === "uciok") {
      post("setoption name Hash value 16");
      setMultiPV(multiPvForLevel());
      post("isready");
    } else if (line === "readyok") {
      engineReady = true;
      if (pendingFen) {
        var f = pendingFen;
        pendingFen = null;
        requestBestMove(f);
      }
    } else if (line.indexOf("bestmove") === 0) {
      engineThinking = false;
      var move = line.split(/\s+/)[1];
      if (move && move !== "(none)") handleBestMove(move);
    }
  }

  if (contextAlive()) {
    try {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg || msg["__" + TAG] !== true || msg.from !== "offscreen") return;
        if (msg.type === "line" && typeof msg.line === "string") {
          onEngineLine(msg.line);
        } else if (msg.type === "error") {
          console.error("[chesscheat] engine error:", msg.message);
          setStatus(t("engineError"));
        }
      });
    } catch (e) {}
  }

  function requestBestMove(fen) {
    if (!engineStarted) return;
    if (!engineReady) {
      pendingFen = fen;
      return;
    }
    if (fen === searchFen && engineThinking) return;
    searchFen = fen;
    multipv = {};
    setMultiPV(multiPvForLevel());
    if (engineThinking) post("stop");
    post("position fen " + fen);
    if (humanization === "bullet") {
      post("go movetime " + BULLET_MOVETIME_MS);
      engineThinking = true;
      setStatus(t("thinkingBullet"));
    } else {
      post("go depth " + effectiveDepth());
      engineThinking = true;
      setStatus(t("thinkingDepth", [String(depth)]));
    }
  }

  function stopSearch() {
    if (engineStarted && engineThinking) post("stop");
    engineThinking = false;
    searchFen = null;
  }

  // ---------------------------------------------------------------- best move
  function sortedEntries() {
    var entries = Object.keys(multipv).map(function (k) {
      return multipv[k];
    });
    entries.sort(function (a, b) {
      return b.cp - a.cp;
    });
    return entries;
  }

  // v1: light. Usually the best move; 25% of the time a near-equal one.
  function chooseMoveV1(bestMove) {
    var entries = sortedEntries();
    if (entries.length < 2) return bestMove;
    if (Math.random() < INACCURACY_CHANCE) {
      var bestCp = entries[0].cp;
      var alts = entries.filter(function (e, i) {
        return i > 0 && bestCp - e.cp <= INACCURACY_CP;
      });
      if (alts.length) return alts[Math.floor(Math.random() * alts.length)].move;
    }
    return bestMove;
  }

  // v2: rating-driven. Softmax over the top lines plus a small blunder chance.
  function chooseMoveV2(bestMove) {
    var entries = sortedEntries();
    if (entries.length < 2) return bestMove;
    var bestCp = entries[0].cp;
    var T = Math.max(6, (2300 - targetRating) / 12);
    var pBlunder = Math.max(0.02, Math.min(0.18, (2100 - targetRating) / 6000));
    if (Math.random() < pBlunder) {
      var blunders = entries.filter(function (e, i) {
        var loss = bestCp - e.cp;
        return i > 0 && loss >= 80 && loss <= 350;
      });
      if (blunders.length) return blunders[Math.floor(Math.random() * blunders.length)].move;
    }
    var weights = entries.map(function (e) {
      return Math.exp(-(bestCp - e.cp) / T);
    });
    var total = weights.reduce(function (a, b) {
      return a + b;
    }, 0);
    var r = Math.random() * total;
    var acc = 0;
    for (var i = 0; i < entries.length; i++) {
      acc += weights[i];
      if (r <= acc) return entries[i].move;
    }
    return bestMove;
  }

  function chooseMove(bestMove) {
    if (!autoPlay || humanization === "off" || humanization === "v3" || humanization === "bullet") {
      return bestMove;
    }
    if (humanization === "v2") return chooseMoveV2(bestMove);
    return chooseMoveV1(bestMove);
  }

  function readClockMs() {
    var el = document.querySelector(".clock-bottom");
    if (!el) return null;
    var m = /(\d{1,2}):(\d{2})/.exec(el.textContent || "");
    if (!m) return null;
    return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
  }

  function clampByClock(delay) {
    var clock = readClockMs();
    if (clock != null) {
      var cap = Math.max(400, clock * 0.05);
      if (clock < 15000) cap = Math.min(cap, 800);
      delay = Math.min(delay, cap);
    }
    return Math.max(350, Math.min(delay, 9000));
  }

  function humanDelayV1() {
    var base = 500 + depth * 120;
    var delay = base + Math.random() * 1600;
    if (Math.random() < 0.15) delay += 1500 + Math.random() * 3000;
    return clampByClock(delay);
  }

  function normalSample() {
    var u = 1 - Math.random();
    var v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function humanDelayV2() {
    var reaction = 200 + Math.random() * 1000;
    var clock = readClockMs();
    if (clock != null && clock < 20000) {
      // Low time: quick, slightly panicky.
      return clampByClock(150 + Math.random() * 450);
    }
    if (Math.random() < 0.1) {
      // Occasional instant move (premove-like).
      return clampByClock(reaction + 100 + Math.random() * 200);
    }
    // Log-normal think time with a long tail.
    var median = 600 + depth * 110;
    var sigma = 0.55;
    var think = Math.exp(Math.log(median) + sigma * normalSample());
    if (Math.random() < 0.15) think *= 2 + Math.random();
    return clampByClock(reaction + think);
  }

  function clampBullet(delay) {
    var clock = readClockMs();
    if (clock != null) {
      var cap = Math.max(120, clock * 0.04);
      delay = Math.min(delay, cap);
    }
    return Math.max(60, Math.min(delay, 1200));
  }

  function humanDelayBullet() {
    var clock = readClockMs();
    if (clock != null && clock < 10000) {
      return 80 + Math.random() * 150;
    }
    if (Math.random() < 0.2) {
      // instant / premove-like
      return clampBullet(80 + Math.random() * 120);
    }
    return clampBullet(150 + Math.random() * 450);
  }

  function humanDelayMs() {
    if (humanization === "bullet") return humanDelayBullet();
    if (humanization === "v2" || humanization === "v3") return humanDelayV2();
    return humanDelayV1();
  }

  function scheduleAutoMove(from, to, promotion, fen) {
    if (pendingAutoTimer) clearTimeout(pendingAutoTimer);
    if (!fen) return;
    var delay = humanDelayMs();
    setStatus(t("autoMove", [(delay / 1000).toFixed(1)]));
    pendingAutoTimer = setTimeout(function () {
      pendingAutoTimer = null;
      if (!hackRunning || !autoPlay) return;
      if (lastFen !== fen) return;
      sendToMain({ action: "move", from: from, to: to, promotion: promotion });
    }, delay);
  }

  function handleBestMove(uci) {
    if (!hackRunning || !searchFen) return;
    if (lastFen !== searchFen) return;
    var chosen = chooseMove(uci);
    showBestMove(chosen, searchFen);
  }

  function showBestMove(uci, fen) {
    var from = uci.slice(0, 2);
    var to = uci.slice(2, 4);
    var promotion = uci.length > 4 ? uci[4] : null;
    lastBest = { from: from, to: to, uci: uci };
    setStatus(t("bestMove", [from, to]) + (promotion ? " = " + promotion.toUpperCase() : ""));
    // DOM squares are always drawn (guaranteed visible); the native arrow is a bonus.
    drawDomHighlights(from, to);
    if (bridgeActive) sendToMain({ action: "highlight", from: from, to: to });
    if (autoPlay && bridgeActive) scheduleAutoMove(from, to, promotion, fen);
  }

  function clearHighlight() {
    lastBest = null;
    if (bridgeActive) sendToMain({ action: "clear" });
    clearDomHighlights();
  }

  // ---------------------------------------------------------------- DOM fallback
  function findBoard() {
    return document.querySelector("wc-chess-board, chess-board, #board-single, #board");
  }

  function colorFromFlipped() {
    var board = findBoard();
    return board && board.classList.contains("flipped") ? "b" : "w";
  }

  function domTurn() {
    var bottom = document.querySelector(".clock-bottom.clock-player-turn");
    var top = document.querySelector(".clock-top.clock-player-turn");
    var me = colorFromFlipped();
    if (bottom && !top) return me;
    if (top && !bottom) return me === "w" ? "b" : "w";
    return null;
  }

  function buildDomFen() {
    var board = findBoard();
    if (!board) return null;
    var grid = {};
    board.querySelectorAll(".piece").forEach(function (p) {
      var square = null;
      var pieceType = null;
      p.classList.forEach(function (c) {
        if (/^square-\d\d$/.test(c)) square = c;
        else if (/^[wb][pnbrqk]$/.test(c)) pieceType = c;
      });
      if (!square || !pieceType) return;
      var col = square.charAt(7);
      var row = square.charAt(8);
      if (col < "1" || col > "8" || row < "1" || row > "8") return;
      grid[col + "," + row] = pieceType;
    });
    if (!Object.keys(grid).length) return null;

    var placement = "";
    for (var row = 8; row >= 1; row--) {
      var empty = 0;
      for (var col = 1; col <= 8; col++) {
        var pt = grid[col + "," + row];
        if (!pt) {
          empty++;
          continue;
        }
        if (empty) {
          placement += empty;
          empty = 0;
        }
        placement += pt.charAt(0) === "w" ? pt.charAt(1).toUpperCase() : pt.charAt(1);
      }
      if (empty) placement += empty;
      if (row > 1) placement += "/";
    }
    var turn = domTurn() || colorFromFlipped();
    return placement + " " + turn + " - - 0 1";
  }

  function drawDomHighlights(from, to) {
    var board = findBoard();
    if (!board) return;
    clearDomHighlights(board);
    [from, to].forEach(function (sq) {
      var col = FILES.indexOf(sq[0]) + 1;
      if (col < 1) return;
      var el = document.createElement("div");
      el.className = "highlight cheat-highlight square-" + col + sq[1];
      el.style.cssText = "background:#e63946;opacity:0.5;pointer-events:none;";
      board.appendChild(el);
    });
  }

  function clearDomHighlights(board) {
    (board || document).querySelectorAll(".cheat-highlight").forEach(function (el) {
      el.remove();
    });
  }

  function startDomFallback() {
    if (domTimer) return;
    console.warn("[chesscheat] board API unavailable, falling back to DOM scraping");
    setStatus(t("fallback"));
    domTimer = setInterval(function () {
      if (!hackRunning) return;
      if (!contextAlive()) {
        onContextLost();
        return;
      }
      var fen = buildDomFen();
      if (!fen || fen === lastDomFen) return;
      lastDomFen = fen;
      // In DOM fallback the board orientation is the only clue about our side.
      var myColor = colorFromFlipped();
      playingColor = myColor;
      if (fen.split(" ")[1] !== myColor) {
        setStatus(t("waiting"));
        clearHighlight();
        stopSearch();
        return;
      }
      requestBestMove(fen);
    }, DOM_POLL_MS);
  }

  function stopDomFallback() {
    if (domTimer) clearInterval(domTimer);
    domTimer = null;
    lastDomFen = null;
  }

  // ---------------------------------------------------------------- UI
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function ensureEngine() {
    createEngine();
  }

  function startHack() {
    if (hackRunning) return;
    if (!contextAlive()) {
      onContextLost();
      return;
    }
    hackRunning = true;
    lastFen = null;
    lastDomFen = null;
    ensureEngine();
    sendToMain({ action: "request-fen" });
    button.textContent = t("stopHack");
    button.classList.add("chesscheat-running");
    setStatus(t("starting"));
  }

  function stopHack() {
    hackRunning = false;
    if (pendingAutoTimer) {
      clearTimeout(pendingAutoTimer);
      pendingAutoTimer = null;
    }
    stopSearch();
    clearHighlight();
    stopDomFallback();
    lastFen = null;
    button.textContent = t("startHack");
    button.classList.remove("chesscheat-running");
    setStatus(t("stopped"));
    sendToMain({ action: "request-fen" });
  }

  function buildUi(container) {
    if (container.querySelector(".chesscheat-panel")) return;

    var panel = document.createElement("div");
    panel.className = "chesscheat-panel";

    button = document.createElement("button");
    button.id = "chesscheat-button";
    button.className = "chesscheat-button";
    button.textContent = t("startHack");
    button.addEventListener("click", function () {
      if (hackRunning) stopHack();
      else startHack();
    });

    var depthLabel = document.createElement("label");
    depthLabel.className = "chesscheat-depth-label";
    depthLabel.textContent = t("depth");

    var depthInput = document.createElement("input");
    depthInput.id = "chesscheat-depth";
    depthInput.className = "chesscheat-depth";
    depthInput.type = "number";
    depthInput.min = "1";
    depthInput.max = "40";
    depthInput.value = String(depth);

    var status = document.createElement("div");
    status.className = "chesscheat-status";
    status.textContent = t("idle");
    statusEl = status;

    var autoWrap = document.createElement("label");
    autoWrap.className = "chesscheat-auto";
    var autoBox = document.createElement("input");
    autoBox.type = "checkbox";
    autoBox.id = "chesscheat-autoplay";
    autoBox.checked = autoPlay;
    var autoText = document.createElement("span");
    autoText.textContent = t("autoPlay");
    autoWrap.appendChild(autoBox);
    autoWrap.appendChild(autoText);

    var humanWrap = document.createElement("label");
    humanWrap.className = "chesscheat-human";
    var humanText = document.createElement("span");
    humanText.textContent = t("human");
    var humanSelect = document.createElement("select");
    humanSelect.id = "chesscheat-human";
    [
      ["off", t("optOff")],
      ["v1", t("optV1")],
      ["v2", t("optV2")],
      ["v3", t("optV3")],
      ["bullet", t("optBullet")],
    ].forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt[0];
      o.textContent = opt[1];
      humanSelect.appendChild(o);
    });
    humanSelect.value = humanization;
    humanWrap.appendChild(humanText);
    humanWrap.appendChild(humanSelect);

    var ratingWrap = document.createElement("label");
    ratingWrap.className = "chesscheat-rating";
    var ratingText = document.createElement("span");
    ratingText.textContent = t("rating");
    var ratingSelect = document.createElement("select");
    ratingSelect.id = "chesscheat-rating";
    RATING_CHOICES.forEach(function (r) {
      var o = document.createElement("option");
      o.value = String(r);
      o.textContent = String(r);
      ratingSelect.appendChild(o);
    });
    ratingSelect.value = String(targetRating);
    ratingWrap.appendChild(ratingText);
    ratingWrap.appendChild(ratingSelect);

    function refreshHumanUi() {
      ratingWrap.style.display = humanization === "v2" ? "" : "none";
    }
    refreshHumanUi();

    function saveSetting(key, value) {
      if (!contextAlive()) return;
      try {
        var data = {};
        data[key] = value;
        chrome.storage.local.set(data);
      } catch (e) {}
    }

    autoBox.addEventListener("change", function () {
      autoPlay = this.checked;
      saveSetting("chesscheatAutoPlay", autoPlay);
      setMultiPV(multiPvForLevel());
      if (autoPlay) {
        if (!hackRunning) startHack();
        else if (lastFen) requestBestMove(lastFen);
      }
    });

    humanSelect.addEventListener("change", function () {
      humanization = this.value;
      saveSetting("chesscheatHuman", humanization);
      refreshHumanUi();
      setMultiPV(multiPvForLevel());
      if (hackRunning && lastFen) requestBestMove(lastFen);
    });

    ratingSelect.addEventListener("change", function () {
      targetRating = parseInt(this.value, 10) || 1800;
      saveSetting("chesscheatRating", targetRating);
      if (hackRunning && lastFen) requestBestMove(lastFen);
    });

    depthInput.addEventListener("input", function () {
      var v = parseInt(this.value, 10);
      if (isNaN(v)) return;
      v = Math.max(1, Math.min(40, v));
      depth = v;
      saveSetting("chesscheatDepth", v);
      if (hackRunning && lastFen) requestBestMove(lastFen);
    });

    if (contextAlive()) {
      try {
        chrome.storage.local.get(
          ["chesscheatDepth", "chesscheatAutoPlay", "chesscheatHuman", "chesscheatRating"],
          function (res) {
            var saved = parseInt(res && res.chesscheatDepth, 10);
            if (!isNaN(saved)) {
              depth = Math.max(1, Math.min(40, saved));
              depthInput.value = String(depth);
            }
            if (res && res.chesscheatAutoPlay) {
              autoPlay = true;
              autoBox.checked = true;
            }
            if (
              res &&
              (res.chesscheatHuman === "off" ||
                res.chesscheatHuman === "v1" ||
                res.chesscheatHuman === "v2" ||
                res.chesscheatHuman === "v3" ||
                res.chesscheatHuman === "bullet")
            ) {
              humanization = res.chesscheatHuman;
              humanSelect.value = humanization;
              refreshHumanUi();
            }
            var savedRating = parseInt(res && res.chesscheatRating, 10);
            if (!isNaN(savedRating)) {
              targetRating = savedRating;
              ratingSelect.value = String(targetRating);
            }
          }
        );
      } catch (e) {}
    }

    panel.appendChild(button);
    panel.appendChild(autoWrap);
    panel.appendChild(humanWrap);
    panel.appendChild(ratingWrap);
    var depthWrap = document.createElement("div");
    depthWrap.className = "chesscheat-depth-wrap";
    depthWrap.appendChild(depthLabel);
    depthWrap.appendChild(depthInput);
    panel.appendChild(depthWrap);
    panel.appendChild(status);

    var credit = document.createElement("span");
    credit.className = "chesscheat-credit";
    credit.textContent = t("credit");
    panel.appendChild(credit);

    container.prepend(panel);
  }

  function injectUi() {
    var container =
      document.getElementById("board-layout-main") ||
      document.querySelector(".board-layout-main");
    if (!container) return false;
    buildUi(container);
    return true;
  }

  if (!injectUi()) {
    var uiTimer = setInterval(function () {
      if (injectUi()) clearInterval(uiTimer);
    }, 500);
  }

  console.info("[chesscheat] content script loaded");
})();
