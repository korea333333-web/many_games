import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SECONDARY_ADMINS, adminRoleFor, createDefaultProfile, normalizeModerationState, normalizeProfiles } from "./community.ts";

test("1짱 관리자는 한 명이고 2짱 관리자와 구분된다", () => {
  const state = normalizeModerationState({ masterId: "user_master", secondaryAdminIds: ["user_admin", "user_admin"] });
  assert.equal(adminRoleFor(state, "user_master"), "master");
  assert.equal(adminRoleFor(state, "user_admin"), "admin");
  assert.equal(adminRoleFor(state, "user_player"), null);
  assert.deepEqual(state.secondaryAdminIds, ["user_admin"]);
});

test("프로필 정규화는 잘못된 코인과 미보유 치장품을 제거한다", () => {
  const profiles = normalizeProfiles({
    user_player: { coins: -20, inventoryIds: ["background-grid", "invalid"], equipped: { background: "invalid" } },
  });
  assert.equal(profiles.user_player.coins, 0);
  assert.deepEqual(profiles.user_player.inventoryIds, ["badge-rookie", "background-grid"]);
  assert.deepEqual(profiles.user_player.equipped, { badge: "badge-rookie" });
});

test("새 로그인 프로필에는 무료 기본 배지가 들어간다", () => {
  const profile = createDefaultProfile("2026-08-12T00:00:00.000Z");
  assert.deepEqual(profile.inventoryIds, ["badge-rookie"]);
  assert.equal(profile.equipped.badge, "badge-rookie");
});

test("파란 관리자는 중복 없이 최대 10명까지만 복원한다", () => {
  const ids = Array.from({ length: 14 }, (_, index) => `user_admin_${index}`);
  const state = normalizeModerationState({ secondaryAdminIds: [...ids, ids[0]] });
  assert.equal(state.secondaryAdminIds.length, MAX_SECONDARY_ADMINS);
  assert.deepEqual(state.secondaryAdminIds, ids.slice(0, MAX_SECONDARY_ADMINS));
});

test("서버 공지는 정규화할 때 200글자와 유효한 필드만 보존한다", () => {
  const state = normalizeModerationState({
    announcement: { id: "notice", body: "가".repeat(240), issuerId: "user_admin", createdAt: "2026-08-12T00:00:00.000Z", expiresAt: "2026-08-12T00:01:00.000Z" },
  });
  assert.equal(state.announcement?.body.length, 200);
  assert.equal(state.lastAnnouncementAt, "2026-08-12T00:00:00.000Z");
});
