import type { GameId } from "./catalog.ts";
import {
  CHOSUNG_QUESTIONS,
  DRAWING_PROMPTS,
  LIAR_WORDS,
  SAME_ANSWER_PROMPTS,
  WORD_CHAIN_WORDS,
} from "./word-bank.ts";

export type GamePlayer = { id: string; name: string; score: number };
export type GamePhase = "playing" | "finished";
export type GameOptions = { rounds?: number };
export type GameFeedback = { id: string; playerId: string; text: string; kind: "wrong" | "correct"; createdAt: number };

export type GameEnvelope = {
  gameId: GameId;
  phase: GamePhase;
  players: GamePlayer[];
  turn: number;
  round: number;
  winnerIds: string[];
  message: string;
  log: string[];
  feedback?: GameFeedback;
  // Each game owns a different serializable state shape; reducers narrow it by gameId.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: Record<string, any>;
  seed: number;
};

export type GameCommand = {
  type: string;
  playerId: string;
  payload?: Record<string, unknown>;
  now?: number;
};

export type UnoColor = "red" | "yellow" | "green" | "blue";
export type UnoCard = {
  id: string;
  color: UnoColor | null;
  kind: "number" | "skip" | "reverse" | "draw2" | "wild" | "wild4";
  value?: number;
};
export type DavinciTile = {
  id: string;
  color: "black" | "white";
  number: number | null;
  revealed: boolean;
};

const INITIAL_SOUND_I_OR_Y_MEDIALS = new Set([2, 3, 6, 7, 12, 17, 20]); // ㅑ, ㅒ, ㅕ, ㅖ, ㅛ, ㅠ, ㅣ
const WORD_CHAIN_TURN_MS = 20_000;

function seededIndex(seed: number, length: number, salt = 0) {
  const x = Math.sin(seed * 9301 + salt * 49297) * 10000;
  return Math.abs(Math.floor((x - Math.floor(x)) * length)) % length;
}

function uniquePick<T>(items: readonly T[], count: number, seed: number) {
  const chosen: T[] = [];
  let salt = 1;
  while (chosen.length < count && chosen.length < items.length) {
    const item = items[seededIndex(seed, items.length, salt++)];
    if (!chosen.includes(item)) chosen.push(item);
  }
  return chosen;
}

function seededShuffle<T>(items: readonly T[], seed: number) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = seededIndex(seed, index + 1, shuffled.length - index);
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

function createUnoDeck(seed: number) {
  const colors: UnoColor[] = ["red", "yellow", "green", "blue"];
  const cards: UnoCard[] = [];
  let id = 0;
  for (const color of colors) {
    cards.push({ id: `u${id++}`, color, kind: "number", value: 0 });
    for (let copy = 0; copy < 2; copy++) {
      for (let value = 1; value <= 9; value++) cards.push({ id: `u${id++}`, color, kind: "number", value });
      for (const kind of ["skip", "reverse", "draw2"] as const) cards.push({ id: `u${id++}`, color, kind });
    }
  }
  for (let copy = 0; copy < 4; copy++) {
    cards.push({ id: `u${id++}`, color: null, kind: "wild" });
    cards.push({ id: `u${id++}`, color: null, kind: "wild4" });
  }
  return seededShuffle(cards, seed);
}

function createDavinciDeck(seed: number) {
  const tiles: Array<Omit<DavinciTile, "number"> & { number: number }> = [];
  for (const color of ["black", "white"] as const) {
    for (let number = 0; number <= 11; number++) tiles.push({ id: `d-${color}-${number}`, color, number, revealed: false });
  }
  return seededShuffle(tiles, seed);
}

function sortDavinciHand<T extends { color: "black" | "white"; number: number | null }>(hand: T[]) {
  hand.sort((a, b) => Number(a.number) - Number(b.number) || (a.color === "black" ? -1 : 1));
  return hand;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function playerIndex(game: GameEnvelope, playerId: string) {
  return game.players.findIndex((player) => player.id === playerId);
}

function fail(game: GameEnvelope, message: string) {
  return { ...game, message };
}

function answerFeedback(game: GameEnvelope, command: GameCommand, text: string, kind: GameFeedback["kind"] = "wrong") {
  game.message = text;
  game.feedback = {
    id: `${command.now ?? game.seed}-${command.playerId}-${game.round}`,
    playerId: command.playerId,
    text,
    kind,
    createdAt: command.now ?? game.seed,
  };
  return game;
}

function appendLog(game: GameEnvelope, message: string) {
  return [message, ...game.log].slice(0, 16);
}

export function createGame(
  gameId: GameId,
  players: Array<Pick<GamePlayer, "id" | "name">>,
  seed = Date.now(),
  options: GameOptions = {},
): GameEnvelope {
  const seated = players.map((player) => ({ ...player, score: 0 }));
  const base: GameEnvelope = {
    gameId,
    phase: "playing",
    players: seated,
    turn: 0,
    round: 1,
    winnerIds: [],
    message: "게임이 시작됐습니다.",
    log: ["게임 시작"],
    state: {},
    seed,
  };

  switch (gameId) {
    case "gomoku":
      base.state = { size: 15, board: Array(225).fill(null) };
      break;
    case "connect-four":
      base.state = { rows: 6, cols: 7, board: Array(42).fill(null) };
      break;
    case "chess":
      base.state = { board: initialChessBoard(), selected: null };
      break;
    case "word-chain":
      base.state = {
        words: [],
        used: [],
        lastSyllable: "",
        eliminated: [],
        turnDurationMs: WORD_CHAIN_TURN_MS,
        turnEndsAt: seed + WORD_CHAIN_TURN_MS,
      };
      break;
    case "drawing":
      base.state = {
        maxRounds: options.rounds ?? 5,
        drawerIndex: 0,
        promptChoices: uniquePick(DRAWING_PROMPTS, 3, seed),
        prompt: null,
        strokes: [],
        guesses: [],
        solvedBy: [],
        roundEndsAt: null,
        answerRevealUntil: null,
        revealedAnswer: null,
      };
      break;
    case "chosung": {
      const question = CHOSUNG_QUESTIONS[seededIndex(seed, CHOSUNG_QUESTIONS.length)];
      base.state = { ...question, maxRounds: options.rounds ?? 5, initial: toChosung(question.answer), revealed: 0, startedAt: seed, guesses: [] };
      break;
    }
    case "same-answer":
      base.state = {
        prompt: SAME_ANSWER_PROMPTS[seededIndex(seed, SAME_ANSWER_PROMPTS.length)],
        submissions: {},
        results: null,
      };
      break;
    case "liar":
      base.state = {
        word: LIAR_WORDS[seededIndex(seed, LIAR_WORDS.length)],
        liarIndex: seededIndex(seed, Math.max(1, seated.length), 7),
        clues: {},
        votes: {},
        revealed: false,
      };
      break;
    case "uno": {
      const deck = createUnoDeck(seed);
      const hands: Record<string, UnoCard[]> = Object.fromEntries(seated.map((player) => [player.id, []]));
      for (let count = 0; count < 7; count++) {
        for (const player of seated) hands[player.id].push(deck.pop()!);
      }
      const topIndex = deck.findLastIndex((card) => card.kind === "number");
      const [topCard] = deck.splice(topIndex, 1);
      base.state = {
        hands,
        drawPile: deck,
        discardPile: [topCard],
        currentColor: topCard.color,
        direction: 1,
        reshuffleCount: 0,
      };
      base.message = `${seated[0]?.name ?? "첫 플레이어"}님 차례 · ${unoColorName(topCard.color)} 카드`;
      break;
    }
    case "yut":
      base.state = {
        pieces: Object.fromEntries(seated.map((player) => [player.id, [-1, -1, -1, -1]])),
        pendingMoves: [],
        canThrow: true,
        throwCount: 0,
        lastThrow: null,
      };
      base.message = `${seated[0]?.name ?? "첫 플레이어"}님, 윷을 던지세요.`;
      break;
    case "davinci-code": {
      const deck = createDavinciDeck(seed);
      const count = seated.length === 2 ? 4 : 3;
      const hands: Record<string, DavinciTile[]> = {};
      for (const player of seated) hands[player.id] = sortDavinciHand(Array.from({ length: count }, () => deck.pop()!));
      base.state = { hands, deck, pendingTileId: null, pendingPlayerId: null, hasDrawn: false };
      base.message = `${seated[0]?.name ?? "첫 플레이어"}님, 타일을 뽑으세요.`;
      break;
    }
  }
  return base;
}

export function removePlayerFromGame(current: GameEnvelope, playerId: string): GameEnvelope {
  const game = clone(current);
  const removedIndex = playerIndex(game, playerId);
  if (removedIndex < 0) return game;
  const removed = game.players[removedIndex];
  const liarId = game.gameId === "liar" ? game.players[game.state.liarIndex]?.id : null;
  const removedDrawer = game.gameId === "drawing" && game.state.drawerIndex === removedIndex;

  game.players.splice(removedIndex, 1);
  game.winnerIds = game.winnerIds.filter((id) => id !== playerId);
  if (!game.players.length) return game;
  if (removedIndex < game.turn) game.turn -= 1;
  if (game.turn >= game.players.length) game.turn = 0;

  if (game.gameId === "drawing") {
    game.state.solvedBy = (game.state.solvedBy as string[]).filter((id) => id !== playerId);
    game.state.guesses = (game.state.guesses as Array<{ playerId: string }>).filter((item) => item.playerId !== playerId);
    if (removedIndex < game.state.drawerIndex) game.state.drawerIndex -= 1;
    if (removedDrawer) {
      game.state.drawerIndex %= game.players.length;
      game.state.promptChoices = uniquePick(DRAWING_PROMPTS, 3, game.seed + game.round + game.players.length);
      game.state.prompt = null;
      game.state.strokes = [];
      game.state.guesses = [];
      game.state.solvedBy = [];
      game.message = `${game.players[game.state.drawerIndex].name}님이 새 단어를 고르는 중`;
      return game;
    }
    if (game.state.prompt && game.state.solvedBy.length >= game.players.length - 1) return completeDrawingRound(game);
  }

  if (game.gameId === "chosung") game.state.guesses = (game.state.guesses as Array<{ playerId: string }>).filter((item) => item.playerId !== playerId);
  if (game.gameId === "word-chain") {
    game.state.eliminated = ((game.state.eliminated ?? []) as string[]).filter((id) => id !== playerId);
    const active = activeWordChainPlayers(game);
    if (active.length <= 1) return finish(game, active.map((player) => player.id), active.length ? `${active[0].name}님이 마지막까지 살아남았습니다!` : "남은 플레이어가 없습니다.");
    if ((game.state.eliminated as string[]).includes(game.players[game.turn].id)) game.turn = nextWordChainTurn(game, game.turn);
    game.state.turnEndsAt = Date.now() + Number(game.state.turnDurationMs ?? WORD_CHAIN_TURN_MS);
  }
  if (game.gameId === "same-answer") {
    delete game.state.submissions[playerId];
    if (Object.keys(game.state.submissions).length === game.players.length) {
      const submissions = game.state.submissions as Record<string, string>;
      const counts = Object.values(submissions).reduce<Record<string, number>>((acc, value) => { acc[value] = (acc[value] ?? 0) + 1; return acc; }, {});
      game.state.results = Object.entries(submissions).map(([id, value]) => ({ playerId: id, value, unique: counts[value] === 1 }));
      const results = game.state.results as Array<{ playerId: string; unique: boolean }>;
      return finish(game, results.filter((item) => item.unique).map((item) => item.playerId), "남은 참가자의 답을 공개합니다.");
    }
  }
  if (game.gameId === "liar") {
    delete game.state.clues[playerId];
    delete game.state.votes[playerId];
    for (const [voter, target] of Object.entries(game.state.votes)) if (target === playerId) delete game.state.votes[voter];
    if (liarId === playerId) {
      game.state.liarIndex = seededIndex(game.seed + game.round, game.players.length, game.players.length);
      game.state.clues = {};
      game.state.votes = {};
      game.message = "라이어가 다시 정해졌습니다. 설명을 새로 시작하세요.";
      return game;
    }
    game.state.liarIndex = game.players.findIndex((item) => item.id === liarId);
  }
  if (game.gameId === "uno") delete game.state.hands[playerId];
  if (game.gameId === "yut") delete game.state.pieces[playerId];
  if (game.gameId === "davinci-code") {
    delete game.state.hands[playerId];
    if (game.state.pendingPlayerId === playerId) {
      game.state.pendingTileId = null;
      game.state.pendingPlayerId = null;
      game.state.hasDrawn = false;
    }
  }
  game.message = `${removed.name}님이 나갔습니다. 게임을 계속합니다.`;
  game.log = appendLog(game, `${removed.name} 퇴장`);
  return game;
}

export function reduceGame(current: GameEnvelope, command: GameCommand): GameEnvelope {
  const game = advanceTimedGame(current, command.now ?? current.seed);
  if (game.phase === "finished" && command.type !== "REMATCH") return fail(game, "이미 끝난 게임입니다.");
  if (playerIndex(game, command.playerId) < 0) return fail(game, "참가자만 행동할 수 있습니다.");
  if (command.type === "REMATCH") return createGame(game.gameId, game.players, game.seed + 1, { rounds: Number(game.state.maxRounds) || undefined });
  game.feedback = undefined;

  let next: GameEnvelope;
  switch (game.gameId) {
    case "gomoku":
      next = reduceGomoku(game, command); break;
    case "connect-four":
      next = reduceConnectFour(game, command); break;
    case "chess":
      next = reduceChess(game, command); break;
    case "word-chain":
      next = reduceWordChain(game, command); break;
    case "drawing":
      next = reduceDrawing(game, command); break;
    case "chosung":
      next = reduceChosung(game, command); break;
    case "same-answer":
      next = reduceSameAnswer(game, command); break;
    case "liar":
      next = reduceLiar(game, command); break;
    case "uno":
      next = reduceUno(game, command); break;
    case "yut":
      next = reduceYut(game, command); break;
    case "davinci-code":
      next = reduceDavinciCode(game, command); break;
  }
  if (next.phase === "finished" && !next.state.finishedAt) next.state.finishedAt = command.now ?? next.seed;
  return next;
}

export function advanceTimedGame(current: GameEnvelope, now: number): GameEnvelope {
  const game = clone(current);
  if (game.phase === "finished") return game;
  if (game.gameId === "word-chain") {
    game.state.eliminated ??= [];
    game.state.turnDurationMs ??= WORD_CHAIN_TURN_MS;
    game.state.turnEndsAt ??= now + Number(game.state.turnDurationMs);
    if (now >= Number(game.state.turnEndsAt)) return timeoutWordChainPlayer(game, now);
  }
  if (game.gameId === "chosung") {
    const elapsed = Math.max(0, now - Number(game.state.startedAt ?? now));
    const timedHints = Math.min(3, Math.floor(elapsed / 12_000));
    game.state.revealed = Math.max(Number(game.state.revealed ?? 0), timedHints);
  }
  if (game.gameId === "drawing" && game.state.prompt) {
    const revealUntil = Number(game.state.answerRevealUntil ?? 0);
    if (revealUntil && now >= revealUntil) return completeDrawingRound(game);
    const roundEndsAt = Number(game.state.roundEndsAt ?? 0);
    if (!revealUntil && roundEndsAt && now >= roundEndsAt) {
      game.state.revealedAnswer = game.state.prompt;
      game.state.answerRevealUntil = now + 5_000;
      game.state.roundEndsAt = null;
      game.message = `시간 종료! 정답은 '${game.state.prompt}'`;
    }
  }
  return game;
}

function assertTurn(game: GameEnvelope, playerId: string) {
  return game.players[game.turn]?.id === playerId;
}

function reduceGomoku(game: GameEnvelope, command: GameCommand) {
  if (command.type !== "PLACE") return fail(game, "돌을 놓을 칸을 선택하세요.");
  if (!assertTurn(game, command.playerId)) return fail(game, "내 차례가 아닙니다.");
  const index = Number(command.payload?.index);
  const board = game.state.board as Array<string | null>;
  if (!Number.isInteger(index) || index < 0 || index >= board.length || board[index]) return fail(game, "놓을 수 없는 칸입니다.");
  board[index] = command.playerId;
  const size = game.state.size as number;
  if (hasLine(board, size, size, index, command.playerId, 5)) return finish(game, [command.playerId], `${game.players[game.turn].name} 승리!`);
  if (board.every(Boolean)) return finish(game, [], "무승부입니다.");
  game.turn = (game.turn + 1) % game.players.length;
  game.message = `${game.players[game.turn].name} 차례`;
  game.log = appendLog(game, `${game.players[playerIndex(game, command.playerId)].name} 돌 놓기`);
  return game;
}

function hasLine(board: Array<string | null>, rows: number, cols: number, index: number, id: string, target: number) {
  const row = Math.floor(index / cols);
  const col = index % cols;
  return [[1, 0], [0, 1], [1, 1], [1, -1]].some(([dr, dc]) => {
    let count = 1;
    for (const sign of [-1, 1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < rows && c >= 0 && c < cols && board[r * cols + c] === id) {
        count++;
        r += dr * sign;
        c += dc * sign;
      }
    }
    return count >= target;
  });
}

function reduceConnectFour(game: GameEnvelope, command: GameCommand) {
  if (command.type !== "DROP") return fail(game, "돌을 떨어뜨릴 줄을 선택하세요.");
  if (!assertTurn(game, command.playerId)) return fail(game, "내 차례가 아닙니다.");
  const col = Number(command.payload?.col);
  const { rows, cols, board } = game.state as { rows: number; cols: number; board: Array<string | null> };
  if (!Number.isInteger(col) || col < 0 || col >= cols) return fail(game, "잘못된 줄입니다.");
  let placed = -1;
  for (let row = rows - 1; row >= 0; row--) {
    const index = row * cols + col;
    if (!board[index]) { board[index] = command.playerId; placed = index; break; }
  }
  if (placed < 0) return fail(game, "가득 찬 줄입니다.");
  if (hasLine(board, rows, cols, placed, command.playerId, 4)) return finish(game, [command.playerId], `${game.players[game.turn].name} 승리!`);
  game.turn = (game.turn + 1) % game.players.length;
  game.message = `${game.players[game.turn].name} 차례`;
  return game;
}

function initialChessBoard() {
  return [
    "bR", "bN", "bB", "bQ", "bK", "bB", "bN", "bR",
    ...Array(8).fill("bP"), ...Array(32).fill(null), ...Array(8).fill("wP"),
    "wR", "wN", "wB", "wQ", "wK", "wB", "wN", "wR",
  ] as Array<string | null>;
}

function reduceChess(game: GameEnvelope, command: GameCommand) {
  if (command.type !== "MOVE") return fail(game, "움직일 말을 선택하세요.");
  if (!assertTurn(game, command.playerId)) return fail(game, "내 차례가 아닙니다.");
  const from = Number(command.payload?.from);
  const to = Number(command.payload?.to);
  const board = game.state.board as Array<string | null>;
  if (![from, to].every((n) => Number.isInteger(n) && n >= 0 && n < 64)) return fail(game, "잘못된 칸입니다.");
  const piece = board[from];
  const color = game.turn === 0 ? "w" : "b";
  if (!piece || piece[0] !== color) return fail(game, "내 말을 선택하세요.");
  if (!isLegalChessMove(board, from, to, piece)) return fail(game, "그 말은 그렇게 움직일 수 없습니다.");
  const captured = board[to];
  board[to] = piece;
  board[from] = null;
  if (piece[1] === "P" && (Math.floor(to / 8) === 0 || Math.floor(to / 8) === 7)) board[to] = `${color}Q`;
  if (captured?.[1] === "K") return finish(game, [command.playerId], `${game.players[game.turn].name}가 왕을 잡았습니다!`);
  game.turn = (game.turn + 1) % 2;
  game.message = `${game.players[game.turn].name} 차례 · 캐주얼 규칙`;
  return game;
}

function isLegalChessMove(board: Array<string | null>, from: number, to: number, piece: string) {
  if (from === to || board[to]?.[0] === piece[0]) return false;
  const fr = Math.floor(from / 8), fc = from % 8, tr = Math.floor(to / 8), tc = to % 8;
  const dr = tr - fr, dc = tc - fc, ar = Math.abs(dr), ac = Math.abs(dc);
  const pathClear = () => {
    const sr = Math.sign(dr), sc = Math.sign(dc);
    let r = fr + sr, c = fc + sc;
    while (r !== tr || c !== tc) { if (board[r * 8 + c]) return false; r += sr; c += sc; }
    return true;
  };
  switch (piece[1]) {
    case "P": {
      const direction = piece[0] === "w" ? -1 : 1;
      const start = piece[0] === "w" ? 6 : 1;
      if (dc === 0 && dr === direction && !board[to]) return true;
      if (dc === 0 && fr === start && dr === direction * 2 && !board[to] && !board[(fr + direction) * 8 + fc]) return true;
      return ac === 1 && dr === direction && Boolean(board[to]);
    }
    case "N": return (ar === 2 && ac === 1) || (ar === 1 && ac === 2);
    case "B": return ar === ac && pathClear();
    case "R": return (dr === 0 || dc === 0) && pathClear();
    case "Q": return (dr === 0 || dc === 0 || ar === ac) && pathClear();
    case "K": return ar <= 1 && ac <= 1;
    default: return false;
  }
}

export function getChessLegalTargets(game: GameEnvelope, playerId: string, from: number) {
  if (game.gameId !== "chess" || game.phase === "finished" || game.players[game.turn]?.id !== playerId) return [];
  const player = playerIndex(game, playerId);
  const board = game.state.board as Array<string | null>;
  const piece = board[from];
  const color = player === 0 ? "w" : "b";
  if (!piece || piece[0] !== color) return [];
  return Array.from({ length: 64 }, (_, index) => index).filter((to) => isLegalChessMove(board, from, to, piece));
}

export function getChessViewIndexes(game: GameEnvelope, playerId: string) {
  const blackView = game.gameId === "chess" && playerIndex(game, playerId) === 1;
  return Array.from({ length: 64 }, (_, index) => blackView ? 63 - index : index);
}

function reduceWordChain(game: GameEnvelope, command: GameCommand) {
  if (command.type !== "SUBMIT_WORD") return fail(game, "단어를 입력하세요.");
  if (((game.state.eliminated ?? []) as string[]).includes(command.playerId)) return fail(game, "시간 초과로 탈락했습니다.");
  if (!assertTurn(game, command.playerId)) return fail(game, "내 차례가 아닙니다.");
  const word = normalizeWord(String(command.payload?.word ?? ""));
  if (word.length < 2) return answerFeedback(game, command, "두 글자 이상의 단어여야 해요.");
  if (!WORD_CHAIN_WORDS.has(word) && command.payload?.dictionaryValid !== true) return answerFeedback(game, command, `'${word || "입력한 단어"}'은(는) 사전에 없어요.`);
  if (game.state.used.includes(word)) return answerFeedback(game, command, `'${word}'은(는) 이미 나온 단어예요.`);
  if (game.state.lastSyllable && !validChainStart(game.state.lastSyllable, word[0])) return answerFeedback(game, command, `'${game.state.lastSyllable}'(으)로 시작해야 해요.`);
  game.state.words.push({ word, playerId: command.playerId });
  game.state.used.push(word);
  game.state.lastSyllable = word.at(-1);
  game.turn = nextWordChainTurn(game, game.turn);
  game.state.turnEndsAt = (command.now ?? game.seed) + Number(game.state.turnDurationMs ?? WORD_CHAIN_TURN_MS);
  game.message = `'${game.state.lastSyllable}'(으)로 시작 · ${game.players[game.turn].name} 차례`;
  game.log = appendLog(game, word);
  return game;
}

function activeWordChainPlayers(game: GameEnvelope) {
  const eliminated = new Set((game.state.eliminated ?? []) as string[]);
  return game.players.filter((player) => !eliminated.has(player.id));
}

function nextWordChainTurn(game: GameEnvelope, from: number) {
  const eliminated = new Set((game.state.eliminated ?? []) as string[]);
  let next = from;
  for (let count = 0; count < game.players.length; count++) {
    next = (next + 1) % game.players.length;
    if (!eliminated.has(game.players[next].id)) return next;
  }
  return from;
}

function timeoutWordChainPlayer(game: GameEnvelope, now: number) {
  const timedOut = game.players[game.turn];
  if (!timedOut) return game;
  const eliminated = new Set((game.state.eliminated ?? []) as string[]);
  eliminated.add(timedOut.id);
  game.state.eliminated = [...eliminated];
  game.log = appendLog(game, `${timedOut.name} 시간 초과`);
  game.feedback = {
    id: `${now}-${timedOut.id}-timeout`,
    playerId: timedOut.id,
    text: "시간 초과로 탈락!",
    kind: "wrong",
    createdAt: now,
  };
  const active = activeWordChainPlayers(game);
  if (active.length <= 1) {
    const finished = finish(game, active.map((player) => player.id), active.length ? `${active[0].name}님이 마지막까지 살아남았습니다!` : "모두 탈락했습니다.");
    finished.state.finishedAt = now;
    return finished;
  }
  game.turn = nextWordChainTurn(game, game.turn);
  game.state.turnEndsAt = now + Number(game.state.turnDurationMs ?? WORD_CHAIN_TURN_MS);
  game.message = `${timedOut.name}님 시간 초과! ${game.players[game.turn].name}님 차례`;
  return game;
}

function normalizeWord(word: string) {
  return word.normalize("NFC").replace(/[^가-힣]/g, "").trim();
}

function validChainStart(last: string, first: string) {
  if (last === first) return true;
  return applyInitialSoundRule(last) === first;
}

function applyInitialSoundRule(syllable: string) {
  const code = syllable.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return null;
  const initial = Math.floor(code / 588);
  const medial = Math.floor((code % 588) / 28);
  const final = code % 28;
  let nextInitial: number | null = null;
  if (initial === 5) nextInitial = INITIAL_SOUND_I_OR_Y_MEDIALS.has(medial) ? 11 : 2; // ㄹ → ㅇ 또는 ㄴ
  if (initial === 2 && INITIAL_SOUND_I_OR_Y_MEDIALS.has(medial)) nextInitial = 11; // ㄴ → ㅇ
  if (nextInitial === null) return null;
  return String.fromCharCode(0xac00 + nextInitial * 588 + medial * 28 + final);
}

function reduceDrawing(game: GameEnvelope, command: GameCommand) {
  const isDrawer = game.players[game.state.drawerIndex]?.id === command.playerId;
  const revealingAnswer = Number(game.state.answerRevealUntil ?? 0) > 0;
  if (command.type === "SELECT_PROMPT") {
    if (!isDrawer || game.state.prompt) return fail(game, "출제자만 단어를 고를 수 있습니다.");
    const selected = String(command.payload?.prompt ?? "");
    if (!game.state.promptChoices.includes(selected)) return fail(game, "제시된 단어 중 하나를 고르세요.");
    game.state.prompt = selected;
    game.state.roundEndsAt = (command.now ?? game.seed) + 60_000;
    game.state.answerRevealUntil = null;
    game.state.revealedAnswer = null;
    game.message = "그림이 시작됐습니다. 정답을 맞혀보세요!";
    return game;
  }
  if (command.type === "DRAW") {
    if (!isDrawer || !game.state.prompt || revealingAnswer) return fail(game, "현재 출제자만 그릴 수 있습니다.");
    const stroke = command.payload?.stroke;
    if (!stroke || game.state.strokes.length >= 1200) return fail(game, "더 이상 선을 추가할 수 없습니다.");
    game.state.strokes.push(stroke);
    return game;
  }
  if (command.type === "CLEAR_DRAWING") {
    if (!isDrawer || revealingAnswer) return fail(game, "출제자만 지울 수 있습니다.");
    game.state.strokes = [];
    return game;
  }
  if (command.type === "GUESS") {
    if (isDrawer || !game.state.prompt || revealingAnswer) return fail(game, "정답을 입력할 차례가 아닙니다.");
    const guess = String(command.payload?.guess ?? "").trim();
    game.state.guesses.push({ playerId: command.playerId, guess });
    if (guess === game.state.prompt && !game.state.solvedBy.includes(command.playerId)) {
      game.state.solvedBy.push(command.playerId);
      const player = game.players[playerIndex(game, command.playerId)];
      player.score += Math.max(20, 100 - game.state.solvedBy.length * 15);
      game.message = `${player.name} 정답!`;
      game.feedback = { id: `${command.now ?? game.seed}-${command.playerId}-${game.round}`, playerId: command.playerId, text: `${player.name} 정답!`, kind: "correct", createdAt: command.now ?? game.seed };
      if (game.state.solvedBy.length >= game.players.length - 1) return completeDrawingRound(game);
      return game;
    }
    return answerFeedback(game, command, `'${guess}' 오답!`);
  }
  if (command.type === "NEXT_ROUND" && isDrawer) return completeDrawingRound(game);
  return fail(game, "그림을 고르거나 정답을 입력하세요.");
}

function completeDrawingRound(game: GameEnvelope) {
  if (game.round >= Number(game.state.maxRounds ?? 5)) return finishByScore(game, `${game.state.maxRounds}라운드가 끝났습니다!`);
  game.round += 1;
  game.state.drawerIndex = (game.state.drawerIndex + 1) % game.players.length;
  game.state.promptChoices = uniquePick(DRAWING_PROMPTS, 3, game.seed + game.round);
  game.state.prompt = null;
  game.state.strokes = [];
  game.state.guesses = [];
  game.state.solvedBy = [];
  game.state.roundEndsAt = null;
  game.state.answerRevealUntil = null;
  game.state.revealedAnswer = null;
  game.message = `${game.players[game.state.drawerIndex].name}님이 단어를 고르는 중`;
  return game;
}

function reduceChosung(game: GameEnvelope, command: GameCommand) {
  if (command.type === "REVEAL_HINT") {
    game.state.revealed = Math.min(3, game.state.revealed + 1);
    game.message = game.state.revealed === 1 ? `분야: ${game.state.category}` : game.state.revealed === 2 ? `힌트: ${game.state.clue}` : `첫 글자: ${game.state.answer[0]}`;
    return game;
  }
  if (command.type !== "GUESS") return fail(game, "정답을 입력하세요.");
  const guess = String(command.payload?.guess ?? "").trim();
  game.state.guesses.push({ playerId: command.playerId, guess });
  if (guess !== game.state.answer) return answerFeedback(game, command, `'${guess}' 오답!`);
  const player = game.players[playerIndex(game, command.playerId)];
  player.score += Math.max(20, 100 - game.state.revealed * 20);
  game.feedback = { id: `${command.now ?? game.seed}-${command.playerId}-${game.round}`, playerId: command.playerId, text: `${player.name} 정답!`, kind: "correct", createdAt: command.now ?? game.seed };
  if (game.round >= Number(game.state.maxRounds ?? 5)) return finishByScore(game, `${game.state.maxRounds}라운드가 끝났습니다!`);
  return nextChosungRound(game, command.now ?? game.seed);
}

function nextChosungRound(game: GameEnvelope, now: number) {
  game.round += 1;
  const currentAnswer = game.state.answer;
  let question = CHOSUNG_QUESTIONS[seededIndex(game.seed + game.round, CHOSUNG_QUESTIONS.length, game.round)];
  if (question.answer === currentAnswer && CHOSUNG_QUESTIONS.length > 1) {
    question = CHOSUNG_QUESTIONS[(CHOSUNG_QUESTIONS.indexOf(question) + 1) % CHOSUNG_QUESTIONS.length];
  }
  game.state = {
    ...question,
    maxRounds: game.state.maxRounds,
    initial: toChosung(question.answer),
    revealed: 0,
    startedAt: now,
    guesses: [],
  };
  game.message = `${game.round}라운드 시작!`;
  return game;
}

function toChosung(value: string) {
  const initials = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
  return [...value].map((char) => {
    const code = char.charCodeAt(0) - 0xac00;
    return code >= 0 && code <= 11171 ? initials[Math.floor(code / 588)] : char;
  }).join(" ");
}

function reduceSameAnswer(game: GameEnvelope, command: GameCommand) {
  if (command.type !== "SUBMIT_ANSWER") return fail(game, "답을 입력하세요.");
  const answer = String(command.payload?.answer ?? "").trim().slice(0, 24);
  if (!answer) return fail(game, "빈 답은 낼 수 없습니다.");
  game.state.submissions[command.playerId] = answer;
  game.message = `${Object.keys(game.state.submissions).length}/${game.players.length} 제출 완료`;
  if (Object.keys(game.state.submissions).length === game.players.length) {
    const counts = Object.values(game.state.submissions as Record<string, string>).reduce<Record<string, number>>((acc, value) => {
      acc[value] = (acc[value] ?? 0) + 1; return acc;
    }, {});
    game.state.results = Object.entries(game.state.submissions as Record<string, string>)
      .map(([playerId, value]) => ({ playerId, value, unique: counts[value] === 1 }));
    for (const result of game.state.results) if (result.unique) game.players[playerIndex(game, result.playerId)].score += 1;
    game.phase = "finished";
    const results = game.state.results as Array<{ playerId: string; unique: boolean }>;
    game.winnerIds = results.filter((result) => result.unique).map((result) => result.playerId);
    game.message = `${game.winnerIds.length}명이 겹치지 않는 답을 냈습니다.`;
  }
  return game;
}

function reduceLiar(game: GameEnvelope, command: GameCommand) {
  if (command.type === "SUBMIT_CLUE") {
    const clue = String(command.payload?.clue ?? "").trim().slice(0, 40);
    if (!clue) return fail(game, "설명을 입력하세요.");
    game.state.clues[command.playerId] = clue;
    game.message = `${Object.keys(game.state.clues).length}/${game.players.length} 설명 완료`;
    return game;
  }
  if (command.type === "VOTE") {
    const targetId = String(command.payload?.targetId ?? "");
    if (playerIndex(game, targetId) < 0 || targetId === command.playerId) return fail(game, "투표할 사람을 선택하세요.");
    game.state.votes[command.playerId] = targetId;
    if (Object.keys(game.state.votes).length === game.players.length) {
      const tally: Record<string, number> = {};
      Object.values(game.state.votes as Record<string, string>).forEach((id) => { tally[id] = (tally[id] ?? 0) + 1; });
      const accused = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
      const liarId = game.players[game.state.liarIndex].id;
      game.state.revealed = true;
      return finish(game, accused === liarId ? game.players.filter((p) => p.id !== liarId).map((p) => p.id) : [liarId], accused === liarId ? "라이어를 찾았습니다!" : "라이어가 살아남았습니다!");
    }
    game.message = `${Object.keys(game.state.votes).length}/${game.players.length} 투표 완료`;
    return game;
  }
  return fail(game, "설명을 적거나 라이어에게 투표하세요.");
}

function unoColorName(color: UnoColor | null) {
  return ({ red: "빨강", yellow: "노랑", green: "초록", blue: "파랑" } as Record<UnoColor, string>)[color as UnoColor] ?? "색상 선택";
}

function nextIndex(game: GameEnvelope, from: number, steps = 1, direction = 1) {
  let index = from;
  for (let count = 0; count < steps; count++) index = (index + direction + game.players.length) % game.players.length;
  return index;
}

function replenishUnoPile(game: GameEnvelope) {
  if (game.state.drawPile.length || game.state.discardPile.length <= 1) return;
  const top = game.state.discardPile.pop();
  game.state.reshuffleCount += 1;
  game.state.drawPile = seededShuffle(game.state.discardPile, game.seed + game.state.reshuffleCount);
  game.state.discardPile = [top];
}

function drawUnoCards(game: GameEnvelope, playerId: string, count: number) {
  const hand = game.state.hands[playerId] as UnoCard[];
  for (let drawn = 0; drawn < count; drawn++) {
    replenishUnoPile(game);
    const card = (game.state.drawPile as UnoCard[]).pop();
    if (!card) break;
    hand.push(card);
  }
}

function isUnoPlayable(card: UnoCard, top: UnoCard, currentColor: UnoColor) {
  if (!card.color) return true;
  if (card.color === currentColor) return true;
  if (card.kind === "number" && top.kind === "number") return card.value === top.value;
  return card.kind !== "number" && card.kind === top.kind;
}

function reduceUno(game: GameEnvelope, command: GameCommand) {
  if (!assertTurn(game, command.playerId)) return fail(game, "지금은 내 차례가 아닙니다.");
  const hand = game.state.hands[command.playerId] as UnoCard[];
  if (command.type === "DRAW_CARD") {
    const before = hand.length;
    drawUnoCards(game, command.playerId, 1);
    if (hand.length === before) return fail(game, "더 뽑을 카드가 없습니다.");
    game.turn = nextIndex(game, game.turn, 1, game.state.direction);
    game.message = `${game.players[game.turn].name}님 차례`;
    game.log = appendLog(game, `${game.players[playerIndex(game, command.playerId)].name} 카드 1장 뽑기`);
    return game;
  }
  if (command.type !== "PLAY_CARD") return fail(game, "카드를 내거나 한 장 뽑으세요.");
  const cardIndex = hand.findIndex((card) => card.id === command.payload?.cardId);
  if (cardIndex < 0) return fail(game, "내 손에 없는 카드입니다.");
  const card = hand[cardIndex];
  const top = (game.state.discardPile as UnoCard[]).at(-1)!;
  if (!isUnoPlayable(card, top, game.state.currentColor)) return fail(game, "같은 색, 숫자 또는 기호의 카드만 낼 수 있습니다.");
  const chosenColor = String(command.payload?.color ?? "") as UnoColor;
  if (!card.color && !["red", "yellow", "green", "blue"].includes(chosenColor)) return fail(game, "와일드 카드의 색을 골라주세요.");

  hand.splice(cardIndex, 1);
  game.state.discardPile.push(card);
  game.state.currentColor = card.color ?? chosenColor;
  game.log = appendLog(game, `${game.players[game.turn].name} ${unoCardLabel(card)} 내기`);
  if (!hand.length) return finish(game, [command.playerId], `${game.players[game.turn].name}님이 카드를 모두 냈습니다!`);

  let steps = 1;
  if (card.kind === "reverse") {
    game.state.direction *= -1;
    if (game.players.length === 2) steps = 2;
  }
  if (card.kind === "skip") steps = 2;
  if (card.kind === "draw2" || card.kind === "wild4") {
    const punishedIndex = nextIndex(game, game.turn, 1, game.state.direction);
    const drawCount = card.kind === "draw2" ? 2 : 4;
    drawUnoCards(game, game.players[punishedIndex].id, drawCount);
    steps = 2;
  }
  game.turn = nextIndex(game, game.turn, steps, game.state.direction);
  game.message = `${game.players[game.turn].name}님 차례 · ${unoColorName(game.state.currentColor)}`;
  return game;
}

function unoCardLabel(card: UnoCard) {
  if (card.kind === "number") return `${unoColorName(card.color)} ${card.value}`;
  return ({ skip: "건너뛰기", reverse: "방향 전환", draw2: "+2", wild: "색상 변경", wild4: "+4" } as Record<string, string>)[card.kind];
}

function yutName(move: number) {
  return ["", "도", "개", "걸", "윷", "모"][move];
}

function finishYutTurn(game: GameEnvelope) {
  game.turn = nextIndex(game, game.turn);
  game.state.canThrow = true;
  game.state.lastThrow = null;
  game.message = `${game.players[game.turn].name}님, 윷을 던지세요.`;
  return game;
}

function reduceYut(game: GameEnvelope, command: GameCommand) {
  if (!assertTurn(game, command.playerId)) return fail(game, "지금은 내 차례가 아닙니다.");
  if (command.type === "THROW") {
    if (!game.state.canThrow) return fail(game, "남은 이동을 먼저 사용하세요.");
    game.state.throwCount += 1;
    let flatCount = 0;
    const sticks = Array.from({ length: 4 }, (_, index) => {
      const flat = seededIndex(game.seed + game.state.throwCount * 31, 2, index + 1) === 1;
      if (flat) flatCount += 1;
      return flat;
    });
    const move = flatCount === 0 ? 5 : flatCount;
    game.state.pendingMoves.push(move);
    game.state.canThrow = move >= 4;
    game.state.lastThrow = { sticks, move, name: yutName(move) };
    game.message = `${yutName(move)}! ${move >= 4 ? "한 번 더 던질 수 있어요." : "움직일 말을 고르세요."}`;
    game.log = appendLog(game, `${game.players[game.turn].name} ${yutName(move)}`);
    return game;
  }
  if (command.type !== "MOVE_PIECE") return fail(game, "윷을 던지거나 말을 움직이세요.");
  const pieceIndex = Number(command.payload?.pieceIndex);
  const moveIndex = Number(command.payload?.moveIndex);
  const pieces = game.state.pieces[command.playerId] as number[];
  if (!Number.isInteger(pieceIndex) || pieceIndex < 0 || pieceIndex >= pieces.length) return fail(game, "움직일 말을 골라주세요.");
  if (!Number.isInteger(moveIndex) || moveIndex < 0 || moveIndex >= game.state.pendingMoves.length) return fail(game, "사용할 이동 수를 골라주세요.");
  const position = pieces[pieceIndex];
  if (position >= 20) return fail(game, "이미 완주한 말입니다.");
  const move = Number(game.state.pendingMoves[moveIndex]);
  const destination = Math.min(20, position + move);
  const movingIndexes = position >= 0
    ? pieces.map((value, index) => value === position ? index : -1).filter((index) => index >= 0)
    : [pieceIndex];
  movingIndexes.forEach((index) => { pieces[index] = destination; });
  if (destination < 20) {
    for (const player of game.players) {
      if (player.id === command.playerId) continue;
      const opponentPieces = game.state.pieces[player.id] as number[];
      opponentPieces.forEach((value, index) => { if (value === destination) opponentPieces[index] = -1; });
    }
  }
  game.state.pendingMoves.splice(moveIndex, 1);
  if (pieces.every((value) => value >= 20)) return finish(game, [command.playerId], `${game.players[game.turn].name}님의 말이 모두 들어왔습니다!`);
  game.message = `${yutName(move)}만큼 이동했습니다.`;
  if (!game.state.pendingMoves.length && !game.state.canThrow) return finishYutTurn(game);
  return game;
}

function davinciAlivePlayers(game: GameEnvelope) {
  return game.players.filter((player) => (game.state.hands[player.id] as DavinciTile[]).some((tile) => !tile.revealed));
}

function finishDavinciTurn(game: GameEnvelope) {
  game.state.pendingTileId = null;
  game.state.pendingPlayerId = null;
  game.state.hasDrawn = false;
  for (let count = 0; count < game.players.length; count++) {
    game.turn = nextIndex(game, game.turn);
    if ((game.state.hands[game.players[game.turn].id] as DavinciTile[]).some((tile) => !tile.revealed)) break;
  }
  game.message = `${game.players[game.turn].name}님, 타일을 뽑으세요.`;
  return game;
}

function reduceDavinciCode(game: GameEnvelope, command: GameCommand) {
  if (!assertTurn(game, command.playerId)) return fail(game, "지금은 내 차례가 아닙니다.");
  const hand = game.state.hands[command.playerId] as DavinciTile[];
  if (command.type === "DRAW_TILE") {
    if (game.state.hasDrawn) return fail(game, "이미 타일을 뽑았습니다.");
    const tile = (game.state.deck as DavinciTile[]).pop();
    game.state.hasDrawn = true;
    if (tile) {
      hand.push(tile);
      sortDavinciHand(hand);
      game.state.pendingTileId = tile.id;
      game.state.pendingPlayerId = command.playerId;
      game.message = "상대의 숨겨진 타일을 골라 숫자를 추리하세요.";
    } else {
      game.message = "남은 타일이 없습니다. 바로 상대 숫자를 추리하세요.";
    }
    return game;
  }
  if (command.type === "END_TURN") {
    if (!game.state.hasDrawn) return fail(game, "먼저 타일을 뽑으세요.");
    return finishDavinciTurn(game);
  }
  if (command.type !== "GUESS_TILE") return fail(game, "타일을 뽑거나 상대 숫자를 추리하세요.");
  if (!game.state.hasDrawn) return fail(game, "먼저 타일을 뽑으세요.");
  const targetPlayerId = String(command.payload?.targetPlayerId ?? "");
  const tileId = String(command.payload?.tileId ?? "");
  const guessedNumber = Number(command.payload?.number);
  if (targetPlayerId === command.playerId || !game.state.hands[targetPlayerId]) return fail(game, "상대의 타일을 골라주세요.");
  const target = (game.state.hands[targetPlayerId] as DavinciTile[]).find((tile) => tile.id === tileId);
  if (!target || target.revealed) return fail(game, "아직 공개되지 않은 타일을 골라주세요.");
  if (!Number.isInteger(guessedNumber) || guessedNumber < 0 || guessedNumber > 11) return fail(game, "0부터 11 사이의 숫자를 골라주세요.");

  if (target.number === guessedNumber) {
    target.revealed = true;
    const targetName = game.players.find((player) => player.id === targetPlayerId)?.name ?? "상대";
    answerFeedback(game, command, `정답! ${targetName}님의 ${guessedNumber} 타일이 공개됐습니다.`, "correct");
    const alive = davinciAlivePlayers(game);
    if (alive.length <= 1) return finish(game, alive.map((player) => player.id), `${alive[0]?.name ?? "마지막 플레이어"}님이 암호를 지켰습니다!`);
    return game;
  }

  const pending = hand.find((tile) => tile.id === game.state.pendingTileId);
  if (pending) pending.revealed = true;
  const actual = target.number;
  const alive = davinciAlivePlayers(game);
  if (alive.length <= 1) return finish(game, alive.map((player) => player.id), `${alive[0]?.name ?? "마지막 플레이어"}님이 암호를 지켰습니다!`);
  finishDavinciTurn(game);
  return answerFeedback(game, command, `${guessedNumber}은(는) 오답! 선택한 타일은 ${actual}이었습니다.`);
}

function finish(game: GameEnvelope, winnerIds: string[], message: string) {
  game.phase = "finished";
  game.winnerIds = winnerIds;
  game.message = message;
  game.log = appendLog(game, message);
  winnerIds.forEach((id) => { const index = playerIndex(game, id); if (index >= 0) game.players[index].score += 1; });
  return game;
}

function finishByScore(game: GameEnvelope, message: string) {
  const highScore = Math.max(...game.players.map((player) => player.score));
  const winnerIds = game.players.filter((player) => player.score === highScore).map((player) => player.id);
  return finish(game, winnerIds, message);
}

export function projectGame(game: GameEnvelope, viewerId: string, now = Date.now()): GameEnvelope {
  const projected = advanceTimedGame(game, now);
  if (projected.feedback && now - projected.feedback.createdAt > 2_200) projected.feedback = undefined;
  if (projected.gameId === "word-chain") projected.state.projectedAt = now;
  if (projected.gameId === "drawing") {
    projected.state.projectedAt = now;
    const isDrawer = projected.players[projected.state.drawerIndex]?.id === viewerId;
    if (!isDrawer) {
      projected.state.promptChoices = [];
      projected.state.prompt = projected.state.answerRevealUntil || projected.phase === "finished"
        ? projected.state.revealedAnswer ?? projected.state.prompt
        : null;
    }
  }
  if (projected.gameId === "chosung" && projected.phase !== "finished") {
    projected.state.firstSyllable = String(projected.state.answer).slice(0, 1);
    projected.state.answer = null;
  }
  if (projected.gameId === "liar") {
    const viewerIndex = playerIndex(projected, viewerId);
    projected.state.isLiar = viewerIndex === projected.state.liarIndex;
    if (projected.state.isLiar && !projected.state.revealed) projected.state.word = null;
    projected.state.liarIndex = projected.state.revealed ? projected.state.liarIndex : null;
  }
  if (projected.gameId === "uno") {
    const hands = projected.state.hands as Record<string, Array<UnoCard | null>>;
    for (const [playerId, hand] of Object.entries(hands)) {
      if (playerId !== viewerId) hands[playerId] = Array(hand.length).fill(null);
    }
    projected.state.drawPile = Array(projected.state.drawPile.length).fill(null);
  }
  if (projected.gameId === "davinci-code") {
    const hands = projected.state.hands as Record<string, DavinciTile[]>;
    for (const [playerId, hand] of Object.entries(hands)) {
      hands[playerId] = hand.map((tile) => ({
        ...tile,
        number: playerId === viewerId || tile.revealed ? tile.number : null,
      }));
    }
    projected.state.deck = Array(projected.state.deck.length).fill(null);
    if (projected.state.pendingPlayerId !== viewerId) projected.state.pendingTileId = null;
  }
  return projected;
}
