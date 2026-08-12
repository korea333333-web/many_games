import assert from "node:assert/strict";
import test from "node:test";
import { adminRoleFor, createDefaultProfile, normalizeModerationState, normalizeProfiles } from "./community.ts";

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
