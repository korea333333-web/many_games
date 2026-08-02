import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("게임 로비와 동기화 API가 배포 산출물에 포함됐다", async () => {
  const [page, platform, worker] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/GamePlatform.tsx", import.meta.url), "utf8"),
    readFile(new URL("../dist/server/index.js", import.meta.url), "utf8"),
  ]);
  assert.match(page, /title:\s*"게임 로비"/);
  assert.match(platform, /로비에 연결하는 중/);
  assert.match(worker, /functions\/v1\/game-platform-state/);
  assert.match(worker, /route:\/api\/sync/);
  assert.doesNotMatch(`${page}${platform}`, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("임시 프리뷰 자산이 제품 코드에서 제거됐다", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /GamePlatform/);
  assert.match(layout, /lang="ko"/);
  assert.doesNotMatch(`${page}${layout}${packageJson}`, /_sites-preview|react-loading-skeleton|codex-preview/);
  await assert.rejects(access(new URL("../public/_sites-preview", import.meta.url)));
});
