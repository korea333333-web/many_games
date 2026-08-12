import assert from "node:assert/strict";
import test from "node:test";
import { GAME_BY_ID, GAME_CATALOG, isGameAvailable } from "./catalog.ts";
import { advanceTimedGame, createGame, getChessLegalTargets, getChessViewIndexes, projectGame, reduceGame, removePlayerFromGame } from "./engine.ts";
import { WORD_CHAIN_WORDS } from "./word-bank.ts";
import { hasUnreadMessage, latestMessageId } from "../chat/unread.ts";

const players = [
  { id: "a", name: "민지" },
  { id: "b", name: "준호" },
  { id: "c", name: "소라" },
  { id: "d", name: "태오" },
];

test("catalog exposes ten games while keeping postponed games dormant", () => {
  assert.equal(GAME_CATALOG.length, 10);
  assert.deepEqual(GAME_CATALOG.map((game) => game.id), [
    "gomoku", "go", "drawing", "chosung", "same-answer", "liar", "connect-four", "chess", "uno", "davinci-code",
  ]);
  assert.equal(isGameAvailable("word-chain"), false);
  assert.equal(isGameAvailable("yut"), false);
  assert.equal(GAME_BY_ID["word-chain"].id, "word-chain");
  assert.equal(GAME_BY_ID.yut.id, "yut");
});

test("word chain ships with a broad local fallback dictionary", () => {
  assert.ok(WORD_CHAIN_WORDS.size >= 400);
  assert.ok(WORD_CHAIN_WORDS.has("박물관"));
  assert.ok(WORD_CHAIN_WORDS.has("펭귄"));
});

test("chat unread marker only reacts to newer messages from another player", () => {
  const messages = [{ id: 10, senderId: "a" }, { id: 11, senderId: "b" }];
  assert.equal(latestMessageId(messages), 11);
  assert.equal(hasUnreadMessage(messages, null, "a"), false);
  assert.equal(hasUnreadMessage(messages, 10, "a"), true);
  assert.equal(hasUnreadMessage([{ id: 12, senderId: "a" }], 11, "a"), false);
});

test("gomoku rejects turn violations and detects five", () => {
  let game = createGame("gomoku", players.slice(0, 2), 1);
  assert.match(reduceGame(game, { type: "PLACE", playerId: "b", payload: { index: 0 } }).message, /차례/);
  for (let col = 0; col < 5; col++) {
    game = reduceGame(game, { type: "PLACE", playerId: "a", payload: { index: col } });
    if (col < 4) game = reduceGame(game, { type: "PLACE", playerId: "b", payload: { index: 15 + col } });
  }
  assert.equal(game.phase, "finished");
  assert.deepEqual(game.winnerIds, ["a"]);
  assert.equal(typeof game.state.finishedAt, "number");
});

test("go captures surrounded groups and rejects suicide", () => {
  let game = createGame("go", players.slice(0, 2), 101);
  game.state.size = 3;
  game.state.board = [null, "a", null, "a", "b", "a", null, null, null];
  game.state.positionHistory = [game.state.board.map((stone: string | null) => stone ?? "_").join("|")];
  game = reduceGame(game, { type: "PLACE", playerId: "a", payload: { index: 7 } });
  assert.equal(game.state.board[4], null);
  assert.equal(game.state.captures.a, 1);

  game = createGame("go", players.slice(0, 2), 102);
  game.state.size = 3;
  game.state.board = [null, "b", null, "b", null, "b", null, "b", null];
  game.state.positionHistory = [game.state.board.map((stone: string | null) => stone ?? "_").join("|")];
  const rejected = reduceGame(game, { type: "PLACE", playerId: "a", payload: { index: 4 } });
  assert.equal(rejected.state.board[4], null);
  assert.match(rejected.message, /자충수/);
});

test("go enforces ko and enters scoring after two passes", () => {
  let game = createGame("go", players.slice(0, 2), 103);
  game.state.size = 5;
  game.state.board = Array(25).fill(null);
  for (const index of [1, 5, 11]) game.state.board[index] = "a";
  for (const index of [2, 6, 8, 12]) game.state.board[index] = "b";
  game.state.positionHistory = [game.state.board.map((stone: string | null) => stone ?? "_").join("|")];
  game = reduceGame(game, { type: "PLACE", playerId: "a", payload: { index: 7 } });
  assert.equal(game.state.board[6], null);
  const koRejected = reduceGame(game, { type: "PLACE", playerId: "b", payload: { index: 6 } });
  assert.equal(koRejected.state.board[7], "a");
  assert.match(koRejected.message, /패/);

  game = createGame("go", players.slice(0, 2), 104);
  game = reduceGame(game, { type: "PASS", playerId: "a" });
  game = reduceGame(game, { type: "PASS", playerId: "b" });
  assert.equal(game.state.mode, "scoring");
});

test("go scoring needs both confirmations and includes captures plus komi", () => {
  let game = createGame("go", players.slice(0, 2), 105);
  game.state.size = 3;
  game.state.board = ["a", "a", "a", "a", null, "a", "a", "a", "a"];
  game.state.captures.a = 10;
  game = reduceGame(game, { type: "PASS", playerId: "a" });
  game = reduceGame(game, { type: "PASS", playerId: "b" });
  game = reduceGame(game, { type: "CONFIRM_SCORE", playerId: "a" });
  assert.equal(game.phase, "playing");
  game = reduceGame(game, { type: "CONFIRM_SCORE", playerId: "b" });
  assert.equal(game.phase, "finished");
  assert.deepEqual(game.winnerIds, ["a"]);
  assert.equal(game.state.finalScore.black, 11);
  assert.equal(game.state.finalScore.white, 6.5);
});

test("connect four stacks pieces and wins vertically", () => {
  let game = createGame("connect-four", players.slice(0, 2), 2);
  for (let turn = 0; turn < 7; turn++) {
    const playerId = turn % 2 === 0 ? "a" : "b";
    game = reduceGame(game, { type: "DROP", playerId, payload: { col: turn % 2 } });
  }
  assert.deepEqual(game.winnerIds, ["a"]);
});

test("word chain enforces endings and duplicates", () => {
  let game = createGame("word-chain", players.slice(0, 2), 3);
  game = reduceGame(game, { type: "SUBMIT_WORD", playerId: "a", payload: { word: "사과" } });
  game = reduceGame(game, { type: "SUBMIT_WORD", playerId: "b", payload: { word: "과자" } });
  assert.equal(game.state.words.length, 2);
  assert.match(reduceGame(game, { type: "SUBMIT_WORD", playerId: "a", payload: { word: "사과" } }).message, /이미/);
});

test("word chain applies the initial sound rule to complete syllables", () => {
  const cases = [
    ["력", "역사"],
    ["랑", "낭만"],
    ["년", "연필"],
    ["률", "율법"],
  ] as const;
  for (const [lastSyllable, word] of cases) {
    const game = createGame("word-chain", players.slice(0, 2), 31);
    game.state.lastSyllable = lastSyllable;
    const next = reduceGame(game, { type: "SUBMIT_WORD", playerId: "a", payload: { word, dictionaryValid: true } });
    assert.equal(next.state.words[0]?.word, word, `${lastSyllable} → ${word[0]} 변환을 인정해야 합니다.`);
  }
});

test("word chain does not apply the initial sound rule in reverse or to the wrong initial", () => {
  const reverse = createGame("word-chain", players.slice(0, 2), 32);
  reverse.state.lastSyllable = "나";
  const rejectedReverse = reduceGame(reverse, { type: "SUBMIT_WORD", playerId: "a", payload: { word: "라면", dictionaryValid: true } });
  assert.equal(rejectedReverse.state.words.length, 0);

  const wrongInitial = createGame("word-chain", players.slice(0, 2), 33);
  wrongInitial.state.lastSyllable = "력";
  const rejectedInitial = reduceGame(wrongInitial, { type: "SUBMIT_WORD", playerId: "a", payload: { word: "녁사", dictionaryValid: true } });
  assert.equal(rejectedInitial.state.words.length, 0);
});

test("word chain eliminates a player after 20 seconds and gives the next player a full turn", () => {
  const game = createGame("word-chain", players.slice(0, 3), 1_000);
  assert.equal(game.state.turnEndsAt, 21_000);
  const firstTimeout = advanceTimedGame(game, 21_001);
  assert.deepEqual(firstTimeout.state.eliminated, ["a"]);
  assert.equal(firstTimeout.turn, 1);
  assert.equal(firstTimeout.state.turnEndsAt, 41_001);
  assert.equal(firstTimeout.phase, "playing");

  const secondTimeout = advanceTimedGame(firstTimeout, 41_002);
  assert.equal(secondTimeout.phase, "finished");
  assert.deepEqual(secondTimeout.winnerIds, ["c"]);
});

test("word chain resets the timer after a valid word and skips eliminated players", () => {
  let game = createGame("word-chain", players.slice(0, 3), 1_000);
  game.state.eliminated = ["b"];
  game = reduceGame(game, { type: "SUBMIT_WORD", playerId: "a", payload: { word: "사과", dictionaryValid: true }, now: 5_000 });
  assert.equal(game.turn, 2);
  assert.equal(game.state.turnEndsAt, 25_000);

  const lateGame = createGame("word-chain", players.slice(0, 3), 1_000);
  const rejected = reduceGame(lateGame, { type: "SUBMIT_WORD", playerId: "a", payload: { word: "사과", dictionaryValid: true }, now: 21_001 });
  assert.deepEqual(rejected.state.eliminated, ["a"]);
  assert.equal(rejected.state.words.length, 0);
});

test("drawing hides prompts from guessers", () => {
  const game = createGame("drawing", players.slice(0, 3), 4);
  assert.equal(projectGame(game, "b").state.promptChoices.length, 0);
  assert.equal(projectGame(game, "a").state.promptChoices.length, 3);
});

test("drawing starts a 60 second timer and reveals the answer for five seconds", () => {
  let game = createGame("drawing", players.slice(0, 3), 4, { rounds: 3 });
  const prompt = game.state.promptChoices[0];
  game = reduceGame(game, { type: "SELECT_PROMPT", playerId: "a", payload: { prompt }, now: 1_000 });
  assert.equal(game.state.roundEndsAt, 61_000);
  const revealing = advanceTimedGame(game, 61_001);
  assert.equal(revealing.state.answerRevealUntil, 66_001);
  assert.equal(projectGame(revealing, "b", 62_000).state.prompt, prompt);
  const nextRound = advanceTimedGame(revealing, 66_002);
  assert.equal(nextRound.round, 2);
  assert.equal(nextRound.state.prompt, null);
});

test("drawing finishes after the configured number of rounds", () => {
  let game = createGame("drawing", players.slice(0, 2), 4, { rounds: 1 });
  game = reduceGame(game, { type: "SELECT_PROMPT", playerId: "a", payload: { prompt: game.state.promptChoices[0] }, now: 10 });
  game = advanceTimedGame(game, 60_011);
  game = advanceTimedGame(game, 65_012);
  assert.equal(game.phase, "finished");
});

test("chosung rewards early answers", () => {
  let game = createGame("chosung", players.slice(0, 2), 5, { rounds: 3 });
  const answer = game.state.answer;
  game = reduceGame(game, { type: "GUESS", playerId: "a", payload: { guess: answer }, now: 100 });
  assert.equal(game.phase, "playing");
  assert.equal(game.round, 2);
  assert.ok(game.players[0].score >= 100);
});

test("wrong quiz answers produce short-lived player feedback", () => {
  const game = createGame("chosung", players.slice(0, 2), 5, { rounds: 3 });
  const wrong = reduceGame(game, { type: "GUESS", playerId: "b", payload: { guess: "오답" }, now: 1_000 });
  assert.equal(wrong.feedback?.playerId, "b");
  assert.match(wrong.feedback?.text ?? "", /오답/);
  assert.equal(projectGame(wrong, "a", 3_201).feedback, undefined);
});

test("chosung reveals hints as time passes", () => {
  const game = createGame("chosung", players.slice(0, 2), 1_000);
  const projected = projectGame(game, "a", 25_100);
  assert.equal(projected.state.revealed, 2);
  assert.equal(projected.state.answer, null);
  assert.equal(typeof projected.state.firstSyllable, "string");
});

test("same answer uses player-sized choices and continues after scoring", () => {
  let game = createGame("same-answer", players.slice(0, 3), 6, { rounds: 5 });
  assert.equal(game.state.options.length, 4);
  const [shared, unique] = game.state.options;
  game = reduceGame(game, { type: "SELECT_ANSWER", playerId: "a", payload: { answer: shared }, now: 1_000 });
  game = reduceGame(game, { type: "SELECT_ANSWER", playerId: "b", payload: { answer: shared }, now: 1_100 });
  game = reduceGame(game, { type: "SELECT_ANSWER", playerId: "c", payload: { answer: unique }, now: 1_200 });
  assert.equal(game.phase, "playing");
  assert.equal(game.players[2].score, 1);
  assert.deepEqual(game.state.results.scorerIds, ["c"]);
  game = advanceTimedGame(game, 4_201);
  assert.equal(game.round, 2);
  assert.equal(game.phase, "playing");
  assert.deepEqual(game.state.submissions, {});
});

test("same answer expands to ten choices for ten players", () => {
  const manyPlayers = Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, name: `플레이어${index}` }));
  const game = createGame("same-answer", manyPlayers, 8, { rounds: 10 });
  assert.equal(game.state.maxRounds, 10);
  assert.equal(game.state.options.length, 10);
});

test("same answer finishes only after all configured rounds", () => {
  let game = createGame("same-answer", players.slice(0, 3), 9, { rounds: 5 });
  let now = 10_000;
  for (let round = 1; round <= 5; round++) {
    const answer = game.state.options[0];
    for (const player of players.slice(0, 3)) {
      game = reduceGame(game, { type: "SELECT_ANSWER", playerId: player.id, payload: { answer }, now });
      now += 10;
    }
    game = advanceTimedGame(game, now + 3_001);
    now += 3_100;
    if (round < 5) assert.equal(game.phase, "playing");
  }
  assert.equal(game.phase, "finished");
  assert.equal(game.round, 5);
});

test("liar projection hides the word only from the liar", () => {
  const game = createGame("liar", players, 7);
  const liarId = game.players[game.state.liarIndex].id;
  assert.equal(projectGame(game, liarId).state.word, null);
  const citizen = game.players.find((player) => player.id !== liarId)!;
  assert.ok(projectGame(game, citizen.id).state.word);
});

test("chess allows a legal pawn move", () => {
  let game = createGame("chess", players.slice(0, 2), 8);
  game = reduceGame(game, { type: "MOVE", playerId: "a", payload: { from: 52, to: 36 } });
  assert.equal(game.state.board[36], "wP");
  assert.equal(game.turn, 1);
});

test("chess pawn can capture diagonally", () => {
  let game = createGame("chess", players.slice(0, 2), 10);
  game.state.board = Array(64).fill(null);
  game.state.board[4] = "bK";
  game.state.board[36] = "wP";
  game.state.board[27] = "bP";
  game.state.board[60] = "wK";
  assert.ok(getChessLegalTargets(game, "a", 36).includes(27));
  game = reduceGame(game, { type: "MOVE", playerId: "a", payload: { from: 36, to: 27 } });
  assert.equal(game.state.board[27], "wP");
  assert.equal(game.state.board[36], null);
});

test("the black chess player sees the board from the black side", () => {
  const game = createGame("chess", players.slice(0, 2), 12);
  assert.deepEqual(getChessViewIndexes(game, "a").slice(0, 3), [0, 1, 2]);
  assert.deepEqual(getChessViewIndexes(game, "b").slice(0, 3), [63, 62, 61]);
});

test("chess supports kingside castling", () => {
  let game = createGame("chess", players.slice(0, 2), 13);
  const moves = [
    ["a", 52, 36], ["b", 12, 28],
    ["a", 62, 45], ["b", 1, 18],
    ["a", 61, 34], ["b", 6, 21],
    ["a", 60, 62],
  ] as const;
  for (const [playerId, from, to] of moves) {
    game = reduceGame(game, { type: "MOVE", playerId, payload: { from, to } });
  }
  assert.equal(game.state.board[62], "wK");
  assert.equal(game.state.board[61], "wR");
  assert.equal(game.state.lastMove.san, "O-O");
  assert.deepEqual(game.state.lastMove.events, [{ type: "castle", label: "킹사이드 캐슬링!" }]);
});

test("chess announces en passant and check as special events", () => {
  let game = createGame("chess", players.slice(0, 2), 15);
  const enPassantMoves = [
    ["a", 52, 36], ["b", 8, 16],
    ["a", 36, 28], ["b", 11, 27],
    ["a", 28, 19],
  ] as const;
  for (const [playerId, from, to] of enPassantMoves) {
    game = reduceGame(game, { type: "MOVE", playerId, payload: { from, to } });
  }
  assert.equal(game.state.board[19], "wP");
  assert.equal(game.state.board[27], null);
  assert.deepEqual(game.state.lastMove.events, [{ type: "en-passant", label: "앙파상!" }]);

  game = createGame("chess", players.slice(0, 2), 16);
  game = reduceGame(game, { type: "MOVE", playerId: "a", payload: { from: 52, to: 36 } });
  game = reduceGame(game, { type: "MOVE", playerId: "b", payload: { from: 13, to: 21 } });
  game = reduceGame(game, { type: "MOVE", playerId: "a", payload: { from: 59, to: 31 } });
  assert.deepEqual(game.state.lastMove.events, [{ type: "check", label: "체크!" }]);
});

test("chess promotes a pawn to any non-king, non-pawn piece and announces it", () => {
  const promotions = [
    ["q", "Q", "퀸"],
    ["r", "R", "룩"],
    ["b", "B", "비숍"],
    ["n", "N", "나이트"],
  ] as const;

  for (const [promotion, symbol, name] of promotions) {
    let game = createGame("chess", players.slice(0, 2), 17);
    game.state.board = Array(64).fill(null);
    game.state.board[4] = "bK";
    game.state.board[8] = "wP";
    game.state.board[60] = "wK";
    delete game.state.fen;
    game = reduceGame(game, { type: "MOVE", playerId: "a", payload: { from: 8, to: 0, promotion } });
    assert.equal(game.state.board[0], `w${symbol}`);
    assert.ok(game.state.lastMove.events.some((event: { type: string; label: string }) => event.type === "promotion" && event.label === `프로모션 to ${name}!`));
  }

  let invalid = createGame("chess", players.slice(0, 2), 18);
  invalid.state.board = Array(64).fill(null);
  invalid.state.board[4] = "bK";
  invalid.state.board[8] = "wP";
  invalid.state.board[60] = "wK";
  delete invalid.state.fen;
  invalid = reduceGame(invalid, { type: "MOVE", playerId: "a", payload: { from: 8, to: 0, promotion: "k" } });
  assert.equal(invalid.state.board[8], "wP");
  assert.match(invalid.message, /퀸, 룩, 비숍, 나이트/);
});

test("chess finishes on checkmate instead of capturing the king", () => {
  let game = createGame("chess", players.slice(0, 2), 14);
  const moves = [
    ["a", 52, 36], ["b", 12, 28],
    ["a", 61, 34], ["b", 1, 18],
    ["a", 59, 31], ["b", 6, 21],
    ["a", 31, 13],
  ] as const;
  for (const [playerId, from, to] of moves) {
    game = reduceGame(game, { type: "MOVE", playerId, payload: { from, to } });
  }
  assert.equal(game.phase, "finished");
  assert.deepEqual(game.winnerIds, ["a"]);
  assert.match(game.message, /체크메이트/);
});

test("uno hides private cards and lets a player finish with a matching card", () => {
  let game = createGame("uno", players.slice(0, 2), 21);
  const projected = projectGame(game, "a");
  assert.ok(projected.state.hands.a[0]);
  assert.equal(projected.state.hands.b[0], null);
  assert.equal(projected.state.drawPile[0], null);

  const color = game.state.currentColor;
  game.state.hands.a = [{ id: "winning-card", color, kind: "number", value: 7 }];
  game.state.discardPile = [{ id: "top", color, kind: "number", value: 3 }];
  game = reduceGame(game, { type: "PLAY_CARD", playerId: "a", payload: { cardId: "winning-card" } });
  assert.equal(game.phase, "finished");
  assert.deepEqual(game.winnerIds, ["a"]);
});

test("uno stacks +2 with +2 or +4, while +4 only accepts +4", () => {
  let game = createGame("uno", players, 24);
  game.state.currentColor = "red";
  game.state.discardPile = [{ id: "top", color: "red", kind: "number", value: 3 }];
  game.state.hands = {
    a: [{ id: "a-plus2", color: "red", kind: "draw2" }, { id: "a-safe", color: "red", kind: "number", value: 5 }],
    b: [{ id: "b-plus2", color: "blue", kind: "draw2" }, { id: "b-safe", color: "blue", kind: "number", value: 5 }],
    c: [{ id: "c-plus4", color: null, kind: "wild4" }, { id: "c-safe", color: "green", kind: "number", value: 5 }],
    d: [{ id: "d-plus2", color: "yellow", kind: "draw2" }, { id: "d-safe", color: "yellow", kind: "number", value: 5 }],
  };

  game = reduceGame(game, { type: "PLAY_CARD", playerId: "a", payload: { cardId: "a-plus2" } });
  assert.equal(game.state.pendingDraw, 2);
  assert.equal(game.turn, 1);
  game = reduceGame(game, { type: "PLAY_CARD", playerId: "b", payload: { cardId: "b-plus2" } });
  assert.equal(game.state.pendingDraw, 4);
  assert.equal(game.turn, 2);
  game = reduceGame(game, { type: "PLAY_CARD", playerId: "c", payload: { cardId: "c-plus4", color: "green" } });
  assert.equal(game.state.pendingDraw, 8);
  assert.equal(game.state.pendingDrawKind, "wild4");
  assert.equal(game.state.currentColor, "green");
  assert.match(game.message, /선택 색: 초록/);
  assert.equal(game.turn, 3);

  const dHandBefore = game.state.hands.d.length;
  game = reduceGame(game, { type: "PLAY_CARD", playerId: "d", payload: { cardId: "d-plus2" } });
  assert.match(game.message, /\+4에는 \+4만/);
  assert.equal(game.state.hands.d.length, dHandBefore);
  game = reduceGame(game, { type: "DRAW_CARD", playerId: "d" });
  assert.equal(game.state.hands.d.length, dHandBefore + 8);
  assert.equal(game.state.pendingDraw, 0);
  assert.equal(game.turn, 0);
});

test("uno wild card changes the active color", () => {
  let game = createGame("uno", players.slice(0, 2), 25);
  game.state.currentColor = "red";
  game.state.discardPile = [{ id: "top", color: "red", kind: "number", value: 3 }];
  game.state.hands.a = [
    { id: "a-wild", color: null, kind: "wild" },
    { id: "a-safe", color: "red", kind: "number", value: 5 },
  ];

  game = reduceGame(game, { type: "PLAY_CARD", playerId: "a", payload: { cardId: "a-wild", color: "blue" } });
  assert.equal(game.state.currentColor, "blue");
  assert.match(game.message, /파랑/);
});

test("yut moves from home, captures an opponent and advances the turn", () => {
  let game = createGame("yut", players.slice(0, 2), 22);
  game.state.pendingMoves = [1];
  game.state.canThrow = false;
  game.state.pieces.b[0] = 0;
  game = reduceGame(game, { type: "MOVE_PIECE", playerId: "a", payload: { pieceIndex: 0, moveIndex: 0 } });
  assert.equal(game.state.pieces.a[0], 0);
  assert.equal(game.state.pieces.b[0], -1);
  assert.equal(game.turn, 1);
});

test("davinci code hides opponent numbers and resolves wrong guesses", () => {
  let game = createGame("davinci-code", players.slice(0, 2), 23);
  const projected = projectGame(game, "a");
  const ownNumber = projected.state.hands.a.find((tile: { isJoker: boolean }) => !tile.isJoker);
  assert.equal(typeof ownNumber.number, "number");
  assert.ok(projected.state.hands.b.every((tile: { number: number | null; isJoker: boolean; revealed: boolean }) => tile.revealed || (tile.number === null && !tile.isJoker)));
  assert.equal(projected.state.deck[0], null);

  const pending = game.state.hands.a.find((tile: { isJoker: boolean }) => !tile.isJoker);
  const target = game.state.hands.b.find((tile: { isJoker: boolean }) => !tile.isJoker);
  game.state.unplacedJokers = { a: [], b: [] };
  game.state.hasDrawn = true;
  game.state.pendingTileId = pending.id;
  game.state.pendingPlayerId = "a";
  game = reduceGame(game, { type: "GUESS_TILE", playerId: "a", payload: { targetPlayerId: "b", tileId: target.id, number: (target.number + 1) % 12 }, now: 100 });
  assert.equal(game.state.hands.a.find((tile: { id: string }) => tile.id === pending.id).revealed, true);
  assert.equal(game.turn, 1);
  assert.match(game.feedback?.text ?? "", /오답/);
  assert.doesNotMatch(game.feedback?.text ?? "", /선택한 타일은/);
});

test("davinci code includes both jokers and lets each owner place one only once", () => {
  let game = createGame("davinci-code", players.slice(0, 2), 41);
  const allTiles = [...game.state.hands.a, ...game.state.hands.b, ...game.state.deck];
  const jokers = allTiles.filter((tile: { isJoker: boolean }) => tile.isJoker);
  assert.equal(jokers.length, 2);
  assert.deepEqual(jokers.map((tile: { color: string }) => tile.color).sort(), ["black", "white"]);

  game.state.hands.a = [
    { id: "a-zero", color: "black", number: 0, isJoker: false, revealed: false },
    { id: "a-joker", color: "white", number: null, isJoker: true, revealed: false },
    { id: "a-ten", color: "white", number: 10, isJoker: false, revealed: false },
  ];
  game.state.unplacedJokers = { a: ["a-joker"], b: [] };
  game = reduceGame(game, { type: "PLACE_JOKER", playerId: "a", payload: { tileId: "a-joker", position: 0 } });
  assert.deepEqual(game.state.hands.a.map((tile: { id: string }) => tile.id), ["a-joker", "a-zero", "a-ten"]);
  assert.deepEqual(game.state.unplacedJokers.a, []);

  game = reduceGame(game, { type: "PLACE_JOKER", playerId: "a", payload: { tileId: "a-joker", position: 2 } });
  assert.deepEqual(game.state.hands.a.map((tile: { id: string }) => tile.id), ["a-joker", "a-zero", "a-ten"]);
});

test("davinci code requires a first guess before the player may stop", () => {
  let game = createGame("davinci-code", players.slice(0, 2), 42);
  game.state.hands = {
    a: [
      { id: "a-drawn", color: "black", number: 2, isJoker: false, revealed: false },
      { id: "a-safe", color: "white", number: 8, isJoker: false, revealed: false },
    ],
    b: [
      { id: "b-target", color: "black", number: 4, isJoker: false, revealed: false },
      { id: "b-safe", color: "white", number: 9, isJoker: false, revealed: false },
    ],
  };
  game.state.unplacedJokers = { a: [], b: [] };
  game.state.hasDrawn = true;
  game.state.hasGuessed = false;
  game.state.pendingTileId = "a-drawn";
  game.state.pendingPlayerId = "a";

  game = reduceGame(game, { type: "END_TURN", playerId: "a" });
  assert.equal(game.turn, 0);
  assert.match(game.message, /한 번 이상 추리/);

  game = reduceGame(game, { type: "GUESS_TILE", playerId: "a", payload: { targetPlayerId: "b", tileId: "b-target", number: 4 }, now: 200 });
  assert.equal(game.state.hasGuessed, true);
  assert.equal(game.turn, 0);

  game = reduceGame(game, { type: "END_TURN", playerId: "a" });
  assert.equal(game.turn, 1);
  assert.equal(game.state.hasGuessed, false);
});

test("a multiplayer game keeps running when enough players remain", () => {
  const game = createGame("word-chain", players.slice(0, 3), 11);
  const next = removePlayerFromGame(game, "b");
  assert.equal(next.phase, "playing");
  assert.deepEqual(next.players.map((player) => player.id), ["a", "c"]);
  assert.ok(next.turn >= 0 && next.turn < next.players.length);
});
