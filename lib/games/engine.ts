import type { GameId } from "./catalog.ts";
import { Chess, DEFAULT_POSITION, type Square } from "chess.js";
import {
  CHOSUNG_QUESTIONS,
  DRAWING_PROMPTS,
  DEFENSE_WORDS,
  LIAR_WORDS,
  SAME_ANSWER_QUESTIONS,
  WORD_CHAIN_WORDS,
} from "./word-bank.ts";

export type GamePlayer = { id: string; name: string; score: number };
export type GamePhase = "playing" | "finished";
export type DefenseDifficulty = "easy" | "medium" | "hard";
export type GameOptions = { rounds?: number; difficulty?: DefenseDifficulty };
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
  isJoker: boolean;
  revealed: boolean;
};
export type RummikubColor = "red" | "blue" | "yellow" | "black";
export type RummikubTile = { id: string; color: RummikubColor | null; number: number | null; isJoker: boolean };
export type WordDefenseEnemy = { id: string; word: string; lane: number; spawnedAt: number; fallDurationMs: number };

const INITIAL_SOUND_I_OR_Y_MEDIALS = new Set([2, 3, 6, 7, 12, 17, 20]); // ㅑ, ㅒ, ㅕ, ㅖ, ㅛ, ㅠ, ㅣ
const WORD_CHAIN_TURN_MS = 20_000;
const SAME_ANSWER_REVEAL_MS = 3_000;
const WORD_DEFENSE_DURATION_MS = 180_000;

const DEFENSE_CONFIG: Record<DefenseDifficulty, {
  baseHp: number; bossHp: number; startIntervalMs: number; endIntervalMs: number; startFallMs: number; endFallMs: number;
  survivalRate: number; killRate: number; completionBonus: number; bossBonus: number; rewardCap: number;
}> = {
  easy: { baseHp: 12, bossHp: 50, startIntervalMs: 3_200, endIntervalMs: 1_250, startFallMs: 22_000, endFallMs: 10_000, survivalRate: 1, killRate: 1, completionBonus: 10, bossBonus: 25, rewardCap: 65 },
  medium: { baseHp: 9, bossHp: 100, startIntervalMs: 2_650, endIntervalMs: 900, startFallMs: 18_000, endFallMs: 7_500, survivalRate: 2, killRate: 2, completionBonus: 18, bossBonus: 50, rewardCap: 125 },
  hard: { baseHp: 7, bossHp: 200, startIntervalMs: 2_200, endIntervalMs: 680, startFallMs: 15_000, endFallMs: 6_000, survivalRate: 3, killRate: 3, completionBonus: 28, bossBonus: 90, rewardCap: 220 },
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

function sameAnswerRound(seed: number, round: number, playerCount: number, usedQuestionIndexes: number[] = []) {
  let questionIndex = seededIndex(seed + round * 97, SAME_ANSWER_QUESTIONS.length, round);
  for (let offset = 0; offset < SAME_ANSWER_QUESTIONS.length && usedQuestionIndexes.includes(questionIndex); offset++) {
    questionIndex = (questionIndex + 1) % SAME_ANSWER_QUESTIONS.length;
  }
  const question = SAME_ANSWER_QUESTIONS[questionIndex];
  const optionCount = Math.min(question.options.length, Math.max(4, playerCount + 1));
  return {
    questionIndex,
    prompt: question.prompt,
    options: uniquePick(question.options, optionCount, seed + round * 131),
  };
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
  const tiles: DavinciTile[] = [];
  let id = 0;
  for (const color of ["black", "white"] as const) {
    for (let number = 0; number <= 11; number++) tiles.push({ id: `d${id++}`, color, number, isJoker: false, revealed: false });
    tiles.push({ id: `d${id++}`, color, number: null, isJoker: true, revealed: false });
  }
  return seededShuffle(tiles, seed);
}

function createRummikubDeck(seed: number) {
  const colors: RummikubColor[] = ["red", "blue", "yellow", "black"];
  const tiles: RummikubTile[] = [];
  let id = 0;
  for (let copy = 0; copy < 2; copy++) {
    for (const color of colors) {
      for (let number = 1; number <= 13; number++) tiles.push({ id: `r${id++}`, color, number, isJoker: false });
    }
  }
  tiles.push({ id: `r${id++}`, color: null, number: null, isJoker: true });
  tiles.push({ id: `r${id++}`, color: null, number: null, isJoker: true });
  return seededShuffle(tiles, seed);
}

function sortRummikubRack(rack: RummikubTile[]) {
  const colorOrder: Record<RummikubColor, number> = { red: 0, blue: 1, yellow: 2, black: 3 };
  rack.sort((a, b) => Number(a.isJoker) - Number(b.isJoker)
    || Number(a.number) - Number(b.number)
    || colorOrder[a.color ?? "black"] - colorOrder[b.color ?? "black"]);
  return rack;
}

type RummikubMeldAnalysis = { valid: boolean; score: number; type: "group" | "run" | null; ordered: RummikubTile[] };

function analyzeRummikubMeld(tiles: RummikubTile[]): RummikubMeldAnalysis {
  if (tiles.length < 3) return { valid: false, score: 0, type: null, ordered: tiles };
  const jokers = tiles.filter((tile) => tile.isJoker);
  const numbered = tiles.filter((tile) => !tile.isJoker);
  if (!numbered.length) return { valid: false, score: 0, type: null, ordered: tiles };

  const sameNumber = numbered.every((tile) => tile.number === numbered[0].number);
  const uniqueColors = new Set(numbered.map((tile) => tile.color)).size === numbered.length;
  if (tiles.length <= 4 && sameNumber && uniqueColors) {
    const colorOrder: Record<RummikubColor, number> = { red: 0, blue: 1, yellow: 2, black: 3 };
    const ordered = [...numbered].sort((a, b) => colorOrder[a.color!] - colorOrder[b.color!]).concat(jokers);
    return { valid: true, score: Number(numbered[0].number) * tiles.length, type: "group", ordered };
  }

  if (tiles.length > 13 || !numbered.every((tile) => tile.color === numbered[0].color)) return { valid: false, score: 0, type: null, ordered: tiles };
  const numbers = numbered.map((tile) => Number(tile.number));
  if (new Set(numbers).size !== numbers.length) return { valid: false, score: 0, type: null, ordered: tiles };
  let chosenStart = -1;
  for (let start = 14 - tiles.length; start >= 1; start--) {
    if (numbers.every((number) => number >= start && number < start + tiles.length)) {
      chosenStart = start;
      break;
    }
  }
  if (chosenStart < 0) return { valid: false, score: 0, type: null, ordered: tiles };
  const byNumber = new Map(numbered.map((tile) => [Number(tile.number), tile]));
  const spareJokers = [...jokers];
  const ordered = Array.from({ length: tiles.length }, (_, index) => byNumber.get(chosenStart + index) ?? spareJokers.shift()!);
  const score = tiles.length * (chosenStart * 2 + tiles.length - 1) / 2;
  return { valid: true, score, type: "run", ordered };
}

function defenseWord(seed: number, spawnCount: number, progress: number) {
  let bank: readonly string[];
  if (progress < 0.25) bank = DEFENSE_WORDS.short;
  else if (progress < 0.55) bank = [...DEFENSE_WORDS.short, ...DEFENSE_WORDS.medium];
  else if (progress < 0.78) bank = [...DEFENSE_WORDS.medium, ...DEFENSE_WORDS.long];
  else bank = [...DEFENSE_WORDS.long, ...DEFENSE_WORDS.mixed];
  return bank[seededIndex(seed + spawnCount * 53, bank.length, spawnCount + 11)];
}

function normalizeDefenseInput(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase("ko-KR");
}

function sortDavinciHand<T extends { color: "black" | "white"; number: number | null; isJoker: boolean }>(hand: T[]) {
  const jokers = hand.filter((tile) => tile.isJoker);
  const numbers = hand.filter((tile) => !tile.isJoker).sort((a, b) => Number(a.number) - Number(b.number) || (a.color === "black" ? -1 : 1));
  hand.splice(0, hand.length, ...numbers, ...jokers);
  return hand;
}

function insertDavinciTile(hand: DavinciTile[], tile: DavinciTile) {
  if (tile.isJoker) {
    hand.push(tile);
    return;
  }
  const insertionIndex = hand.findIndex((current) => !current.isJoker && (
    Number(current.number) > Number(tile.number)
    || (current.number === tile.number && current.color === "white" && tile.color === "black")
  ));
  hand.splice(insertionIndex < 0 ? hand.length : insertionIndex, 0, tile);
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
    case "go": {
      const board = Array<string | null>(19 * 19).fill(null);
      base.state = {
        size: 19,
        board,
        captures: Object.fromEntries(seated.map((player) => [player.id, 0])),
        consecutivePasses: 0,
        mode: "play",
        deadStones: [],
        scoreConfirmations: [],
        komi: 6.5,
        positionHistory: [goBoardSignature(board)],
        lastMove: null,
        finalScore: null,
      };
      base.message = `${seated[0]?.name ?? "흑"}이 흑으로 먼저 둡니다.`;
      break;
    }
    case "connect-four":
      base.state = { rows: 6, cols: 7, board: Array(42).fill(null) };
      break;
    case "chess":
      base.state = {
        board: initialChessBoard(),
        fen: DEFAULT_POSITION,
        lastMove: null,
        inCheck: false,
      };
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
    case "same-answer": {
      const firstRound = sameAnswerRound(seed, 1, seated.length);
      base.state = {
        ...firstRound,
        maxRounds: options.rounds === 10 ? 10 : 5,
        usedQuestionIndexes: [firstRound.questionIndex],
        submissions: {},
        results: null,
        revealUntil: null,
      };
      break;
    }
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
        pendingDraw: 0,
        pendingDrawKind: null,
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
      const unplacedJokers: Record<string, string[]> = {};
      for (const player of seated) {
        hands[player.id] = sortDavinciHand(Array.from({ length: count }, () => deck.pop()!));
        unplacedJokers[player.id] = hands[player.id].filter((tile) => tile.isJoker).map((tile) => tile.id);
      }
      base.state = { hands, deck, pendingTileId: null, pendingPlayerId: null, hasDrawn: false, hasGuessed: false, comboCount: 0, comboEvent: null, unplacedJokers };
      base.message = Object.values(unplacedJokers).some((tileIds) => tileIds.length)
        ? "조커를 받은 플레이어가 먼저 조커의 위치를 정해주세요."
        : `${seated[0]?.name ?? "첫 플레이어"}님, 타일을 뽑으세요.`;
      break;
    }
    case "rummikub": {
      const pool = createRummikubDeck(seed);
      const racks: Record<string, RummikubTile[]> = Object.fromEntries(seated.map((player) => [player.id, []]));
      for (let count = 0; count < 14; count++) {
        for (const player of seated) racks[player.id].push(pool.pop()!);
      }
      Object.values(racks).forEach(sortRummikubRack);
      base.state = {
        racks,
        pool,
        table: [],
        opened: Object.fromEntries(seated.map((player) => [player.id, false])),
        consecutivePasses: 0,
        turnSnapshot: {
          playerId: seated[0]?.id,
          rack: clone(racks[seated[0]?.id] ?? []),
          table: [],
          addedTileIds: [],
          manipulatedTable: false,
        },
      };
      base.message = `${seated[0]?.name ?? "첫 플레이어"}님 차례 · 최초 등록은 30점 이상입니다.`;
      break;
    }
    case "word-defense": {
      const difficulty: DefenseDifficulty = options.difficulty === "medium" || options.difficulty === "hard" ? options.difficulty : "easy";
      const config = DEFENSE_CONFIG[difficulty];
      base.state = {
        difficulty,
        startedAt: seed,
        endsAt: seed + WORD_DEFENSE_DURATION_MS,
        durationMs: WORD_DEFENSE_DURATION_MS,
        projectedAt: seed,
        nextSpawnAt: seed + 1_200,
        spawnCount: 0,
        enemies: [],
        baseHp: config.baseHp,
        maxBaseHp: config.baseHp,
        typedKills: Object.fromEntries(seated.map((player) => [player.id, 0])),
        destroyed: Object.fromEntries(seated.map((player) => [player.id, 0])),
        boomCharges: Object.fromEntries(seated.map((player) => [player.id, 0])),
        boss: null,
        bossSpawned: false,
        bossDefeated: false,
        lastEvent: null,
        goldRewards: {},
      };
      base.message = `3분 협동 방어 시작 · ${difficulty.toUpperCase()} · 승리 기록에는 반영되지 않습니다.`;
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
  if (game.gameId === "rummikub") {
    delete game.state.racks[playerId];
    delete game.state.opened[playerId];
    if (game.state.turnSnapshot?.playerId === playerId) startRummikubTurn(game);
  }
  if (game.gameId === "word-defense") {
    delete game.state.typedKills[playerId];
    delete game.state.destroyed[playerId];
    delete game.state.boomCharges[playerId];
  }
  game.message = `${removed.name}님이 나갔습니다. 게임을 계속합니다.`;
  game.log = appendLog(game, `${removed.name} 퇴장`);
  return game;
}

export function reduceGame(current: GameEnvelope, command: GameCommand): GameEnvelope {
  const game = advanceTimedGame(current, command.now ?? current.seed);
  if (game.phase === "finished" && command.type !== "REMATCH") return fail(game, "이미 끝난 게임입니다.");
  if (playerIndex(game, command.playerId) < 0) return fail(game, "참가자만 행동할 수 있습니다.");
  if (command.type === "REMATCH") return createGame(game.gameId, game.players, game.seed + 1, {
    rounds: Number(game.state.maxRounds) || undefined,
    difficulty: game.state.difficulty as DefenseDifficulty | undefined,
  });
  game.feedback = undefined;

  let next: GameEnvelope;
  switch (game.gameId) {
    case "gomoku":
      next = reduceGomoku(game, command); break;
    case "go":
      next = reduceGo(game, command); break;
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
    case "rummikub":
      next = reduceRummikub(game, command); break;
    case "word-defense":
      next = reduceWordDefense(game, command); break;
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
  if (game.gameId === "same-answer" && game.state.results) {
    const revealUntil = Number(game.state.revealUntil ?? 0);
    if (revealUntil && now >= revealUntil) {
      if (game.round >= Number(game.state.maxRounds ?? 5)) {
        game.state.revealUntil = null;
        return finishByScore(game, `${game.state.maxRounds}라운드가 모두 끝났습니다!`);
      }
      return nextSameAnswerRound(game);
    }
  }
  if (game.gameId === "word-defense") return advanceWordDefense(game, now);
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

function goBoardSignature(board: Array<string | null>) {
  return board.map((stone) => stone ?? "_").join("|");
}

function goNeighbors(index: number, size: number) {
  const row = Math.floor(index / size);
  const col = index % size;
  const result: number[] = [];
  if (row > 0) result.push(index - size);
  if (row < size - 1) result.push(index + size);
  if (col > 0) result.push(index - 1);
  if (col < size - 1) result.push(index + 1);
  return result;
}

function goGroup(board: Array<string | null>, index: number, size: number) {
  const owner = board[index];
  if (!owner) return { stones: [] as number[], liberties: new Set<number>() };
  const stones: number[] = [];
  const liberties = new Set<number>();
  const seen = new Set([index]);
  const queue = [index];
  while (queue.length) {
    const current = queue.pop()!;
    stones.push(current);
    for (const neighbor of goNeighbors(current, size)) {
      if (!board[neighbor]) liberties.add(neighbor);
      else if (board[neighbor] === owner && !seen.has(neighbor)) {
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return { stones, liberties };
}

function goTerritory(board: Array<string | null>, size: number, playerIds: string[]) {
  const territory = Object.fromEntries(playerIds.map((id) => [id, 0])) as Record<string, number>;
  let neutral = 0;
  const seen = new Set<number>();
  for (let index = 0; index < board.length; index++) {
    if (board[index] || seen.has(index)) continue;
    const region: number[] = [];
    const borders = new Set<string>();
    const queue = [index];
    seen.add(index);
    while (queue.length) {
      const current = queue.pop()!;
      region.push(current);
      for (const neighbor of goNeighbors(current, size)) {
        const owner = board[neighbor];
        if (owner) borders.add(owner);
        else if (!seen.has(neighbor)) {
          seen.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    if (borders.size === 1) territory[[...borders][0]] = (territory[[...borders][0]] ?? 0) + region.length;
    else neutral += region.length;
  }
  return { territory, neutral };
}

function calculateGoScore(game: GameEnvelope) {
  const board = [...game.state.board] as Array<string | null>;
  const dead = new Set<number>((game.state.deadStones ?? []) as number[]);
  const captures = { ...(game.state.captures as Record<string, number>) };
  const blackId = game.players[0].id;
  const whiteId = game.players[1].id;
  for (const index of dead) {
    const owner = board[index];
    if (!owner) continue;
    const capturer = owner === blackId ? whiteId : blackId;
    captures[capturer] = (captures[capturer] ?? 0) + 1;
    board[index] = null;
  }
  const { territory, neutral } = goTerritory(board, Number(game.state.size), [blackId, whiteId]);
  const komi = Number(game.state.komi ?? 6.5);
  const black = (territory[blackId] ?? 0) + (captures[blackId] ?? 0);
  const white = (territory[whiteId] ?? 0) + (captures[whiteId] ?? 0) + komi;
  return {
    black,
    white,
    komi,
    territory,
    captures,
    neutral,
    deadCount: dead.size,
  };
}

function reduceGo(game: GameEnvelope, command: GameCommand) {
  const size = Number(game.state.size ?? 19);
  const board = game.state.board as Array<string | null>;
  const mode = String(game.state.mode ?? "play");
  const currentPlayer = game.players[game.turn];

  if (command.type === "RESIGN") {
    const resigningPlayer = game.players.find((player) => player.id === command.playerId);
    const winner = game.players.find((player) => player.id !== command.playerId);
    game.state.lastMove = { type: "resign", playerId: command.playerId };
    return finish(game, winner ? [winner.id] : [], `${resigningPlayer?.name ?? "플레이어"}이 기권했습니다.`);
  }

  if (mode === "scoring") {
    if (command.type === "RESUME_PLAY") {
      game.state.mode = "play";
      game.state.deadStones = [];
      game.state.scoreConfirmations = [];
      game.state.consecutivePasses = 0;
      game.message = `${game.players[game.turn].name} 차례로 대국을 계속합니다.`;
      game.log = appendLog(game, "계속 두기");
      return game;
    }
    if (command.type === "TOGGLE_DEAD") {
      const index = Number(command.payload?.index);
      if (!Number.isInteger(index) || index < 0 || index >= board.length || !board[index]) return fail(game, "죽은 돌 무리를 선택해 주세요.");
      const group = goGroup(board, index, size).stones;
      const dead = new Set<number>((game.state.deadStones ?? []) as number[]);
      const removing = group.every((stone) => dead.has(stone));
      for (const stone of group) {
        if (removing) dead.delete(stone);
        else dead.add(stone);
      }
      game.state.deadStones = [...dead].sort((a, b) => a - b);
      game.state.scoreConfirmations = [];
      game.message = removing ? "죽은 돌 표시를 취소했습니다." : `${group.length}개의 돌을 죽은 돌로 표시했습니다.`;
      return game;
    }
    if (command.type === "CONFIRM_SCORE") {
      const confirmations = new Set<string>((game.state.scoreConfirmations ?? []) as string[]);
      confirmations.add(command.playerId);
      game.state.scoreConfirmations = [...confirmations];
      if (confirmations.size < game.players.length) {
        game.message = "한 명이 계가 결과를 확인했습니다. 상대의 확인을 기다립니다.";
        return game;
      }
      const score = calculateGoScore(game);
      game.state.finalScore = score;
      const black = game.players[0];
      const white = game.players[1];
      if (score.black === score.white) return finish(game, [], `계가 완료 · 흑 ${score.black}집, 백 ${score.white}집`);
      const winner = score.black > score.white ? black : white;
      const margin = Math.abs(score.black - score.white);
      return finish(game, [winner.id], `${winner.name} ${margin}집 승 · 흑 ${score.black}집, 백 ${score.white}집`);
    }
    return fail(game, "죽은 돌을 표시하고 양쪽이 계가 결과를 확인해 주세요.");
  }

  if (!assertTurn(game, command.playerId)) return fail(game, "내 차례가 아닙니다.");

  if (command.type === "PASS") {
    game.state.consecutivePasses = Number(game.state.consecutivePasses ?? 0) + 1;
    game.state.lastMove = { type: "pass", playerId: command.playerId };
    game.log = appendLog(game, `${currentPlayer.name} 넘기기`);
    game.turn = (game.turn + 1) % game.players.length;
    if (game.state.consecutivePasses >= 2) {
      game.state.mode = "scoring";
      game.state.deadStones = [];
      game.state.scoreConfirmations = [];
      game.message = "두 번 연속 넘겼습니다. 죽은 돌을 표시하고 계가를 확인해 주세요.";
    } else {
      game.message = `${currentPlayer.name}이 넘겼습니다. ${game.players[game.turn].name} 차례입니다.`;
    }
    return game;
  }

  if (command.type !== "PLACE") return fail(game, "빈 교차점을 선택하거나 넘기기를 눌러 주세요.");
  const index = Number(command.payload?.index);
  if (!Number.isInteger(index) || index < 0 || index >= board.length || board[index]) return fail(game, "돌을 놓을 수 없는 자리입니다.");

  const nextBoard = [...board];
  nextBoard[index] = command.playerId;
  const opponentId = game.players[(game.turn + 1) % game.players.length].id;
  const captured = new Set<number>();
  for (const neighbor of goNeighbors(index, size)) {
    if (nextBoard[neighbor] !== opponentId) continue;
    const group = goGroup(nextBoard, neighbor, size);
    if (group.liberties.size === 0) group.stones.forEach((stone) => captured.add(stone));
  }
  captured.forEach((stone) => { nextBoard[stone] = null; });
  if (goGroup(nextBoard, index, size).liberties.size === 0) return fail(game, "자충수에는 둘 수 없습니다.");

  const signature = goBoardSignature(nextBoard);
  const history = (game.state.positionHistory ?? []) as string[];
  if (history.length >= 2 && signature === history[history.length - 2]) return fail(game, "패는 바로 되따낼 수 없습니다. 다른 곳에 한 수 둔 뒤 시도하세요.");
  if (history.includes(signature)) return finish(game, [], "동일한 바둑판 모양이 반복되어 무승부입니다.");

  game.state.board = nextBoard;
  game.state.positionHistory = [...history, signature];
  game.state.captures[command.playerId] = Number(game.state.captures[command.playerId] ?? 0) + captured.size;
  game.state.consecutivePasses = 0;
  game.state.lastMove = { type: "place", playerId: command.playerId, index, captured: captured.size };
  game.turn = (game.turn + 1) % game.players.length;
  game.message = captured.size
    ? `${currentPlayer.name}이 ${captured.size}개를 잡았습니다. ${game.players[game.turn].name} 차례입니다.`
    : `${game.players[game.turn].name} 차례입니다.`;
  game.log = appendLog(game, `${currentPlayer.name} ${Math.floor(index / size) + 1}-${index % size + 1}${captured.size ? ` · ${captured.size}개 잡음` : ""}`);
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

function chessSquare(index: number): Square {
  const row = Math.floor(index / 8);
  const col = index % 8;
  return `${String.fromCharCode(97 + col)}${8 - row}` as Square;
}

function chessIndex(square: string) {
  return (8 - Number(square[1])) * 8 + square.charCodeAt(0) - 97;
}

function chessBoard(chess: Chess) {
  return chess.board().flat().map((piece) => piece ? `${piece.color}${piece.type.toUpperCase()}` : null);
}

function chessFenFromBoard(board: Array<string | null>, turn: number) {
  const placement = Array.from({ length: 8 }, (_, row) => {
    let empty = 0;
    let rank = "";
    for (let col = 0; col < 8; col++) {
      const piece = board[row * 8 + col];
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty) { rank += String(empty); empty = 0; }
      const symbol = piece[1];
      rank += piece[0] === "w" ? symbol : symbol.toLowerCase();
    }
    return rank + (empty ? String(empty) : "");
  }).join("/");
  return `${placement} ${turn === 1 ? "b" : "w"} - - 0 1`;
}

function chessFromGame(game: GameEnvelope) {
  const board = game.state.board as Array<string | null>;
  if (typeof game.state.fen === "string") {
    try {
      const saved = new Chess(game.state.fen);
      const savedBoard = chessBoard(saved);
      if (savedBoard.every((piece, index) => piece === board[index])) return saved;
    } catch {
      // Legacy rooms can fall back to their serialized board below.
    }
  }
  return new Chess(chessFenFromBoard(board, game.turn), { skipValidation: true });
}

function reduceChess(game: GameEnvelope, command: GameCommand) {
  if (command.type !== "MOVE") return fail(game, "움직일 말을 선택하세요.");
  if (!assertTurn(game, command.playerId)) return fail(game, "내 차례가 아닙니다.");
  const from = Number(command.payload?.from);
  const to = Number(command.payload?.to);
  if (![from, to].every((n) => Number.isInteger(n) && n >= 0 && n < 64)) return fail(game, "잘못된 칸입니다.");
  const board = game.state.board as Array<string | null>;
  const piece = board[from];
  const color = game.turn === 0 ? "w" : "b";
  if (!piece || piece[0] !== color) return fail(game, "내 말을 선택하세요.");
  const isPromotionMove = piece[1] === "P" && (to < 8 || to >= 56);
  const requestedPromotion = String(command.payload?.promotion ?? "q").toLowerCase();
  if (isPromotionMove && !["q", "r", "b", "n"].includes(requestedPromotion)) {
    return fail(game, "퀸, 룩, 비숍, 나이트 중 하나로 프로모션하세요.");
  }
  const chess = chessFromGame(game);
  let move;
  try {
    move = chess.move({
      from: chessSquare(from),
      to: chessSquare(to),
      promotion: isPromotionMove ? requestedPromotion : undefined,
    });
  } catch {
    return fail(game, "체스 규칙상 이동할 수 없는 칸입니다.");
  }
  game.state.board = chessBoard(chess);
  game.state.fen = chess.fen();
  game.state.inCheck = chess.inCheck();
  const events: Array<{ type: "castle" | "en-passant" | "promotion" | "check"; label: string }> = [];
  if (move.isKingsideCastle()) events.push({ type: "castle", label: "킹사이드 캐슬링!" });
  if (move.isQueensideCastle()) events.push({ type: "castle", label: "퀸사이드 캐슬링!" });
  if (move.isEnPassant()) events.push({ type: "en-passant", label: "앙파상!" });
  if (move.isPromotion()) {
    const promotionName = ({ q: "퀸", r: "룩", b: "비숍", n: "나이트" } as Record<string, string>)[move.promotion ?? "q"];
    events.push({ type: "promotion", label: `프로모션 to ${promotionName}!` });
  }
  if (chess.inCheck()) events.push({ type: "check", label: "체크!" });
  game.state.lastMove = { from, to, san: move.san, events };
  game.turn = chess.turn() === "w" ? 0 : 1;
  if (chess.isCheckmate()) return finish(game, [command.playerId], `${game.players.find((player) => player.id === command.playerId)?.name} 체크메이트!`);
  if (chess.isDraw()) return finish(game, [], chess.isStalemate() ? "스테일메이트 · 무승부" : "무승부로 게임이 끝났습니다.");
  game.message = chess.inCheck()
    ? `체크! ${game.players[game.turn].name}가 왕을 지켜야 합니다.`
    : `${game.players[game.turn].name} 차례`;
  return game;
}

export function getChessLegalTargets(game: GameEnvelope, playerId: string, from: number) {
  if (game.gameId !== "chess" || game.phase === "finished" || game.players[game.turn]?.id !== playerId) return [];
  const player = playerIndex(game, playerId);
  const board = game.state.board as Array<string | null>;
  const piece = board[from];
  const color = player === 0 ? "w" : "b";
  if (!piece || piece[0] !== color) return [];
  try {
    return chessFromGame(game)
      .moves({ square: chessSquare(from), verbose: true })
      .map((move) => chessIndex(move.to));
  } catch {
    return [];
  }
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
  if (command.type !== "SELECT_ANSWER") return fail(game, "보기를 선택하세요.");
  if (game.state.results) return fail(game, "다음 라운드를 준비하고 있습니다.");
  if (game.state.submissions[command.playerId]) return fail(game, "이미 선택을 완료했습니다.");
  const answer = String(command.payload?.answer ?? "").trim().slice(0, 24);
  if (!(game.state.options as string[]).includes(answer)) return fail(game, "보기 중 하나를 선택하세요.");
  game.state.submissions[command.playerId] = answer;
  game.message = `${Object.keys(game.state.submissions).length}/${game.players.length}명 선택 완료`;
  if (Object.keys(game.state.submissions).length === game.players.length) {
    const counts = Object.values(game.state.submissions as Record<string, string>).reduce<Record<string, number>>((acc, value) => {
      acc[value] = (acc[value] ?? 0) + 1; return acc;
    }, {});
    const scorerIds = Object.entries(game.state.submissions as Record<string, string>)
      .filter(([, value]) => counts[value] === 1)
      .map(([playerId]) => playerId);
    scorerIds.forEach((playerId) => { game.players[playerIndex(game, playerId)].score += 1; });
    game.state.results = { scorerIds };
    game.state.revealUntil = (command.now ?? game.seed) + SAME_ANSWER_REVEAL_MS;
    const scorerNames = scorerIds.map((playerId) => game.players.find((player) => player.id === playerId)?.name).filter(Boolean);
    game.message = scorerNames.length ? `${scorerNames.join(", ")} +1점!` : "이번 라운드는 득점자가 없습니다.";
    game.log = appendLog(game, `${game.round}라운드 · ${game.message}`);
  }
  return game;
}

function nextSameAnswerRound(game: GameEnvelope) {
  game.round += 1;
  const usedQuestionIndexes = game.state.usedQuestionIndexes as number[];
  const nextRound = sameAnswerRound(game.seed, game.round, game.players.length, usedQuestionIndexes);
  game.state = {
    ...nextRound,
    maxRounds: game.state.maxRounds,
    usedQuestionIndexes: [...usedQuestionIndexes, nextRound.questionIndex],
    submissions: {},
    results: null,
    revealUntil: null,
  };
  game.message = `${game.round}라운드 · 남들과 다른 답을 골라보세요!`;
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
  const pendingDraw = Number(game.state.pendingDraw ?? 0);
  const pendingDrawKind = game.state.pendingDrawKind as "draw2" | "wild4" | null;
  if (command.type === "DRAW_CARD") {
    const before = hand.length;
    const drawCount = pendingDraw || 1;
    drawUnoCards(game, command.playerId, drawCount);
    if (hand.length === before) return fail(game, "더 뽑을 카드가 없습니다.");
    game.state.pendingDraw = 0;
    game.state.pendingDrawKind = null;
    game.turn = nextIndex(game, game.turn, 1, game.state.direction);
    game.message = pendingDraw
      ? `${game.players[playerIndex(game, command.playerId)].name}님이 누적 카드 ${hand.length - before}장을 받았습니다. ${game.players[game.turn].name}님 차례`
      : `${game.players[game.turn].name}님 차례`;
    game.log = appendLog(game, `${game.players[playerIndex(game, command.playerId)].name} 카드 ${hand.length - before}장 뽑기`);
    return game;
  }
  if (command.type !== "PLAY_CARD") return fail(game, "카드를 내거나 한 장 뽑으세요.");
  const cardIndex = hand.findIndex((card) => card.id === command.payload?.cardId);
  if (cardIndex < 0) return fail(game, "내 손에 없는 카드입니다.");
  const card = hand[cardIndex];
  const top = (game.state.discardPile as UnoCard[]).at(-1)!;
  if (pendingDraw) {
    const canStack = card.kind === "wild4" || (pendingDrawKind === "draw2" && card.kind === "draw2");
    if (!canStack) return fail(game, pendingDrawKind === "wild4" ? "+4에는 +4만 이어낼 수 있습니다." : "+2 또는 +4로 막거나 누적 카드를 받아야 합니다.");
  } else if (!isUnoPlayable(card, top, game.state.currentColor)) {
    return fail(game, "같은 색, 숫자 또는 기호의 카드만 낼 수 있습니다.");
  }
  const chosenColor = String(command.payload?.color ?? "") as UnoColor;
  if (!card.color && !["red", "yellow", "green", "blue"].includes(chosenColor)) return fail(game, "와일드 카드의 색을 골라주세요.");

  hand.splice(cardIndex, 1);
  game.state.discardPile.push(card);
  game.state.currentColor = card.color ?? chosenColor;
  game.log = appendLog(game, `${game.players[game.turn].name} ${unoCardLabel(card)} 내기`);
  if (!hand.length) return finish(game, [command.playerId], `${game.players[game.turn].name}님이 카드를 모두 냈습니다!`);

  if (card.kind === "draw2" || card.kind === "wild4") {
    game.state.pendingDraw = pendingDraw + (card.kind === "draw2" ? 2 : 4);
    game.state.pendingDrawKind = card.kind;
    game.turn = nextIndex(game, game.turn, 1, game.state.direction);
    const response = card.kind === "wild4" ? "+4만 낼 수 있어요." : "+2 또는 +4를 낼 수 있어요.";
    const colorChange = card.kind === "wild4" ? ` 선택 색: ${unoColorName(game.state.currentColor)}.` : "";
    game.message = `${game.players[game.turn].name}님에게 +${game.state.pendingDraw} 누적!${colorChange} ${response}`;
    return game;
  }

  let steps = 1;
  if (card.kind === "reverse") {
    game.state.direction *= -1;
    if (game.players.length === 2) steps = 2;
  }
  if (card.kind === "skip") steps = 2;
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
  game.state.hasGuessed = false;
  game.state.comboCount = 0;
  game.state.comboEvent = null;
  for (let count = 0; count < game.players.length; count++) {
    game.turn = nextIndex(game, game.turn);
    if ((game.state.hands[game.players[game.turn].id] as DavinciTile[]).some((tile) => !tile.revealed)) break;
  }
  game.message = `${game.players[game.turn].name}님, 타일을 뽑으세요.`;
  return game;
}

function reduceDavinciCode(game: GameEnvelope, command: GameCommand) {
  if (command.type === "PLACE_JOKER") {
    const pendingJokers = (game.state.unplacedJokers?.[command.playerId] ?? []) as string[];
    const tileId = String(command.payload?.tileId ?? "");
    const position = Number(command.payload?.position);
    const ownerHand = game.state.hands[command.playerId] as DavinciTile[] | undefined;
    const currentIndex = ownerHand?.findIndex((tile) => tile.id === tileId) ?? -1;
    if (!ownerHand || currentIndex < 0 || !pendingJokers.includes(tileId) || !ownerHand[currentIndex].isJoker) return fail(game, "배치할 조커를 찾을 수 없습니다.");
    if (!Number.isInteger(position) || position < 0 || position > ownerHand.length - 1) return fail(game, "조커를 놓을 위치를 골라주세요.");
    const [joker] = ownerHand.splice(currentIndex, 1);
    ownerHand.splice(position, 0, joker);
    game.state.unplacedJokers[command.playerId] = pendingJokers.filter((id) => id !== tileId);
    const stillWaiting = Object.values(game.state.unplacedJokers as Record<string, string[]>).some((tileIds) => tileIds.length);
    game.message = stillWaiting
      ? "다른 조커의 위치를 정하고 있습니다."
      : game.state.hasDrawn
        ? "상대의 숨겨진 타일을 골라 추리하세요."
        : `${game.players[game.turn].name}님, 타일을 뽑으세요.`;
    return game;
  }
  if (Object.values((game.state.unplacedJokers ?? {}) as Record<string, string[]>).some((tileIds) => tileIds.length)) return fail(game, "먼저 받은 조커의 위치를 정해주세요.");
  if (!assertTurn(game, command.playerId)) return fail(game, "지금은 내 차례가 아닙니다.");
  const hand = game.state.hands[command.playerId] as DavinciTile[];
  if (command.type === "DRAW_TILE") {
    if (game.state.hasDrawn) return fail(game, "이미 타일을 뽑았습니다.");
    const tile = (game.state.deck as DavinciTile[]).pop();
    game.state.hasDrawn = true;
    game.state.hasGuessed = false;
    game.state.comboCount = 0;
    game.state.comboEvent = null;
    if (tile) {
      insertDavinciTile(hand, tile);
      game.state.pendingTileId = tile.id;
      game.state.pendingPlayerId = command.playerId;
      if (tile.isJoker) {
        game.state.unplacedJokers[command.playerId].push(tile.id);
        game.message = "뽑은 조커를 암호의 원하는 위치에 놓으세요.";
      } else {
        game.message = "상대의 숨겨진 타일을 골라 숫자를 추리하세요.";
      }
    } else {
      game.message = "남은 타일이 없습니다. 바로 상대 숫자를 추리하세요.";
    }
    return game;
  }
  if (command.type === "END_TURN") {
    if (!game.state.hasDrawn) return fail(game, "먼저 타일을 뽑으세요.");
    if (!game.state.hasGuessed) return fail(game, "이번 턴에 한 번 이상 추리한 뒤 멈출 수 있습니다.");
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
  if (!Number.isInteger(guessedNumber) || guessedNumber < -1 || guessedNumber > 11) return fail(game, "0부터 11 또는 조커를 골라주세요.");

  const guessLabel = guessedNumber === -1 ? "— 조커" : String(guessedNumber);

  if ((target.isJoker && guessedNumber === -1) || (!target.isJoker && target.number === guessedNumber)) {
    target.revealed = true;
    game.state.hasGuessed = true;
    game.state.comboCount = Number(game.state.comboCount ?? 0) + 1;
    if (game.state.comboCount >= 3) {
      game.state.comboEvent = {
        id: `${command.now ?? game.seed}-${command.playerId}-${game.state.comboCount}`,
        playerId: command.playerId,
        count: game.state.comboCount,
        createdAt: command.now ?? game.seed,
      };
    } else {
      game.state.comboEvent = null;
    }
    const targetName = game.players.find((player) => player.id === targetPlayerId)?.name ?? "상대";
    answerFeedback(game, command, `정답! ${targetName}님의 ${guessLabel} 타일이 공개됐습니다.`, "correct");
    const alive = davinciAlivePlayers(game);
    if (alive.length <= 1) return finish(game, alive.map((player) => player.id), `${alive[0]?.name ?? "마지막 플레이어"}님이 암호를 지켰습니다!`);
    return game;
  }

  const pending = hand.find((tile) => tile.id === game.state.pendingTileId);
  if (pending) pending.revealed = true;
  const alive = davinciAlivePlayers(game);
  if (alive.length <= 1) return finish(game, alive.map((player) => player.id), `${alive[0]?.name ?? "마지막 플레이어"}님이 암호를 지켰습니다!`);
  finishDavinciTurn(game);
  return answerFeedback(game, command, `${guessLabel}은(는) 오답! 내 타일이 공개되고 턴이 끝났습니다.`);
}

function startRummikubTurn(game: GameEnvelope) {
  const playerId = game.players[game.turn]?.id;
  game.state.turnSnapshot = {
    playerId,
    rack: clone((game.state.racks[playerId] ?? []) as RummikubTile[]),
    table: clone((game.state.table ?? []) as RummikubTile[][]),
    addedTileIds: [],
    manipulatedTable: false,
  };
}

function nextRummikubTurn(game: GameEnvelope) {
  game.turn = nextIndex(game, game.turn);
  startRummikubTurn(game);
  const nextPlayer = game.players[game.turn];
  game.message = game.state.opened[nextPlayer.id]
    ? `${nextPlayer.name}님 차례 · 조합을 만들거나 타일을 뽑으세요.`
    : `${nextPlayer.name}님 차례 · 내 타일만으로 30점 이상 등록하세요.`;
  return game;
}

function rummikubRackPenalty(rack: RummikubTile[]) {
  return rack.reduce((sum, tile) => sum + (tile.isJoker ? 30 : Number(tile.number)), 0);
}

function finishRummikubPool(game: GameEnvelope) {
  const penalties = game.players.map((player) => ({ player, penalty: rummikubRackPenalty(game.state.racks[player.id] as RummikubTile[]) }));
  const minimum = Math.min(...penalties.map((entry) => entry.penalty));
  return finish(game, penalties.filter((entry) => entry.penalty === minimum).map((entry) => entry.player.id), `타일 더미가 비었습니다 · 남은 타일 합계 ${minimum}점으로 승부가 끝났습니다.`);
}

function reduceRummikub(game: GameEnvelope, command: GameCommand) {
  if (!assertTurn(game, command.playerId)) return fail(game, "지금은 내 차례가 아닙니다.");
  if (game.state.turnSnapshot?.playerId !== command.playerId) startRummikubTurn(game);
  const rack = game.state.racks[command.playerId] as RummikubTile[];
  const table = game.state.table as RummikubTile[][];
  const snapshot = game.state.turnSnapshot as { playerId: string; rack: RummikubTile[]; table: RummikubTile[][]; addedTileIds: string[]; manipulatedTable: boolean };

  if (command.type === "UNDO_TURN") {
    game.state.racks[command.playerId] = clone(snapshot.rack);
    game.state.table = clone(snapshot.table);
    startRummikubTurn(game);
    game.message = "이번 턴의 변경을 모두 되돌렸습니다.";
    return game;
  }

  if (command.type === "PLAY_TILES") {
    const tileIds = Array.isArray(command.payload?.tileIds) ? command.payload.tileIds.map(String) : [];
    if (!tileIds.length || new Set(tileIds).size !== tileIds.length) return fail(game, "내 타일을 하나 이상 골라주세요.");
    const selected = tileIds.map((id) => rack.find((tile) => tile.id === id));
    if (selected.some((tile) => !tile)) return fail(game, "선택한 타일을 내 받침대에서 찾을 수 없습니다.");
    const targetMeldIndex = Number(command.payload?.targetMeldIndex ?? -1);
    if (!Number.isInteger(targetMeldIndex) || targetMeldIndex < -1 || targetMeldIndex >= table.length) return fail(game, "타일을 놓을 조합을 다시 골라주세요.");
    if (!game.state.opened[command.playerId] && targetMeldIndex >= 0) return fail(game, "최초 30점 등록 전에는 기존 테이블 조합을 사용할 수 없습니다.");
    game.state.racks[command.playerId] = rack.filter((tile) => !tileIds.includes(tile.id));
    if (targetMeldIndex < 0) table.push(selected as RummikubTile[]);
    else table[targetMeldIndex].push(...selected as RummikubTile[]);
    snapshot.addedTileIds.push(...tileIds);
    game.message = `${tileIds.length}개 타일을 테이블에 놓았습니다. 유효한 조합인지 확인하고 턴을 끝내세요.`;
    return game;
  }

  if (command.type === "MOVE_TABLE_TILE") {
    if (!game.state.opened[command.playerId]) return fail(game, "최초 30점 등록을 마친 다음 턴부터 테이블을 재배치할 수 있습니다.");
    const fromMeldIndex = Number(command.payload?.fromMeldIndex);
    let targetMeldIndex = Number(command.payload?.targetMeldIndex ?? -1);
    const tileId = String(command.payload?.tileId ?? "");
    if (!Number.isInteger(fromMeldIndex) || fromMeldIndex < 0 || fromMeldIndex >= table.length) return fail(game, "옮길 조합을 찾을 수 없습니다.");
    const tileIndex = table[fromMeldIndex].findIndex((tile) => tile.id === tileId);
    if (tileIndex < 0) return fail(game, "옮길 타일을 찾을 수 없습니다.");
    if (!Number.isInteger(targetMeldIndex) || targetMeldIndex < -1 || targetMeldIndex >= table.length || targetMeldIndex === fromMeldIndex) return fail(game, "다른 조합이나 새 조합을 골라주세요.");
    const [tile] = table[fromMeldIndex].splice(tileIndex, 1);
    if (!table[fromMeldIndex].length) {
      table.splice(fromMeldIndex, 1);
      if (targetMeldIndex > fromMeldIndex) targetMeldIndex -= 1;
    }
    if (targetMeldIndex < 0) table.push([tile]);
    else table[targetMeldIndex].push(tile);
    snapshot.manipulatedTable = true;
    game.message = "테이블 타일을 옮겼습니다. 모든 조합을 완성한 뒤 턴을 끝내세요.";
    return game;
  }

  if (command.type === "DRAW_TILE") {
    if (snapshot.addedTileIds.length || snapshot.manipulatedTable) return fail(game, "타일을 뽑기 전에 이번 턴의 배치를 되돌려 주세요.");
    const tile = (game.state.pool as RummikubTile[]).pop();
    if (tile) {
      rack.push(tile);
      sortRummikubRack(rack);
      game.state.consecutivePasses = 0;
      game.log = appendLog(game, `${game.players[game.turn].name} 타일 1개 뽑기`);
    } else {
      game.state.consecutivePasses = Number(game.state.consecutivePasses ?? 0) + 1;
      if (game.state.consecutivePasses >= game.players.length) return finishRummikubPool(game);
      game.log = appendLog(game, `${game.players[game.turn].name} 더미가 비어 넘기기`);
    }
    return nextRummikubTurn(game);
  }

  if (command.type !== "COMMIT_TURN") return fail(game, "타일을 놓거나 한 장 뽑아주세요.");
  if (!snapshot.addedTileIds.length) return fail(game, "내 받침대에서 타일을 하나 이상 내려놓아야 합니다.");
  const analyses = table.map(analyzeRummikubMeld);
  const invalidIndex = analyses.findIndex((analysis) => !analysis.valid);
  if (invalidIndex >= 0) return fail(game, `${invalidIndex + 1}번 조합이 완성되지 않았습니다. 그룹 또는 런을 만들어주세요.`);
  if (!game.state.opened[command.playerId]) {
    if (snapshot.manipulatedTable || table.length < snapshot.table.length) return fail(game, "최초 등록에는 테이블의 기존 타일을 사용할 수 없습니다.");
    const initialScore = analyses.slice(snapshot.table.length).reduce((sum, analysis) => sum + analysis.score, 0);
    if (initialScore < 30) return fail(game, `최초 등록 합계가 ${initialScore}점입니다. 30점 이상이 필요합니다.`);
    game.state.opened[command.playerId] = true;
    game.message = `최초 등록 ${initialScore}점 성공!`;
  }
  game.state.table = analyses.map((analysis) => analysis.ordered);
  game.state.consecutivePasses = 0;
  game.log = appendLog(game, `${game.players[game.turn].name} 타일 ${snapshot.addedTileIds.length}개 등록`);
  if ((game.state.racks[command.playerId] as RummikubTile[]).length === 0) return finish(game, [command.playerId], `${game.players[game.turn].name}님이 모든 타일을 내려놓고 Rummikub!`);
  return nextRummikubTurn(game);
}

function defenseRewards(game: GameEnvelope, survivedMs: number, success: boolean) {
  const difficulty = game.state.difficulty as DefenseDifficulty;
  const config = DEFENSE_CONFIG[difficulty];
  const survivalUnits = Math.floor(Math.max(0, survivedMs) / 15_000);
  return Object.fromEntries(game.players.map((player) => {
    const typedKills = Number(game.state.typedKills[player.id] ?? 0);
    const reward = survivalUnits * config.survivalRate
      + Math.floor(typedKills / 5) * config.killRate
      + (success ? config.completionBonus : 0)
      + (game.state.bossDefeated ? config.bossBonus : 0);
    return [player.id, Math.min(config.rewardCap, reward)];
  }));
}

function finishWordDefense(game: GameEnvelope, now: number, success: boolean) {
  const survivedMs = Math.min(WORD_DEFENSE_DURATION_MS, Math.max(0, now - Number(game.state.startedAt)));
  game.phase = "finished";
  game.winnerIds = success ? game.players.map((player) => player.id) : [];
  game.state.survivedMs = survivedMs;
  game.state.goldRewards = defenseRewards(game, survivedMs, success);
  game.state.finishedAt = now;
  game.message = success
    ? game.state.bossDefeated ? "3분 방어 성공! 보스까지 격파했습니다!" : "3분 방어 성공! 보스 보너스는 놓쳤지만 기지를 지켰습니다."
    : `기지가 파괴되었습니다 · ${Math.floor(survivedMs / 1_000)}초 생존`;
  game.log = appendLog(game, game.message);
  return game;
}

function advanceWordDefense(game: GameEnvelope, now: number) {
  const difficulty = game.state.difficulty as DefenseDifficulty;
  const config = DEFENSE_CONFIG[difficulty];
  const startedAt = Number(game.state.startedAt);
  const endsAt = Number(game.state.endsAt);
  const totalProgress = Math.max(0, Math.min(1, (now - startedAt) / WORD_DEFENSE_DURATION_MS));
  game.state.projectedAt = now;

  let safety = 0;
  while (Number(game.state.nextSpawnAt) <= now && Number(game.state.nextSpawnAt) < endsAt - 4_000 && safety++ < 320) {
    const spawnedAt = Number(game.state.nextSpawnAt);
    const progress = Math.max(0, Math.min(1, (spawnedAt - startedAt) / WORD_DEFENSE_DURATION_MS));
    const count = Number(game.state.spawnCount ?? 0);
    const fallDurationMs = Math.round(config.startFallMs + (config.endFallMs - config.startFallMs) * progress);
    const enemy: WordDefenseEnemy = {
      id: `e${count}-${spawnedAt}`,
      word: defenseWord(game.seed, count, progress),
      lane: seededIndex(game.seed + count * 71, 7, count + 19),
      spawnedAt,
      fallDurationMs,
    };
    (game.state.enemies as WordDefenseEnemy[]).push(enemy);
    game.state.spawnCount = count + 1;
    const interval = Math.round(config.startIntervalMs + (config.endIntervalMs - config.startIntervalMs) * progress);
    game.state.nextSpawnAt = spawnedAt + interval;
  }

  if (!game.state.bossSpawned && now >= startedAt + 120_000) {
    game.state.bossSpawned = true;
    game.state.boss = {
      hp: config.bossHp,
      maxHp: config.bossHp,
      word: defenseWord(game.seed + 8_888, Number(game.state.spawnCount), 1),
      spawnedAt: startedAt + 120_000,
      fallDurationMs: 60_000,
    };
    game.message = `보스 출현! 단어 ${config.bossHp}개를 입력해 쓰러뜨리세요!`;
  }

  const enemies = game.state.enemies as WordDefenseEnemy[];
  const escaped = enemies.filter((enemy) => now >= enemy.spawnedAt + enemy.fallDurationMs);
  if (escaped.length) {
    const escapedIds = new Set(escaped.map((enemy) => enemy.id));
    game.state.enemies = enemies.filter((enemy) => !escapedIds.has(enemy.id));
    game.state.baseHp = Math.max(0, Number(game.state.baseHp) - escaped.length);
    game.state.lastEvent = { id: `breach-${now}`, type: "breach", count: escaped.length, createdAt: now };
    game.message = `${escaped.length}마리가 방어선을 통과했습니다!`;
  }
  if (Number(game.state.baseHp) <= 0) return finishWordDefense(game, now, false);
  if (now >= endsAt) return finishWordDefense(game, endsAt, true);
  if (totalProgress >= 0.8 && !game.state.bossDefeated) game.message = "최후반입니다! 보스와 몰려오는 적을 함께 막으세요.";
  return game;
}

function reduceWordDefense(game: GameEnvelope, command: GameCommand) {
  if (command.type !== "TYPE_WORD") return fail(game, "적의 단어를 입력하고 Enter를 눌러주세요.");
  const typed = normalizeDefenseInput(command.payload?.word);
  if (!typed) return fail(game, "단어를 입력해 주세요.");
  const now = command.now ?? game.seed;
  const charges = Number(game.state.boomCharges[command.playerId] ?? 0);
  if (typed === "boom!") {
    if (charges < 1) return answerFeedback(game, command, "BOOM 게이지가 아직 부족합니다.");
    const enemies = game.state.enemies as WordDefenseEnemy[];
    const count = Math.min(enemies.length, 5 + seededIndex(game.seed + now, 6, Number(game.state.spawnCount)));
    if (!count) return fail(game, "지금 폭발시킬 일반 적이 없습니다.");
    const targets = [...enemies]
      .sort((a, b) => ((now - b.spawnedAt) / b.fallDurationMs) - ((now - a.spawnedAt) / a.fallDurationMs))
      .slice(0, count);
    const targetIds = new Set(targets.map((enemy) => enemy.id));
    game.state.enemies = enemies.filter((enemy) => !targetIds.has(enemy.id));
    game.state.boomCharges[command.playerId] = charges - 1;
    game.state.destroyed[command.playerId] = Number(game.state.destroyed[command.playerId] ?? 0) + count;
    const actor = game.players[playerIndex(game, command.playerId)];
    actor.score = Number(game.state.destroyed[command.playerId]);
    game.state.lastEvent = { id: `boom-${now}-${command.playerId}`, type: "boom", playerId: command.playerId, enemyIds: [...targetIds], targets, count, createdAt: now };
    game.message = `BOOM! ${actor.name}님이 위험한 적 ${count}마리를 한꺼번에 제거했습니다!`;
    return game;
  }

  const boss = game.state.boss as { hp: number; maxHp: number; word: string } | null;
  if (boss && !game.state.bossDefeated && normalizeDefenseInput(boss.word) === typed) {
    boss.hp -= 1;
    game.state.lastEvent = { id: `boss-${now}-${command.playerId}`, type: "boss-hit", playerId: command.playerId, count: 1, createdAt: now };
    if (boss.hp <= 0) {
      boss.hp = 0;
      game.state.bossDefeated = true;
      game.message = `BOSS BREAK! ${game.players[playerIndex(game, command.playerId)].name}님이 마지막 일격을 넣었습니다!`;
    } else {
      boss.word = defenseWord(game.seed + boss.hp * 97, Number(game.state.spawnCount) + boss.hp, 1);
      game.message = `보스 타격! 남은 단어 ${boss.hp}개`;
    }
    return game;
  }

  const enemies = game.state.enemies as WordDefenseEnemy[];
  const target = [...enemies]
    .filter((enemy) => normalizeDefenseInput(enemy.word) === typed)
    .sort((a, b) => ((now - b.spawnedAt) / b.fallDurationMs) - ((now - a.spawnedAt) / a.fallDurationMs))[0];
  if (!target) return answerFeedback(game, command, `‘${String(command.payload?.word ?? "").trim()}’에 해당하는 적이 없습니다.`);
  game.state.enemies = enemies.filter((enemy) => enemy.id !== target.id);
  const previousTyped = Number(game.state.typedKills[command.playerId] ?? 0);
  const nextTyped = previousTyped + 1;
  game.state.typedKills[command.playerId] = nextTyped;
  game.state.destroyed[command.playerId] = Number(game.state.destroyed[command.playerId] ?? 0) + 1;
  if (Math.floor(nextTyped / 20) > Math.floor(previousTyped / 20)) game.state.boomCharges[command.playerId] = Number(game.state.boomCharges[command.playerId] ?? 0) + 1;
  const actor = game.players[playerIndex(game, command.playerId)];
  actor.score = Number(game.state.destroyed[command.playerId]);
  game.state.lastEvent = { id: `hit-${target.id}-${command.playerId}`, type: "hit", playerId: command.playerId, enemyIds: [target.id], targets: [target], count: 1, createdAt: now };
  game.message = `${actor.name}님이 ‘${target.word}’ 적을 처치했습니다!`;
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

function finishByScore(game: GameEnvelope, message: string) {
  const highScore = Math.max(...game.players.map((player) => player.score));
  game.phase = "finished";
  game.winnerIds = game.players.filter((player) => player.score === highScore).map((player) => player.id);
  game.message = message;
  game.log = appendLog(game, message);
  return game;
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
  if (projected.gameId === "same-answer") {
    projected.state.submissions = Object.fromEntries(
      Object.entries(projected.state.submissions as Record<string, string>)
        .map(([playerId, answer]) => [playerId, playerId === viewerId ? answer : true]),
    );
  }
  if (projected.gameId === "uno") {
    const hands = projected.state.hands as Record<string, Array<UnoCard | null>>;
    for (const [playerId, hand] of Object.entries(hands)) {
      if (projected.phase !== "finished" && playerId !== viewerId) hands[playerId] = Array(hand.length).fill(null);
    }
    projected.state.drawPile = Array(projected.state.drawPile.length).fill(null);
  }
  if (projected.gameId === "davinci-code") {
    const hands = projected.state.hands as Record<string, DavinciTile[]>;
    for (const [playerId, hand] of Object.entries(hands)) {
      hands[playerId] = hand.map((tile) => ({
        ...tile,
        number: projected.phase === "finished" || playerId === viewerId || tile.revealed ? tile.number : null,
        isJoker: projected.phase === "finished" || playerId === viewerId || tile.revealed ? tile.isJoker : false,
      }));
    }
    projected.state.unplacedJokers = Object.fromEntries(
      Object.entries((projected.state.unplacedJokers ?? {}) as Record<string, string[]>).map(([playerId, tileIds]) => [
        playerId,
        playerId === viewerId ? tileIds : tileIds.map(() => "hidden"),
      ]),
    );
    projected.state.deck = Array(projected.state.deck.length).fill(null);
    if (projected.state.pendingPlayerId !== viewerId) projected.state.pendingTileId = null;
  }
  if (projected.gameId === "rummikub") {
    const racks = projected.state.racks as Record<string, Array<RummikubTile | null>>;
    for (const [playerId, rack] of Object.entries(racks)) {
      if (projected.phase !== "finished" && playerId !== viewerId) racks[playerId] = Array(rack.length).fill(null);
    }
    projected.state.pool = Array(projected.state.pool.length).fill(null);
    projected.state.turnSnapshot = null;
  }
  if (projected.gameId === "word-defense") {
    projected.state.projectedAt = now;
    if (projected.state.lastEvent && now - Number(projected.state.lastEvent.createdAt ?? now) > 1_800) projected.state.lastEvent = null;
  }
  return projected;
}
