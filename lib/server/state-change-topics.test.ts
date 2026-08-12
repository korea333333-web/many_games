import assert from "node:assert/strict";
import test from "node:test";
import { getStateChangeTopics } from "./state-change-topics.ts";

function state() {
  return {
    players: { player1: { nickname: "가람", lastSeen: "2026-08-04T00:00:00.000Z" } },
    rooms: { room1: { id: "room1", status: "waiting" } },
    members: { room1: [{ playerId: "player1" }] },
    sessions: {} as Record<string, unknown>,
    messages: [] as unknown[],
    pinnedDirects: {} as Record<string, string[]>,
    rankings: { players: {}, recordedMatches: [] },
  };
}

test("접속 유지 시간만 바뀌면 불필요한 알림을 보내지 않는다", () => {
  const previous = state();
  const next = structuredClone(previous);
  next.players.player1.lastSeen = "2026-08-04T00:00:10.000Z";
  assert.deepEqual(getStateChangeTopics(previous, next), []);
});

test("게임 상태 변경은 해당 방에만 알린다", () => {
  const previous = state();
  const next = structuredClone(previous);
  next.sessions.room1 = { revision: 1 };
  assert.deepEqual(getStateChangeTopics(previous, next), ["room:room1"]);
});

test("방 참가자 변경은 로비와 해당 방에 알린다", () => {
  const previous = state();
  const next = structuredClone(previous);
  next.members.room1.push({ playerId: "player2" });
  assert.deepEqual(getStateChangeTopics(previous, next), ["lobby", "room:room1"]);
});

test("채팅과 닉네임 변경은 로비에 알린다", () => {
  const previous = state();
  const next = structuredClone(previous);
  next.messages.push({ id: 1, body: "안녕" });
  next.players.player1.nickname = "나래";
  assert.deepEqual(getStateChangeTopics(previous, next), ["lobby"]);
});

test("개인 대화 고정 변경은 로비 채널에 알린다", () => {
  const previous = state();
  const next = structuredClone(previous);
  next.pinnedDirects.player1 = ["player2"];
  assert.deepEqual(getStateChangeTopics(previous, next), ["lobby"]);
});

test("전적 변경은 랭킹을 보고 있는 로비에도 알린다", () => {
  const previous = state();
  const next = structuredClone(previous);
  next.rankings.players.player1 = { wins: 1 };
  assert.deepEqual(getStateChangeTopics(previous, next), ["lobby"]);
});
