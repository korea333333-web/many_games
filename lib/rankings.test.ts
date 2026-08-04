import assert from "node:assert/strict";
import test from "node:test";
import { buildLeaderboard, emptyRankingState, rankTier, recordCompletedMatch } from "./rankings.ts";

const userA = "user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const userB = "user_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const guest = "guest_player";

test("일반 전적은 로그인 사용자에게만 한 번 기록된다", () => {
  const state = emptyRankingState();
  const match = {
    matchId: "match-1",
    gameId: "uno" as const,
    playerIds: [userA, guest],
    winnerIds: [userA],
    ranked: false,
    completedAt: "2026-08-05T00:00:00.000Z",
  };
  assert.equal(recordCompletedMatch(state, match), true);
  assert.equal(recordCompletedMatch(state, match), false);
  assert.deepEqual(state.players[userA].games.uno, { played: 1, wins: 1, losses: 0, draws: 0 });
  assert.equal(state.players[guest], undefined);
});

test("랭크전은 로그인한 두 명의 점수와 승패를 갱신한다", () => {
  const state = emptyRankingState();
  recordCompletedMatch(state, {
    matchId: "ranked-1",
    gameId: "chess",
    playerIds: [userA, userB],
    winnerIds: [userA],
    ranked: true,
    completedAt: "2026-08-05T00:00:00.000Z",
  });
  assert.deepEqual(state.players[userA].ranked.chess, { played: 1, wins: 1, losses: 0, draws: 0, rating: 1016 });
  assert.deepEqual(state.players[userB].ranked.chess, { played: 1, wins: 0, losses: 1, draws: 0, rating: 984 });
});

test("게스트가 섞인 방은 일반 전적만 남고 랭크 점수는 남지 않는다", () => {
  const state = emptyRankingState();
  recordCompletedMatch(state, {
    matchId: "ranked-invalid",
    gameId: "gomoku",
    playerIds: [userA, guest],
    winnerIds: [userA],
    ranked: true,
    completedAt: "2026-08-05T00:00:00.000Z",
  });
  assert.equal(state.players[userA].games.gomoku?.wins, 1);
  assert.equal(state.players[userA].ranked.gomoku, undefined);
});

test("리더보드는 총승리 수로 정렬하고 티어를 계산한다", () => {
  const state = emptyRankingState();
  for (let index = 0; index < 2; index += 1) {
    recordCompletedMatch(state, {
      matchId: `match-${index}`,
      gameId: "connect-four",
      playerIds: [userA, userB],
      winnerIds: [userB],
      ranked: false,
      completedAt: "2026-08-05T00:00:00.000Z",
    });
  }
  const rows = buildLeaderboard(state, (id) => id === userA ? "가람" : "나래");
  assert.equal(rows[0].playerId, userB);
  assert.equal(rows[0].total.wins, 2);
  assert.equal(rankTier(1_000), "실버");
  assert.equal(rankTier(1_650), "다이아");
});
