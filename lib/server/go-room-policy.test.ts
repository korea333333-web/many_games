import assert from "node:assert/strict";
import test from "node:test";
import {
  canJoinPersistentGoRoom,
  GO_INACTIVE_EXPIRY_MS,
  isPersistentGoRoomExpired,
  latestGoActivityAt,
} from "./go-room-policy.ts";

test("바둑방은 예약된 두 참가자만 다시 들어갈 수 있다", () => {
  const reserved = ["user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "user_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"];
  assert.equal(canJoinPersistentGoRoom(reserved, reserved[0]), true);
  assert.equal(canJoinPersistentGoRoom(reserved, "user_cccccccccccccccccccccccccccccccc"), false);
  assert.equal(canJoinPersistentGoRoom(reserved.slice(0, 1), "user_cccccccccccccccccccccccccccccccc"), true);
});

test("늦게 실행된 정리 작업이 실제 마지막 접속 시각을 덮어쓰지 않는다", () => {
  assert.equal(
    latestGoActivityAt("2026-08-11T10:00:00.000Z", "2026-08-11T11:00:00.000Z"),
    "2026-08-11T11:00:00.000Z",
  );
  assert.equal(
    latestGoActivityAt("2026-08-11T12:00:00.000Z", "2026-08-11T11:00:00.000Z"),
    "2026-08-11T12:00:00.000Z",
  );
});

test("빈 바둑방은 마지막 활동 후 24시간이 지나야 만료된다", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");
  const room = {
    createdAt: "2026-08-11T10:00:00.000Z",
    updatedAt: "2026-08-11T10:00:00.000Z",
    lastActiveAt: new Date(now - GO_INACTIVE_EXPIRY_MS).toISOString(),
  };
  assert.equal(isPersistentGoRoomExpired(room, 0, now - 1), false);
  assert.equal(isPersistentGoRoomExpired(room, 0, now), true);
  assert.equal(isPersistentGoRoomExpired(room, 1, now), false);
});
