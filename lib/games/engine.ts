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

export type GameEnvelope = {
  gameId: GameId;
  phase: GamePhase;
  players: GamePlayer[];
  turn: number;
  round: number;
  winnerIds: string[];
  message: string;
  log: string[];
  state: Record<string, any>;
  seed: number;
};

export type GameCommand = {
  type: string;
  playerId: string;
  payload?: Record<string, any>;
  now?: number;
};

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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function playerIndex(game: GameEnvelope, playerId: string) {
  return game.players.findIndex((player) => player.id === playerId);
}

function fail(game: GameEnvelope, message: string) {
  return { ...game, message };
}

function appendLog(game: GameEnvelope, message: string) {
  return [message, ...game.log].slice(0, 16);
}

export function createGame(
  gameId: GameId,
  players: Array<Pick<GamePlayer, "id" | "name">>,
  seed = Date.now(),
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
      base.state = { words: [], used: [], lastSyllable: "", strikes: {} };
      break;
    case "drawing":
      base.state = {
        drawerIndex: 0,
        promptChoices: uniquePick(DRAWING_PROMPTS, 3, seed),
        prompt: null,
        strokes: [],
        guesses: [],
        solvedBy: [],
      };
      break;
    case "chosung": {
      const question = CHOSUNG_QUESTIONS[seededIndex(seed, CHOSUNG_QUESTIONS.length)];
      base.state = { ...question, initial: toChosung(question.answer), revealed: 0, startedAt: seed, guesses: [] };
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
    case "push-out": {
      const positions: Record<string, { x: number; y: number; alive: boolean }> = {};
      seated.forEach((player, index) => {
        const angle = (Math.PI * 2 * index) / seated.length;
        positions[player.id] = { x: Math.cos(angle) * 0.55, y: Math.sin(angle) * 0.55, alive: true };
      });
      base.state = { positions, radius: 1 };
      break;
    }
  }
  return base;
}

export function reduceGame(current: GameEnvelope, command: GameCommand): GameEnvelope {
  const game = advanceTimedGame(current, command.now ?? current.seed);
  if (game.phase === "finished" && command.type !== "REMATCH") return fail(game, "이미 끝난 게임입니다.");
  if (playerIndex(game, command.playerId) < 0) return fail(game, "참가자만 행동할 수 있습니다.");
  if (command.type === "REMATCH") return createGame(game.gameId, game.players, game.seed + 1);

  switch (game.gameId) {
    case "gomoku":
      return reduceGomoku(game, command);
    case "connect-four":
      return reduceConnectFour(game, command);
    case "chess":
      return reduceChess(game, command);
    case "word-chain":
      return reduceWordChain(game, command);
    case "drawing":
      return reduceDrawing(game, command);
    case "chosung":
      return reduceChosung(game, command);
    case "same-answer":
      return reduceSameAnswer(game, command);
    case "liar":
      return reduceLiar(game, command);
    case "push-out":
      return reducePushOut(game, command);
  }
}

export function advanceTimedGame(current: GameEnvelope, now: number): GameEnvelope {
  const game = clone(current);
  if (game.gameId !== "chosung" || game.phase === "finished") return game;
  const elapsed = Math.max(0, now - Number(game.state.startedAt ?? now));
  const timedHints = Math.min(3, Math.floor(elapsed / 12_000));
  game.state.revealed = Math.max(Number(game.state.revealed ?? 0), timedHints);
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

function reduceWordChain(game: GameEnvelope, command: GameCommand) {
  if (command.type !== "SUBMIT_WORD") return fail(game, "단어를 입력하세요.");
  if (!assertTurn(game, command.playerId)) return fail(game, "내 차례가 아닙니다.");
  const word = normalizeWord(String(command.payload?.word ?? ""));
  if (word.length < 2) return fail(game, "두 글자 이상의 단어를 입력하세요.");
  if (!WORD_CHAIN_WORDS.has(word)) return fail(game, "현재 단어 목록에 없는 단어입니다.");
  if (game.state.used.includes(word)) return fail(game, "이미 나온 단어입니다.");
  if (game.state.lastSyllable && !validChainStart(game.state.lastSyllable, word[0])) return fail(game, `'${game.state.lastSyllable}'(으)로 시작해야 합니다.`);
  game.state.words.push({ word, playerId: command.playerId });
  game.state.used.push(word);
  game.state.lastSyllable = word.at(-1);
  game.turn = (game.turn + 1) % game.players.length;
  game.message = `'${game.state.lastSyllable}'(으)로 시작 · ${game.players[game.turn].name} 차례`;
  game.log = appendLog(game, word);
  return game;
}

function normalizeWord(word: string) {
  return word.normalize("NFC").replace(/[^가-힣]/g, "").trim();
}

function validChainStart(last: string, first: string) {
  if (last === first) return true;
  const alternatives: Record<string, string[]> = {
    녀: ["여"], 뇨: ["요"], 뉴: ["유"], 니: ["이"], 랴: ["야"], 려: ["여"],
    례: ["예"], 료: ["요"], 류: ["유"], 리: ["이"], 라: ["나"], 래: ["내"],
    로: ["노"], 뢰: ["뇌"], 루: ["누"], 르: ["느"],
  };
  return alternatives[last]?.includes(first) ?? false;
}

function reduceDrawing(game: GameEnvelope, command: GameCommand) {
  const isDrawer = game.players[game.state.drawerIndex]?.id === command.playerId;
  if (command.type === "SELECT_PROMPT") {
    if (!isDrawer || game.state.prompt) return fail(game, "출제자만 단어를 고를 수 있습니다.");
    const custom = String(command.payload?.custom ?? "").trim().slice(0, 20);
    const selected = String(command.payload?.prompt ?? "");
    if (!custom && !game.state.promptChoices.includes(selected)) return fail(game, "제시된 단어 중 하나를 고르세요.");
    game.state.prompt = custom || selected;
    game.message = "그림이 시작됐습니다. 정답을 맞혀보세요!";
    return game;
  }
  if (command.type === "DRAW") {
    if (!isDrawer || !game.state.prompt) return fail(game, "현재 출제자만 그릴 수 있습니다.");
    const stroke = command.payload?.stroke;
    if (!stroke || game.state.strokes.length >= 1200) return fail(game, "더 이상 선을 추가할 수 없습니다.");
    game.state.strokes.push(stroke);
    return game;
  }
  if (command.type === "CLEAR_DRAWING") {
    if (!isDrawer) return fail(game, "출제자만 지울 수 있습니다.");
    game.state.strokes = [];
    return game;
  }
  if (command.type === "GUESS") {
    if (isDrawer || !game.state.prompt) return fail(game, "정답을 입력할 차례가 아닙니다.");
    const guess = String(command.payload?.guess ?? "").trim();
    game.state.guesses.push({ playerId: command.playerId, guess });
    if (guess === game.state.prompt && !game.state.solvedBy.includes(command.playerId)) {
      game.state.solvedBy.push(command.playerId);
      const player = game.players[playerIndex(game, command.playerId)];
      player.score += Math.max(20, 100 - game.state.solvedBy.length * 15);
      game.message = `${player.name} 정답!`;
      if (game.state.solvedBy.length >= game.players.length - 1) return nextDrawingRound(game);
    }
    return game;
  }
  if (command.type === "NEXT_ROUND" && isDrawer) return nextDrawingRound(game);
  return fail(game, "그림을 고르거나 정답을 입력하세요.");
}

function nextDrawingRound(game: GameEnvelope) {
  game.round += 1;
  game.state.drawerIndex = (game.state.drawerIndex + 1) % game.players.length;
  game.state.promptChoices = uniquePick(DRAWING_PROMPTS, 3, game.seed + game.round);
  game.state.prompt = null;
  game.state.strokes = [];
  game.state.guesses = [];
  game.state.solvedBy = [];
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
  if (guess !== game.state.answer) return fail(game, "아쉽지만 정답이 아닙니다.");
  const player = game.players[playerIndex(game, command.playerId)];
  player.score += Math.max(20, 100 - game.state.revealed * 20);
  return finish(game, [command.playerId], `${player.name} 정답! ${game.state.answer}`);
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
    game.winnerIds = game.state.results.filter((result: any) => result.unique).map((result: any) => result.playerId);
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

function reducePushOut(game: GameEnvelope, command: GameCommand) {
  if (command.type !== "MOVE") return fail(game, "방향을 선택하세요.");
  const position = game.state.positions[command.playerId];
  if (!position?.alive) return fail(game, "이미 탈락했습니다.");
  let dx = Math.max(-1, Math.min(1, Number(command.payload?.dx ?? 0)));
  let dy = Math.max(-1, Math.min(1, Number(command.payload?.dy ?? 0)));
  const length = Math.hypot(dx, dy) || 1;
  dx = (dx / length) * 0.09; dy = (dy / length) * 0.09;
  position.x += dx; position.y += dy;
  for (const [id, other] of Object.entries(game.state.positions) as Array<[string, any]>) {
    if (id === command.playerId || !other.alive) continue;
    const ox = other.x - position.x, oy = other.y - position.y, distance = Math.hypot(ox, oy);
    if (distance < 0.2) { const force = (0.2 - distance) + 0.06; other.x += (ox / (distance || 1)) * force; other.y += (oy / (distance || 1)) * force; }
  }
  for (const [id, item] of Object.entries(game.state.positions) as Array<[string, any]>) {
    if (item.alive && Math.hypot(item.x, item.y) > game.state.radius) {
      item.alive = false;
      game.log = appendLog(game, `${game.players[playerIndex(game, id)]?.name ?? "플레이어"} 탈락`);
    }
  }
  const alive = game.players.filter((player) => game.state.positions[player.id]?.alive);
  if (alive.length <= 1) return finish(game, alive.map((player) => player.id), alive[0] ? `${alive[0].name} 승리!` : "모두 탈락했습니다.");
  game.message = `${alive.length}명 생존`;
  return game;
}

function finish(game: GameEnvelope, winnerIds: string[], message: string) {
  game.phase = "finished";
  game.winnerIds = winnerIds;
  game.message = message;
  game.log = appendLog(game, message);
  winnerIds.forEach((id) => { const index = playerIndex(game, id); if (index >= 0) game.players[index].score += 1; });
  return game;
}

export function projectGame(game: GameEnvelope, viewerId: string, now = Date.now()): GameEnvelope {
  const projected = advanceTimedGame(game, now);
  if (game.gameId === "drawing") {
    const isDrawer = game.players[game.state.drawerIndex]?.id === viewerId;
    if (!isDrawer) {
      projected.state.promptChoices = [];
      projected.state.prompt = game.phase === "finished" ? game.state.prompt : null;
    }
  }
  if (game.gameId === "chosung" && game.phase !== "finished") {
    projected.state.firstSyllable = String(game.state.answer).slice(0, 1);
    projected.state.answer = null;
  }
  if (game.gameId === "liar") {
    const viewerIndex = playerIndex(game, viewerId);
    projected.state.isLiar = viewerIndex === game.state.liarIndex;
    projected.state.word = projected.state.isLiar || game.state.revealed ? game.state.word : game.state.word;
    if (projected.state.isLiar && !game.state.revealed) projected.state.word = null;
    projected.state.liarIndex = game.state.revealed ? game.state.liarIndex : null;
  }
  return projected;
}
