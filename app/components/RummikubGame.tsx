"use client";

import { useMemo, useState } from "react";
import type { GameCommand, GameEnvelope, RummikubTile } from "@/lib/games/engine";

type Props = {
  game: GameEnvelope;
  playerId: string;
  disabled: boolean;
  onAction: (command: Omit<GameCommand, "playerId">) => Promise<unknown>;
};

const COLOR_NAMES = { red: "빨강", blue: "파랑", yellow: "노랑", black: "검정" } as const;

function TileFace({ tile, selected = false, onClick }: { tile: RummikubTile | null; selected?: boolean; onClick?: () => void }) {
  if (!tile) return <span className="rummi-tile back" aria-label="숨겨진 타일">R</span>;
  const label = tile.isJoker ? "조커" : `${COLOR_NAMES[tile.color!]} ${tile.number}`;
  const content = <><small>{tile.isJoker ? "★" : tile.number}</small><i>{tile.isJoker ? "JOKER" : tile.color?.slice(0, 1).toUpperCase()}</i></>;
  if (!onClick) return <span className={`rummi-tile ${tile.isJoker ? "joker" : tile.color}`}>{content}</span>;
  return <button type="button" className={`rummi-tile ${tile.isJoker ? "joker" : tile.color} ${selected ? "selected" : ""}`} onClick={onClick} aria-label={label} aria-pressed={selected}>{content}</button>;
}

export function RummikubGame({ game, playerId, disabled, onAction }: Props) {
  const [selectedRackIds, setSelectedRackIds] = useState<string[]>([]);
  const [selectedTable, setSelectedTable] = useState<{ meldIndex: number; tileId: string } | null>(null);
  const [targetMeld, setTargetMeld] = useState("0");
  const racks = game.state.racks as Record<string, Array<RummikubTile | null>>;
  const rack = useMemo(() => (racks[playerId] ?? []).filter((tile): tile is RummikubTile => Boolean(tile)), [racks, playerId]);
  const table = game.state.table as RummikubTile[][];
  const myTurn = game.players[game.turn]?.id === playerId;
  const canAct = !disabled && myTurn && game.phase === "playing";
  const opened = Boolean(game.state.opened?.[playerId]);
  const rackIdSet = useMemo(() => new Set(rack.map((tile) => tile.id)), [rack]);
  const validSelectedRackIds = selectedRackIds.filter((id) => rackIdSet.has(id));
  const validSelectedTable = selectedTable && table[selectedTable.meldIndex]?.some((tile) => tile.id === selectedTable.tileId) ? selectedTable : null;

  const toggleRack = (tileId: string) => setSelectedRackIds((current) => current.includes(tileId) ? current.filter((id) => id !== tileId) : [...current, tileId]);
  const playTiles = (targetMeldIndex: number) => {
    if (!validSelectedRackIds.length) return;
    void onAction({ type: "PLAY_TILES", payload: { tileIds: validSelectedRackIds, targetMeldIndex } });
    setSelectedRackIds([]);
  };
  const moveTableTile = () => {
    if (!validSelectedTable) return;
    const targetMeldIndex = targetMeld === "new" ? -1 : Number(targetMeld);
    void onAction({ type: "MOVE_TABLE_TILE", payload: { ...validSelectedTable, fromMeldIndex: validSelectedTable.meldIndex, targetMeldIndex } });
    setSelectedTable(null);
  };

  return (
    <div className="rummikub-game">
      <div className="rummi-status-row">
        <div><span className="eyebrow">POOL</span><strong>{game.state.pool.length}개</strong></div>
        <div className={opened ? "opened" : "unopened"}><span>내 등록 상태</span><strong>{opened ? "30점 등록 완료" : "최초 30점 필요"}</strong></div>
        <div><span>현재 차례</span><strong>{game.players[game.turn]?.name}</strong></div>
      </div>

      <div className="rummi-opponents" aria-label="다른 플레이어의 남은 타일">
        {game.players.filter((player) => player.id !== playerId).map((player) => (
          <div key={player.id} className={game.players[game.turn]?.id === player.id ? "active" : ""}><span>{player.name}</span><b>{racks[player.id]?.length ?? 0}개</b>{game.state.opened?.[player.id] && <small>등록 완료</small>}</div>
        ))}
      </div>

      <section className="rummi-table" aria-label="루미큐브 테이블">
        {table.length ? table.map((meld, meldIndex) => (
          <article key={`${meldIndex}-${meld.map((tile) => tile.id).join("-")}`} className={validSelectedTable?.meldIndex === meldIndex ? "selected" : ""}>
            <header><span>조합 {meldIndex + 1}</span><small>{meld.length}개</small></header>
            <div>{meld.map((tile) => <TileFace key={tile.id} tile={tile} selected={validSelectedTable?.tileId === tile.id} onClick={canAct && opened ? () => { setSelectedTable((current) => current?.tileId === tile.id ? null : { meldIndex, tileId: tile.id }); const other = table.findIndex((_, index) => index !== meldIndex); setTargetMeld(other >= 0 ? String(other) : "new"); } : undefined} />)}</div>
          </article>
        )) : <div className="rummi-empty-table"><span>7 · 8 · 9</span><strong>아직 놓인 조합이 없습니다</strong><small>같은 숫자 3~4개 또는 같은 색 연속 숫자 3개 이상</small></div>}
      </section>

      {canAct && opened && validSelectedTable && (
        <div className="rummi-move-bar">
          <span>선택한 테이블 타일을</span>
          <select value={targetMeld} onChange={(event) => setTargetMeld(event.target.value)}>
            {table.map((_, index) => index !== validSelectedTable.meldIndex && <option key={index} value={index}>조합 {index + 1}로</option>)}
            <option value="new">새 조합으로</option>
          </select>
          <button type="button" onClick={moveTableTile}>옮기기</button>
        </div>
      )}

      <section className="rummi-rack" aria-label="내 타일 받침대">
        <header><div><span className="eyebrow">MY RACK</span><strong>내 타일 {rack.length}개</strong></div><small>{canAct ? "여러 개를 골라 한 번에 놓을 수 있어요" : myTurn ? "관전 중" : "상대 차례를 기다리는 중"}</small></header>
        <div className="rummi-rack-tiles">{rack.map((tile) => <TileFace key={tile.id} tile={tile} selected={validSelectedRackIds.includes(tile.id)} onClick={canAct ? () => toggleRack(tile.id) : undefined} />)}</div>
      </section>

      <div className="rummi-actions">
        <div className="rummi-place-actions">
          <button type="button" disabled={!canAct || !validSelectedRackIds.length} onClick={() => playTiles(-1)}>+ 새 조합 만들기</button>
          <select disabled={!canAct || !opened || !table.length} value={targetMeld} onChange={(event) => setTargetMeld(event.target.value)}>{table.map((_, index) => <option key={index} value={index}>조합 {index + 1}</option>)}</select>
          <button type="button" disabled={!canAct || !opened || !validSelectedRackIds.length || !table.length || targetMeld === "new"} onClick={() => playTiles(Number(targetMeld))}>선택 조합에 붙이기</button>
        </div>
        <div className="rummi-turn-actions">
          <button type="button" className="secondary-button" disabled={!canAct} onClick={() => void onAction({ type: "UNDO_TURN" })}>이번 턴 되돌리기</button>
          <button type="button" className="rummi-draw" disabled={!canAct} onClick={() => void onAction({ type: "DRAW_TILE" })}>타일 1개 뽑기</button>
          <button type="button" className="primary-button" disabled={!canAct} onClick={() => void onAction({ type: "COMMIT_TURN" })}>조합 확인 · 턴 끝내기</button>
        </div>
      </div>
      <p className="rummi-help">턴 끝내기 때 모든 조합을 서버가 검사합니다 · 유효하지 않으면 되돌리기로 턴 시작 상태를 복원하세요</p>
    </div>
  );
}
