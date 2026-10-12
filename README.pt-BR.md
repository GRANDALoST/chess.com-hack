# Chess.com Hack — ChessSniper

**Feito por: [grandalost](https://github.com/grandalost)**

Extensão do Chrome (Manifest V3) que mostra o melhor lance em qualquer partida do chess.com
usando um **Stockfish 19 embutido, rodando localmente**. Também pode **jogar sozinha** com uma
camada de "humanização" configurável.

> **Aviso — leia antes.**
> Este projeto é apenas para **estudo e pesquisa**. Usar isso em partidas ranqueadas é trapaça e
> viola os Termos de Serviço do chess.com. Contas pegas são **banidas**. O auto-play usa a API
> interna de lances do chess.com, que não é o mesmo que clique real de mouse, e nenhuma
> humanização torna o jogo perfeito indetectável. Use numa conta que você aceite perder.

> English version: [README.md](README.md)

---

## Funcionalidades

- **Sobreposição do melhor lance** — seta nativa + casas destacadas no tabuleiro.
- **Motor embutido** — Stockfish 19 (lite, single-threaded WASM). Sem CDN e sem depender dos
  arquivos internos do chess.com.
- **Auto-play** — joga os lances por você.
- **Níveis de humanização** — do motor perfeito até um humano simulado por rating.
- **Idioma automático** — a interface segue o idioma do navegador (`_locales/`, padrão inglês,
  português incluído).
- **Resiliente** — sobrevive ao encerramento do service worker do MV3 e detecta contexto
  inválido da extensão.

---

## Instalação (modo desenvolvedor)

1. Clone ou baixe este repositório.
   ```bash
   git clone https://github.com/grandalost/chess.com-hack.git
   ```
2. Abra `chrome://extensions`.
3. Ative o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e selecione esta pasta.
5. Abra uma partida no chess.com e clique em **Iniciar Hack** ao lado do tabuleiro.

Não precisa buildar — os arquivos do motor já estão versionados em `engine/`.

> Se você recarregar a extensão em `chrome://extensions` com uma aba do chess.com aberta, o
> content script fica órfão. **Atualize a aba (F5)** depois — o botão mostrará
> "Recarregar página (F5)" quando isso acontecer.

---

## Como funciona

```
[ página do chess.com ]
   │
   ├─ scripts/page-bridge.js   (world MAIN)
   │     Lê board.game.getFEN() / getTurn() / getPlayingAs(),
   │     desenha setas via game.markings e joga lances via game.move().
   │     Conversa com o content script por window.postMessage.
   │
   └─ scripts/main.js          (world isolado)
         Injeta a UI, aplica humanização e comanda o motor.
         Faz fallback lendo o DOM se a API do tabuleiro não existir.
              │  mensagens chrome.runtime
        scripts/background.js  (service worker do MV3 — ponte)
              │  mensagens chrome.runtime
        offscreen.html + scripts/offscreen.js   (origem da extensão)
              │  new Worker(...)
        engine/stockfish-19-lite-single.js + .wasm
```

Por que desse jeito?

- O chess.com expõe a posição no elemento `<wc-chess-board>` (`board.game`). Esse objeto é
  criado pela página, então só é acessível pelo **MAIN world**.
- Um content script **não pode** criar `Worker` a partir de uma URL `chrome-extension://`.
  Por isso o motor roda num **documento offscreen** (origem da extensão), que pode.
- Service workers do MV3 são encerrados após ~30s ociosos, então a ponte guarda estado em
  `chrome.storage.session` e considera o offscreen já ativo como pronto.

---

## Referência da interface

| Controle | O que faz |
|---|---|
| **Iniciar Hack / Parar Hack** | Liga/desliga o motor e a sobreposição. |
| **Profundidade** | Depth da busca (ver tabela). Ignorado no modo Bullet. |
| **Jogar sozinho** | Marcado, a extensão joga os lances por você. |
| **Humano** | Nível de humanização (ver abaixo). |
| **Rating** | Rating alvo do **Humanizado v2** (800–2500). Só aparece no v2. |
| **Linha de status** | Mostra "Pensando", "Melhor: e2 para e4", "Esperando o oponente...", etc. |

### Guia de Depth (motor lite embutido)

| Depth | Força aprox. | Velocidade |
|---|---|---|
| 8–10 | ~1500–1800 | instantâneo |
| 12–15 | ~2000–2300 | 1–5 s |
| 18 | ~2300–2500 | poucos segundos |
| 20 | ~2400–2700 | 5–20 s |
| 25+ | mais forte | dezenas de segundos / minutos |
| 35–40 | — | não termina |

Recomendado: **18–22**. Valores altos dão retorno decrescente e podem fazer você perder no
relógio.

---

## Níveis de humanização

| Nível | Escolha do lance | Depth | Tempo |
|---|---|---|---|
| **Desligado (melhor lance)** | Sempre o melhor lance | fixo | atraso leve aleatório |
| **Humanizado v1** | 25% de chance de um lance quase igual (≤ 25 cp) | fixo | atraso aleatório + pensada longa ocasional |
| **Humanizado v2** | Softmax pelos 5 melhores conforme o rating + 2–18% de blunder (80–350 cp) | varia (depth − 0…3) | reação + pensada log-normal, ~10% instantâneo, 15% longa, pânico com < 20 s |
| **Humanizado v3 (só tempo)** | Sempre o melhor lance | fixo | mesmo tempo orgânico do v2 |
| **Bullet (1 min)** | Sempre o melhor lance | `movetime 350 ms` | bem rápido (80–600 ms), 20% instantâneo |

A humanização só afeta o jogo quando **Jogar sozinho** está ligado. Sem isso, a extensão sempre
sugere o melhor lance.

---

## Referência dos scripts

### `scripts/page-bridge.js` (MAIN world)

| Função | Descrição |
|---|---|
| `findBoard()` | Acha o tabuleiro (`wc-chess-board`, `chess-board`, `#board-single`, `#board`). |
| `gameApi()` | Retorna `board.game` quando existe `getFEN()`. |
| `readAndPost()` | Lê FEN / turno / playingAs / flipped e envia mudanças ao content script. |
| `applyHighlight(from, to)` | Desenha a seta nativa via `game.markings`. |
| `playMove(from, to, promotion)` | Joga com `game.move({from,to,promotion,userGenerated:true})`. |
| listener de mensagens | Trata as ações `highlight`, `move`, `clear` e `request-fen`. |

### `scripts/main.js` (world isolado)

| Função | Descrição |
|---|---|
| `t(key, subs)` | String localizada via `chrome.i18n`. |
| `contextAlive()` / `onContextLost()` | Detecta contexto órfão e desativa a UI com aviso. |
| `handleFen(fen, playingAs, flipped, turn)` | Decide de quem é a vez e pede um lance. |
| `createEngine()` / `post(cmd)` | Envia comandos UCI ao motor pela ponte. |
| `onEngineLine(line)` | Interpreta a saída UCI (`uciok`, `readyok`, `info`, `bestmove`). |
| `recordInfo(line)` | Guarda notas/lances do MultiPV para a escolha humanizada. |
| `requestBestMove(fen)` | Envia `position` + `go depth`/`go movetime`. |
| `chooseMove()` / `chooseMoveV1()` / `chooseMoveV2()` | Seleção de lance humanizada. |
| `humanDelayMs()` / `humanDelayV1/V2/Bullet` | Tempo de pensada humano. |
| `scheduleAutoMove()` | Joga o lance escolhido após o atraso. |
| `showBestMove(uci, fen)` | Destaca o lance (e agenda o auto-play). |
| `buildDomFen()` / `drawDomHighlights()` | Fallback lendo o DOM se a API não existir. |
| `buildUi(container)` | Monta o painel de controles. |

### `scripts/background.js` (service worker)

| Função | Descrição |
|---|---|
| `ensureOffscreen()` | Cria o documento offscreen se preciso; considera um ativo como pronto. |
| `forwardToOffscreen()` / `flushQueue()` | Ponte content → offscreen, resistente a restart do worker. |
| `rememberTab()` / `resolveTabId()` | Guarda o id da aba alvo em `chrome.storage.session`. |

### `scripts/offscreen.js`

É dono do `Worker` do Stockfish (origem da extensão) e repassa as linhas UCI para a ponte.

---

## Atualizar o motor embutido

O motor vem do pacote npm [`stockfish`](https://www.npmjs.com/package/stockfish). Para
atualizar:

```bash
npm run sync-engine
```

Isso baixa `stockfish@19.0.1` e copia `stockfish-19-lite-single.js` / `.wasm` para `engine/`.
Depois recarregue a extensão.

---

## Limitações e observações

- **Execução do lance** passa pelo `game.move()` do chess.com, não por input de mouse simulado.
  Esse é o maior "tell" que ainda resta. Simular eventos de ponteiro é uma melhoria futura.
- **Abas em segundo plano** sofrem throttling de timers do Chrome; mantenha a aba do chess.com
  visível durante o auto-play.
- **Stockfish é GPL-3.0.** Se você redistribuir a extensão com os binários do motor, precisa
  cumprir a GPL (disponibilizar o código-fonte e manter o aviso de licença).

## Licença

Distribuído sob a **GNU General Public License v3.0** (ver [LICENSE](LICENSE)) porque embute o
Stockfish, que é GPL-3.0.

## Créditos

- **ChessSniper** por [grandalost](https://github.com/grandalost).
- Motor: [Stockfish](https://stockfishchess.org/) e o build
  [stockfish.js](https://github.com/nmrugg/stockfish.js) de Nathan Rugg.
- Projeto original de [Eugenenoble2005](https://github.com/Eugenenoble2005/chesscheat).
