// Runs in the MAIN world (page context) so it can use chess.com's own
// `wc-chess-board` custom element API: `board.game.getFEN()`,
// `board.game.getPlayingAs()` and `board.game.markings`.
// It talks to the isolated content script (scripts/main.js) over postMessage.
(function () {
  "use strict";

  var TAG = "chesscheat";
  var BOARD_SELECTOR = "wc-chess-board, chess-board, #board-single, #board";
  var POLL_MS = 250;

  var board = null;
  var lastFen = null;
  var lastPlayingAs = null;
  var lastFlipped = null;
  var lastTurn = null;
  var reportedNoApi = false;

  function findBoard() {
    return document.querySelector(BOARD_SELECTOR);
  }

  function toContent(type, payload) {
    var msg = payload || {};
    msg["__" + TAG] = TAG;
    msg.dir = "to-content";
    msg.type = type;
    window.postMessage(msg, "*");
  }

  function gameApi() {
    return board && board.game && typeof board.game.getFEN === "function"
      ? board.game
      : null;
  }

  function readAndPost() {
    var b = findBoard();
    if (!b) return;
    board = b;

    var g = gameApi();
    if (!g) {
      if (!reportedNoApi) {
        reportedNoApi = true;
        toContent("no-api", {});
      }
      return;
    }
    reportedNoApi = false;

    var fen;
    try {
      fen = g.getFEN();
    } catch (e) {
      return;
    }
    if (!fen || typeof fen !== "string") return;

    var playingAs = lastPlayingAs;
    try {
      if (typeof g.getPlayingAs === "function") playingAs = g.getPlayingAs();
    } catch (e) {}

    var flipped = lastFlipped;
    try {
      if (typeof g.getOptions === "function") {
        flipped = !!(g.getOptions() || {}).flipped;
      }
    } catch (e) {}

    var turn = lastTurn;
    try {
      if (typeof g.getTurn === "function") turn = g.getTurn();
    } catch (e) {}

    if (
      fen !== lastFen ||
      playingAs !== lastPlayingAs ||
      flipped !== lastFlipped ||
      turn !== lastTurn
    ) {
      lastFen = fen;
      lastPlayingAs = playingAs;
      lastFlipped = flipped;
      lastTurn = turn;
      toContent("fen", {
        fen: fen,
        playingAs: playingAs,
        flipped: flipped,
        turn: turn,
      });
    }
  }

  function clearMarkings(g) {
    if (!g || !g.markings) return;
    try {
      if (typeof g.markings.removeAll === "function") g.markings.removeAll();
    } catch (e) {}
  }

  function addMarking(g, marking) {
    if (!g || !g.markings) return;
    try {
      if (typeof g.markings.addOne === "function") g.markings.addOne(marking);
    } catch (e) {}
  }

  function applyHighlight(from, to) {
    var g = gameApi();
    if (!g) return;
    clearMarkings(g);
    var color = "#e63946";
    addMarking(g, { type: "arrow", data: { color: color, from: from, to: to } });
  }

  function playMove(from, to, promotion) {
    var g = gameApi();
    if (!g || typeof g.move !== "function") return;
    var move = { from: from, to: to, userGenerated: true };
    if (promotion) move.promotion = promotion;
    try {
      g.move(move);
    } catch (e) {
      try {
        g.move(from + to + (promotion || ""));
      } catch (e2) {}
    }
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d["__" + TAG] !== TAG || d.dir !== "to-main") return;
    if (d.action === "highlight") {
      applyHighlight(d.from, d.to);
    } else if (d.action === "move") {
      playMove(d.from, d.to, d.promotion);
    } else if (d.action === "clear") {
      clearMarkings(gameApi());
    } else if (d.action === "request-fen") {
      lastFen = null;
      readAndPost();
    }
  });

  setInterval(readAndPost, POLL_MS);
  document.addEventListener("DOMContentLoaded", readAndPost);
  readAndPost();
})();
