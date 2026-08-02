# 게임 로비 하네스

이 프로젝트는 화면과 게임 규칙을 분리해, 온라인 통신이 흔들려도 규칙을 독립적으로 검증할 수 있게 구성했다.

- `lib/games/engine.ts`: 아홉 게임의 순수 생성기·리듀서·관전자 투영 함수
- `lib/games/engine.test.ts`: 승리 조건, 턴, 힌트, 비밀 정보, 충돌 규칙의 결정적 단위 테스트
- `lib/server/platform-store.ts`: D1을 사용하는 명령 버스. 서버가 방·채팅·게임 상태의 단일 기준이다.
- `app/api/sync/route.ts`: 익명 기기 세션을 받는 동기화 경계
- `app/components/GamePlatform.tsx`: 폴링, 재접속, 로비·방·전체 채팅·개인 채팅 UI

## 검증 명령

```bash
pnpm run test:unit
pnpm run build
node --test tests/rendered-html.test.mjs
```

게임 액션은 현재 revision을 함께 보내고, 서버는 일치할 때만 다음 revision으로 갱신한다. 초성 정답, 그림 제시어, 라이어 정보처럼 사용자마다 달라야 하는 정보는 서버에서 투영한 뒤 전달한다.
