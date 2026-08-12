"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import type { DefenseDifficulty, GameCommand, GameEnvelope, WordDefenseEnemy } from "@/lib/games/engine";

type Props = {
  game: GameEnvelope;
  playerId: string;
  disabled: boolean;
  onAction: (command: Omit<GameCommand, "playerId">) => Promise<unknown>;
};

const DIFFICULTY_NAMES: Record<DefenseDifficulty, string> = { easy: "EASY", medium: "MEDIUM", hard: "HARD" };

function enemyProgress(enemy: Pick<WordDefenseEnemy, "spawnedAt" | "fallDurationMs">, now: number) {
  return Math.max(0, Math.min(1, (now - enemy.spawnedAt) / enemy.fallDurationMs));
}

export function WordDefenseGame({ game, playerId, disabled, onAction }: Props) {
  const [word, setWord] = useState("");
  const [now, setNow] = useState(() => Number(game.state.projectedAt ?? Date.now()));
  const inputRef = useRef<HTMLInputElement>(null);
  const difficulty = game.state.difficulty as DefenseDifficulty;
  const enemies = game.state.enemies as WordDefenseEnemy[];
  const boss = game.state.boss as { hp: number; maxHp: number; word: string; spawnedAt: number; fallDurationMs: number } | null;
  const displayNow = game.phase === "finished" ? Number(game.state.finishedAt ?? game.state.endsAt) : now;
  const secondsLeft = Math.max(0, Math.ceil((Number(game.state.endsAt) - displayNow) / 1_000));
  const charges = Number(game.state.boomCharges?.[playerId] ?? 0);
  const typedKills = Number(game.state.typedKills?.[playerId] ?? 0);
  const chargeProgress = (typedKills % 20) / 20 * 100;
  const event = game.state.lastEvent as { id: string; type: string; count: number; targets?: WordDefenseEnemy[] } | null;
  const rewards = game.state.goldRewards as Record<string, number>;

  useEffect(() => {
    if (game.phase === "finished") return;
    const timer = window.setInterval(() => setNow(Date.now()), 50);
    return () => window.clearInterval(timer);
  }, [game.phase, game.state.endsAt, game.state.finishedAt]);

  const sortedTeam = useMemo(() => [...game.players].sort((a, b) => Number(game.state.destroyed?.[b.id] ?? 0) - Number(game.state.destroyed?.[a.id] ?? 0)), [game.players, game.state.destroyed]);
  const submitWord = (typedWord: string) => {
    const next = typedWord.trim();
    if (!next || disabled || game.phase === "finished") return;
    setWord("");
    void onAction({ type: "TYPE_WORD", payload: { word: next } });
    inputRef.current?.focus();
  };
  const submit = (eventValue: FormEvent) => {
    eventValue.preventDefault();
    submitWord(word);
  };
  const basePercent = Math.max(0, Math.min(100, Number(game.state.baseHp) / Number(game.state.maxBaseHp) * 100));
  const bossProgress = boss ? enemyProgress(boss, displayNow) : 0;

  return (
    <div className={`word-defense-game difficulty-${difficulty}`}>
      <header className="defense-hud">
        <div className="defense-mode"><span>{DIFFICULTY_NAMES[difficulty]}</span><strong>협동 키보드 디펜스</strong><small>승리 횟수·랭킹 미반영</small></div>
        <div className={secondsLeft <= 30 ? "defense-clock urgent" : "defense-clock"}><small>남은 시간</small><strong>{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</strong></div>
        <div className="defense-base"><div><span>기지 체력</span><b>{game.state.baseHp}/{game.state.maxBaseHp}</b></div><i><span style={{ width: `${basePercent}%` }} /></i></div>
      </header>

      <div className="defense-layout">
        <section className="defense-arena" aria-label="단어 적 전장" onClick={() => inputRef.current?.focus()}>
          <div className="defense-sky"><i /><i /><i /></div>
          <div className="defense-danger-line"><span>DANGER ZONE</span></div>
          {enemies.map((enemy) => {
            const progress = enemyProgress(enemy, displayNow);
            return <div key={enemy.id} className={`word-enemy ${progress > 0.72 ? "danger" : ""}`} style={{ "--enemy-x": `${7 + enemy.lane * 14}%`, "--enemy-y": `${5 + progress * 78}%` } as CSSProperties}><i aria-hidden="true">◆</i><strong>{enemy.word}</strong><small>{Math.round((1 - progress) * enemy.fallDurationMs / 1_000)}초</small></div>;
          })}
          {boss && !game.state.bossDefeated && (
            <div className="defense-boss" style={{ "--boss-y": `${6 + bossProgress * 66}%` } as CSSProperties}>
              <div className="boss-crown">BOSS</div><i aria-hidden="true">⬢</i><strong>{boss.word}</strong>
              <div><span style={{ width: `${boss.hp / boss.maxHp * 100}%` }} /></div><small>{boss.hp}/{boss.maxHp} WORDS</small>
            </div>
          )}
          {game.state.bossDefeated && <div className="boss-defeated"><b>BOSS BREAK!</b><span>추가 골드 확보</span></div>}
          {event && event.type === "boom" && <div key={event.id} className="defense-boom"><span>BOOM!</span><b>{event.count} KILLS</b>{Array.from({ length: 12 }, (_, index) => <i key={index} style={{ "--blast-ray": index } as CSSProperties} />)}</div>}
          {event && event.type === "boss-hit" && <div key={event.id} className="boss-hit-effect">CRITICAL TYPE!</div>}
          {event && event.type === "breach" && <div key={event.id} className="defense-breach-effect">⚠ 방어선 돌파 −{event.count}</div>}
          <div className="defense-base-art"><span>⌨</span><i /><i /><i /></div>
          {!enemies.length && !boss && game.phase === "playing" && <div className="defense-wave-wait"><span>다음 웨이브 탐지 중</span><i /></div>}
        </section>

        <aside className="defense-team">
          <header><span>TEAM</span><strong>{game.players.length}명 협동 중</strong></header>
          {sortedTeam.map((player, index) => <div key={player.id} className={player.id === playerId ? "mine" : ""}><span>{index + 1}</span><p><strong>{player.name}</strong><small>직접 {game.state.typedKills?.[player.id] ?? 0} · 총 {game.state.destroyed?.[player.id] ?? 0}</small></p><b>{game.state.boomCharges?.[player.id] ? `BOOM ×${game.state.boomCharges[player.id]}` : ""}</b></div>)}
          <section className="defense-reward-guide"><span>골드 계산</span><p>생존 시간 + 직접 처치 + 완주</p><strong>보스 격파 시 대량 보너스</strong><small>로그인 계정에만 지급</small></section>
        </aside>
      </div>

      <div className="defense-controls">
        <div className="boom-meter"><div><span>BOOM 게이지</span><b>{charges ? `${charges}회 사용 가능` : `${typedKills % 20}/20`}</b></div><i><span style={{ width: charges ? "100%" : `${chargeProgress}%` }} /></i></div>
        <form onSubmit={submit}><input ref={inputRef} autoFocus autoComplete="off" spellCheck={false} value={word} onChange={(eventValue) => setWord(eventValue.target.value)} disabled={disabled || game.phase === "finished"} placeholder={disabled ? "관전 중" : "화면의 단어를 입력하고 Enter"} /><button disabled={disabled || !word.trim() || game.phase === "finished"}>격파</button></form>
        <button type="button" className={charges ? "boom-button charged" : "boom-button"} disabled={disabled || !charges || game.phase === "finished"} onClick={() => submitWord("boom!")}><span>BOOM!</span><small>적 5~10마리 제거</small></button>
      </div>
      {game.phase === "finished" && <div className="defense-final-reward"><span>내 획득 골드</span><strong>🪙 {rewards?.[playerId] ?? 0}</strong><small>협동전이라 전적과 승리 횟수는 변하지 않습니다.</small></div>}
    </div>
  );
}
