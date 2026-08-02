import assert from "node:assert/strict";
import test from "node:test";
import { GAME_CATALOG } from "./catalog.ts";
import { advanceTimedGame, createGame, getChessLegalTargets, getChessViewIndexes, projectGame, reduceGame, removePlayerFromGame } from "./engine.ts";
import { WORD_CHAIN_WORDS } from "./word-bank.ts";
import { hasUnreadMessage, latestMessageId } from "../chat/unread.ts";

const players = [
  { id: "a", name: "민지" },
  { id: "b", name: "준호" },
  { id: "c", name: "소라" },
  { id: "d", name: "태오" },
];

test("catalog keeps the selected eleven games", () => {
  assert.equal(GAME_CATALOG.length, 11);
  assert.deepEqual(GAME_CATALOG.map((game) => game.id), [
    "gomoku", "word-chain", "drawing", "chosung", "same-answer", "liar", "connect-four", "chess", "uno", "yut", "davinci-code",
  ]);
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

test("same answer only scores unique submissions", () => {
  let game = createGame("same-answer", players.slice(0, 3), 6);
  game = reduceGame(game, { type: "SUBMIT_ANSWER", playerId: "a", payload: { answer: "사과" } });
  game = reduceGame(game, { type: "SUBMIT_ANSWER", playerId: "b", payload: { answer: "사과" } });
  game = reduceGame(game, { type: "SUBMIT_ANSWER", playerId: "c", payload: { answer: "딸기" } });
  assert.deepEqual(game.winnerIds, ["c"]);
});

test("liar projection hides the word only from the liar", () => {
  const game = createGame("liar", players, 7);
  const liarId = game.players[game.state.liarIndex].id;
  assert.equal(projectGame(game, liarId).state.word, null);
  const citizen = game.players.find((player) => player.id !== liarId)!;
  assert.ok(projectGame(game, citizen.id).state.word);
});

test("casual chess allows a legal pawn move", () => {
  let game = createGame("chess", players.slice(0, 2), 8);
  game = reduceGame(game, { type: "MOVE", playerId: "a", payload: { from: 52, to: 36 } });
  assert.equal(game.state.board[36], "wP");
  assert.equal(game.turn, 1);
});

test("chess pawn can capture diagonally", () => {
  let game = createGame("chess", players.slice(0, 2), 10);
  game.state.board = Array(64).fill(null);
  game.state.board[36] = "wP";
  game.state.board[27] = "bP";
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
  assert.equal(typeof projected.state.hands.a[0].number, "number");
  assert.equal(projected.state.hands.b[0].number, null);
  assert.equal(projected.state.deck[0], null);

  const pending = game.state.hands.a[0];
  const target = game.state.hands.b[0];
  game.state.hasDrawn = true;
  game.state.pendingTileId = pending.id;
  game.state.pendingPlayerId = "a";
  game = reduceGame(game, { type: "GUESS_TILE", playerId: "a", payload: { targetPlayerId: "b", tileId: target.id, number: (target.number + 1) % 12 }, now: 100 });
  assert.equal(game.state.hands.a.find((tile: { id: string }) => tile.id === pending.id).revealed, true);
  assert.equal(game.turn, 1);
  assert.match(game.feedback?.text ?? "", /오답/);
});

test("a multiplayer game keeps running when enough players remain", () => {
  const game = createGame("word-chain", players.slice(0, 3), 11);
  const next = removePlayerFromGame(game, "b");
  assert.equal(next.phase, "playing");
  assert.deepEqual(next.players.map((player) => player.id), ["a", "c"]);
  assert.ok(next.turn >= 0 && next.turn < next.players.length);
});
