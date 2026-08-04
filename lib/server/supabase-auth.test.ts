import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationError, resolvePlayerId } from "./supabase-auth.ts";

test("게스트 ID는 로그인 토큰 없이 그대로 사용한다", async () => {
  const request = new Request("https://example.test/api/sync");
  assert.equal(await resolvePlayerId(request, "guest_player_123"), "guest_player_123");
});

test("로그인 계정 ID는 유효한 토큰 없이 사칭할 수 없다", async () => {
  const request = new Request("https://example.test/api/sync");
  await assert.rejects(
    resolvePlayerId(request, "user_fake123"),
    (error) => error instanceof AuthenticationError,
  );
});
