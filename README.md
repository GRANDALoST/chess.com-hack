# Chess.com Hack — ChessSniper

**Made by [grandalost](https://github.com/grandalost)**

A Chrome (Manifest V3) extension that shows the best move in any chess.com game using a
**bundled Stockfish 19 engine running locally**. It can also **play for you** with a
configurable "humanization" layer.

> **Disclaimer — read this first.**
> This project is for **learning and research only**. Using it in rated games is cheating and
> violates chess.com's Terms of Service. Accounts caught doing it get **banned**. Auto-play
> uses chess.com's own move API, which is not the same as real mouse input, and no amount of
> humanization makes perfect play undetectable. Use it on an account you can afford to lose.

---

## Features

- **Best-move overlay** — a native-looking arrow plus highlighted squares on the board.
- **Bundled engine** — ships Stockfish 19 (lite, single-threaded WASM). No external CDN and no
  dependency on chess.com's internal engine files.
- **Auto-play** — optionally plays the moves for you.
- **Humanization levels** — from perfect engine play to a rating-simulated human.
- **Automatic language** — the UI follows your browser language (`_locales/`, English default,
  Portuguese included).
- **Resilient** — survives MV3 service-worker restarts and detects a stale extension context.

---

## Install (unpacked)

1. Clone or download this repository.
   ```bash
   git clone https://github.com/grandalost/chess.com-hack.git
   ```
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder.
5. Open a chess.com game and click **Start Hack** next to the board.

No build step is required — the engine files are already committed in `engine/`.

> If you reload the extension in `chrome://extensions` while a chess.com tab is open, the
> content script becomes orphaned. **Refresh the tab (F5)** afterwards — the button will say
> "Reload page (F5)" when this happens.

---

## How it works

```
[ chess.com page ]
   │
   ├─ scripts/page-bridge.js   (MAIN world)
   │     Reads board.game.getFEN() / getTurn() / getPlayingAs(),
   │     draws arrows via game.markings, and plays moves via game.move().
   │     Talks to the content script with window.postMessage.
   │
   └─ scripts/main.js          (isolated world)
         Injects the UI, applies humanization, drives the engine.
         Falls back to scraping the DOM if the board API is unavailable.
              │  chrome.runtime messaging
        scripts/background.js  (MV3 service worker — relay)
              │  chrome.runtime messaging
        offscreen.html + scripts/offscreen.js   (extension origin)
              │  new Worker(...)
        engine/stockfish-19-lite-single.js + .wasm
```

Why this shape?

- chess.com exposes the position on the `<wc-chess-board>` custom element (`board.game`).
  That object is created by the page, so it is **only reachable from the MAIN world**.
- A content script **cannot** create a `Worker` from a `chrome-extension://` URL. The engine
  therefore lives in an **offscreen document** (extension origin), which can.
- MV3 service workers are terminated after ~30 s idle, so the relay stores state in
  `chrome.storage.session` and treats an already-running offscreen document as ready.

### Getting the position

`page-bridge.js` polls `board.game.getFEN()` plus `getTurn()` / `getPlayingAs()` /
`getOptions().flipped` and posts changes to the content script. If the board API is missing,
the content script builds a FEN by scraping `.piece.square-<file><rank>` elements.

---

## UI reference

| Control | What it does |
|---|---|
| **Start Hack / Stop Hack** | Starts or stops the engine and the overlay. |
| **Depth** | Search depth for the engine (see the table below). Ignored in Bullet mode. |
| **Auto-play** | When checked, the extension plays the moves itself. |
| **Human** | Humanization level (see below). |
| **Rating** | Target rating for **Humanized v2** (800–2500). Only shown for v2. |
| **Status line** | Shows "Thinking", "Best: e2 to e4", "Waiting for opponent...", etc. |

### Depth guide (bundled lite engine)

| Depth | Approx. strength | Speed |
|---|---|---|
| 8–10 | ~1500–1800 | instant |
| 12–15 | ~2000–2300 | 1–5 s |
| 18 | ~2300–2500 | a few seconds |
| 20 | ~2400–2700 | 5–20 s |
| 25+ | stronger | tens of seconds / minutes |
| 35–40 | — | will not finish |

Recommended: **18–22**. Higher values give diminishing returns and can make the engine miss
the clock.

---

## Humanization levels

| Level | Move choice | Search depth | Timing |
|---|---|---|---|
| **Off (best move)** | Always the engine's top move | fixed | light random delay |
| **Humanized v1** | 25% chance of a near-equal move (≤ 25 cp) | fixed | random delay, occasional long think |
| **Humanized v2** | Rating-scaled softmax over the top 5 lines + 2–18% blunder chance (80–350 cp) | varies (depth − 0…3) | reaction time + log-normal think, ~10% instant, 15% long, panic when < 20 s |
| **Humanized v3 (time only)** | Always the top move | fixed | same organic timing as v2 |
| **Bullet (1 min)** | Always the top move | `movetime 350 ms` | very fast (80–600 ms), 20% instant |

Humanization only affects play when **Auto-play** is on. Without it, the extension always
suggests the engine's best move.

---

## Script reference

### `scripts/page-bridge.js` (MAIN world)

| Function | Description |
|---|---|
| `findBoard()` | Finds the board element (`wc-chess-board`, `chess-board`, `#board-single`, `#board`). |
| `gameApi()` | Returns `board.game` when it exposes `getFEN()`. |
| `readAndPost()` | Polls FEN / turn / playingAs / flipped and posts changes to the content script. |
| `applyHighlight(from, to)` | Draws a chess.com-native arrow via `game.markings`. |
| `playMove(from, to, promotion)` | Plays a move with `game.move({from,to,promotion,userGenerated:true})`. |
| message listener | Handles `highlight`, `move`, `clear` and `request-fen` actions. |

### `scripts/main.js` (isolated world)

| Function | Description |
|---|---|
| `t(key, subs)` | Localized UI string via `chrome.i18n`. |
| `contextAlive()` / `onContextLost()` | Detect an orphaned extension context and disable the UI cleanly. |
| `handleFen(fen, playingAs, flipped, turn)` | Decides whose turn it is and requests a move. |
| `createEngine()` / `post(cmd)` | Send UCI commands to the engine through the background relay. |
| `onEngineLine(line)` | Parses UCI output (`uciok`, `readyok`, `info`, `bestmove`). |
| `recordInfo(line)` | Stores MultiPV scores/moves for humanized selection. |
| `requestBestMove(fen)` | Sends `position` + `go depth`/`go movetime`. |
| `chooseMove()` / `chooseMoveV1()` / `chooseMoveV2()` | Humanized move selection. |
| `humanDelayMs()` / `humanDelayV1/V2/Bullet` | Human-like thinking time. |
| `scheduleAutoMove()` | Plays the chosen move after the delay. |
| `showBestMove(uci, fen)` | Highlights the move (and schedules auto-play). |
| `buildDomFen()` / `drawDomHighlights()` | DOM-scraping fallback when the board API is unavailable. |
| `buildUi(container)` | Builds the control panel. |

### `scripts/background.js` (service worker)

| Function | Description |
|---|---|
| `ensureOffscreen()` | Creates the offscreen document if needed; treats a live one as ready. |
| `forwardToOffscreen()` / `flushQueue()` | Relay content → offscreen, resilient to worker restarts. |
| `rememberTab()` / `resolveTabId()` | Persist the target tab id in `chrome.storage.session`. |

### `scripts/offscreen.js`

Owns the Stockfish `Worker` (extension origin) and relays UCI lines to the background.

---

## Updating the bundled engine

The engine is vendored from the [`stockfish`](https://www.npmjs.com/package/stockfish) npm
package. To refresh it:

```bash
npm run sync-engine
```

This downloads `stockfish@19.0.1` and copies `stockfish-19-lite-single.js` / `.wasm` into
`engine/`. Then reload the extension.

---

## Limitations & notes

- **Move execution** goes through chess.com's `game.move()`, not simulated mouse input. This
  is the biggest remaining "tell". Simulated pointer events are a possible future improvement.
- **Background tabs** are timer-throttled by Chrome; keep the chess.com tab visible while
  auto-playing.
- **Weighted Matchmaking effects** aside, ratings differ per time control (bullet is the most
  inflated).
- **Stockfish is GPL-3.0.** If you redistribute this extension with the engine binaries, you
  must comply with the GPL (provide source, keep the license notice).

## License

Released under the **GNU General Public License v3.0** (see [LICENSE](LICENSE)) because it
bundles Stockfish, which is GPL-3.0.

## Credits

- **ChessSniper** by [grandalost](https://github.com/grandalost).
- Engine: [Stockfish](https://stockfishchess.org/) and the
  [stockfish.js](https://github.com/nmrugg/stockfish.js) build by Nathan Rugg.
- Original project by [Eugenenoble2005](https://github.com/Eugenenoble2005/chesscheat).
