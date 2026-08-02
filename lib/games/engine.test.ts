import assert from "node:assert/strict";
import test from "node:test";
import { GAME_CATALOG } from "./catalog.ts";
import { createGame, projectGame, reduceGame } from "./engine.ts";

const players = [
  { id: "a", name: "민지" },
  { id: "b", name: "준호" },
  { id: "c", name: "소라" },
  { id: "d", name: "태오" },
];

test("catalog keeps the agreed nine games", () => {
  assert.equal(GAME_CATALOG.length, 9);
  assert.deepEqual(GAME_CATALOG.map((game) => game.id), [
    "gomoku", "word-chain", "drawing", "chosung", "same-answer", "liar", "connect-four", "chess", "push-out",
  ]);
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

test("drawing hides prompts from guessers", () => {
  const game = createGame("drawing", players.slice(0, 3), 4);
  assert.equal(projectGame(game, "b").state.promptChoices.length, 0);
  assert.equal(projectGame(game, "a").state.promptChoices.length, 3);
});

test("chosung rewards early answers", () => {
  let game = createGame("chosung", players.slice(0, 2), 5);
  const answer = game.state.answer;
  game = reduceGame(game, { type: "GUESS", playerId: "a", payload: { guess: answer } });
  assert.equal(game.phase, "finished");
  assert.ok(game.players[0].score >= 100);
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

test("push out removes players outside the arena", () => {
  let game = createGame("push-out", players.slice(0, 2), 9);
  game.state.positions.a = { x: 0.99, y: 0, alive: true };
  game = reduceGame(game, { type: "MOVE", playerId: "a", payload: { dx: 1, dy: 0 } });
  assert.equal(game.state.positions.a.alive, false);
  assert.deepEqual(game.winnerIds, ["b"]);
});
