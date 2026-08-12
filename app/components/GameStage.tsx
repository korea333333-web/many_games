"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { getChessLegalTargets, getChessViewIndexes, reduceGame, type DavinciTile, type GameCommand, type GameEnvelope, type UnoCard, type UnoColor } from "@/lib/games/engine";
import { GAME_BY_ID, type GameId } from "@/lib/games/catalog";
import { RummikubGame } from "./RummikubGame";
import { WordDefenseGame } from "./WordDefenseGame";

type Props = {
  game: GameEnvelope;
  revision: number;
  playerId: string;
  viewerRole: string;
  onAction: (command: Omit<GameCommand, "playerId">) => Promise<unknown>;
};

type GameViewProps = Pick<Props, "game" | "playerId" | "onAction"> & { disabled: boolean };

const INSTANT_GAMES = new Set<GameId>(["gomoku", "go", "connect-four", "chess"]);

export function GameStage({ game, revision, playerId, viewerRole, onAction }: Props) {
  const [optimistic, setOptimistic] = useState<{ revision: number; game: GameEnvelope } | null>(null);
  const [inspectedResultSeed, setInspectedResultSeed] = useState<number | null>(null);
  const shownGame = optimistic?.revision === revision ? optimistic.game : game;
  const info = GAME_BY_ID[shownGame.gameId];
  const player = shownGame.players.find((item) => item.id === playerId);
  const spectator = viewerRole === "spectator" || !player;
  const winners = shownGame.players.filter((item) => shownGame.winnerIds.includes(item.id));
  const hasInspectibleResult = ["chess", "go", "uno", "davinci-code"].includes(shownGame.gameId);
  const inspectingFinalResult = hasInspectibleResult && shownGame.phase === "finished" && inspectedResultSeed === shownGame.seed;
  const runAction = (command: Omit<GameCommand, "playerId">) => {
    if (INSTANT_GAMES.has(shownGame.gameId) && shownGame.phase === "playing" && !spectator) {
      const now = Date.now();
      setOptimistic({ revision, game: reduceGame(shownGame, { ...command, playerId, now }) });
    }
    const result = onAction(command);
    void result.then((value) => { if (!value) setOptimistic(null); });
    return result;
  };
  return (
    <div className="game-stage">
      <div className="stage-header">
        <div><span className="eyebrow">{info.name} · {spectator ? "관전 중" : shownGame.state.maxRounds ? `${shownGame.round}/${shownGame.state.maxRounds}라운드` : `${shownGame.round}라운드`}</span><h2>{shownGame.message}</h2></div>
        <div className="score-strip">{shownGame.players.map((item, index) => <div key={item.id} className={item.id === playerId ? "current" : ""}><i style={{ background: playerColor(index) }} /> <span>{item.name}</span><b>{item.score}</b></div>)}</div>
      </div>
      <div className="stage-body">
        {shownGame.gameId === "gomoku" && <Gomoku game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "go" && <GoBoard game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "connect-four" && <ConnectFour game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "chess" && <Chess game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "word-chain" && <WordChain game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "drawing" && <Drawing game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "chosung" && <Chosung game={shownGame} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "same-answer" && <SameAnswer game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "liar" && <Liar game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "uno" && <Uno game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "yut" && <Yut game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "davinci-code" && <DavinciCode game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "rummikub" && <RummikubGame game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
        {shownGame.gameId === "word-defense" && <WordDefenseGame game={shownGame} playerId={playerId} disabled={spectator} onAction={runAction} />}
      </div>
      {shownGame.gameId === "davinci-code" && shownGame.state.comboEvent && <DavinciComboEffect game={shownGame} />}
      {shownGame.feedback && <AnswerFeedback game={shownGame} playerId={playerId} />}
      {shownGame.phase === "finished" && !inspectingFinalResult && <VictoryOverlay gameId={shownGame.gameId} winners={winners.map((item) => item.name)} message={shownGame.message} reward={shownGame.gameId === "word-defense" ? Number(shownGame.state.goldRewards?.[playerId] ?? 0) : undefined} onInspectResult={hasInspectibleResult ? () => setInspectedResultSeed(shownGame.seed) : undefined} />}
      {inspectingFinalResult && (
        <div className="chess-final-board-banner" role="status">
          <div>
            <strong>{shownGame.gameId === "go" ? "계가 완료 · 마지막 판" : shownGame.gameId === "chess" ? "체크메이트 · 마지막 판" : shownGame.gameId === "uno" ? "UNO · 마지막 패" : "CODE REVEALED · 마지막 패"}</strong>
            <span>{shownGame.gameId === "go" ? `흑 ${shownGame.state.finalScore?.black ?? 0}집 · 백 ${shownGame.state.finalScore?.white ?? 0}집` : shownGame.gameId === "chess" ? shownGame.state.lastMove?.san ? `마지막 수 ${shownGame.state.lastMove.san}` : "최종 기물 배치" : shownGame.gameId === "uno" ? "모든 플레이어의 남은 카드를 공개합니다." : "모든 숫자와 조커를 공개합니다."}</span>
          </div>
          <button type="button" onClick={() => setInspectedResultSeed(null)}>결과 다시 보기</button>
        </div>
      )}
    </div>
  );
}

function DavinciComboEffect({ game }: { game: GameEnvelope }) {
  const combo = game.state.comboEvent as { id: string; playerId: string; count: number };
  const player = game.players.find((item) => item.id === combo.playerId);
  const tier = combo.count >= 5 ? "legendary" : combo.count === 4 ? "super" : "triple";
  return (
    <div key={combo.id} className={`davinci-combo ${tier}`} role="status" aria-live="assertive">
      <div className="davinci-combo-flash" />
      <div className="davinci-combo-burst" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ "--combo-ray": index } as CSSProperties} />)}</div>
      <div className="davinci-combo-code" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <span key={index}>{(index * 7 + combo.count * 3) % 12}</span>)}</div>
      <div className="davinci-combo-title">
        <small>{player?.name ?? "플레이어"} · CODE BREAK</small>
        <strong><b>{combo.count}</b> COMBO!</strong>
        <p>{combo.count >= 5 ? "암호가 완전히 무너집니다!" : combo.count === 4 ? "추리가 멈추지 않습니다!" : "연속 추리 성공!"}</p>
      </div>
    </div>
  );
}

function AnswerFeedback({ game, playerId }: Pick<Props, "game" | "playerId">) {
  const feedback = game.feedback!;
  const sourceIndex = game.players.findIndex((item) => item.id === feedback.playerId);
  const source = game.players[sourceIndex];
  const side = sourceIndex % 2 === 0 ? "left" : "right";
  const relation = feedback.playerId === playerId ? "mine" : "opponent";
  return (
    <div key={feedback.id} className={`answer-feedback ${side} ${relation} ${feedback.kind}`} role="status" aria-live="polite">
      <span>{source?.name?.slice(0, 1) ?? "?"}</span>
      <div><b>{source?.name ?? "플레이어"}</b><p>{feedback.text}</p></div>
    </div>
  );
}

const VICTORY_THEMES: Record<GameId, { kicker: string; icon: string }> = {
  gomoku: { kicker: "FIVE IN A ROW", icon: "●" },
  go: { kicker: "FINAL COUNT", icon: "◉" },
  "connect-four": { kicker: "FOUR CONNECTED", icon: "●" },
  chess: { kicker: "CHECKMATE", icon: "♚" },
  "word-chain": { kicker: "LAST WORD", icon: "끝" },
  drawing: { kicker: "MASTERPIECE", icon: "✎" },
  chosung: { kicker: "QUIZ CHAMPION", icon: "ㅊ" },
  "same-answer": { kicker: "ONE OF A KIND", icon: "1" },
  liar: { kicker: "IDENTITY REVEALED", icon: "?" },
  uno: { kicker: "UNO!", icon: "U" },
  yut: { kicker: "ALL PIECES HOME", icon: "윷" },
  "davinci-code": { kicker: "CODE CRACKED", icon: "#" },
  rummikub: { kicker: "RUMMIKUB!", icon: "7" },
  "word-defense": { kicker: "BASE DEFENDED", icon: "⌨" },
};

function VictoryOverlay({ gameId, winners, message, reward, onInspectResult }: { gameId: GameId; winners: string[]; message: string; reward?: number; onInspectResult?: () => void }) {
  const cooperative = gameId === "word-defense";
  const title = cooperative ? winners.length ? "3분 방어 성공!" : "방어 실패" : winners.length ? `${winners.join(", ")} 승리!` : "무승부!";
  const theme = VICTORY_THEMES[gameId];
  const inspection = gameId === "go" ? { icon: "◉", label: "마지막 판 보기" } : gameId === "chess" ? { icon: "♟", label: "마지막 판 보기" } : gameId === "uno" ? { icon: "U", label: "마지막 패 보기" } : { icon: "#", label: "마지막 패 보기" };
  return (
    <div className={`victory-overlay victory-${gameId}`} role="status" aria-live="assertive">
      <div className="victory-particles" aria-hidden="true">{Array.from({ length: 16 }, (_, index) => <i key={index} />)}</div>
      <div className={`victory-card theme-${gameId}`}>
        <VictoryScene gameId={gameId} />
        <span className="victory-trophy" aria-hidden="true">{winners.length ? theme.icon : cooperative ? "⚠" : "◆"}</span>
        <span className="eyebrow">{winners.length ? theme.kicker : cooperative ? "BASE BREACHED" : "DRAW GAME"}</span>
        <h2>{title}</h2>
        <p>{message}</p>
        {cooperative && <div className="victory-coop-reward"><strong>🪙 +{reward ?? 0}</strong><span>로그인 계정 지급 · 전적/랭킹 미반영</span></div>}
        {onInspectResult && <button className="victory-board-button" type="button" onClick={onInspectResult}>{inspection.icon} {inspection.label}</button>}
        <small>{onInspectResult ? "마지막 상태를 확인한 뒤 같은 방으로 돌아갑니다." : "잠시 후 같은 방의 대기 화면으로 돌아갑니다."}</small>
      </div>
    </div>
  );
}

function VictoryScene({ gameId }: { gameId: GameId }) {
  if (gameId === "gomoku") return <div className="victory-scene stones" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div>;
  if (gameId === "go") return <div className="victory-scene go-score" aria-hidden="true"><i>●</i><b>집</b><i>○</i></div>;
  if (gameId === "connect-four") return <div className="victory-scene discs" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <i key={index} />)}</div>;
  if (gameId === "chess") return <div className="victory-scene chess-mate" aria-hidden="true"><i>♔</i><b>CHECKMATE</b><i>♚</i></div>;
  if (gameId === "word-chain") return <div className="victory-scene word-ribbon" aria-hidden="true"><i>끝</i><i>말</i><i>잇</i><i>기</i></div>;
  if (gameId === "drawing") return <div className="victory-scene paint" aria-hidden="true"><i /><i /><i /><b>✎</b></div>;
  if (gameId === "chosung") return <div className="victory-scene consonants" aria-hidden="true"><i>ㅊ</i><i>ㅅ</i><i>ㅋ</i><i>ㅈ</i></div>;
  if (gameId === "same-answer") return <div className="victory-scene unique-answer" aria-hidden="true"><i>A</i><i>A</i><b>C</b><i>B</i><i>B</i></div>;
  if (gameId === "liar") return <div className="victory-scene mask" aria-hidden="true"><i>◐</i><b>?</b><i>◑</i></div>;
  if (gameId === "uno") return <div className="victory-scene card-fan" aria-hidden="true"><i>7</i><i>↻</i><i>+4</i><i>W</i></div>;
  if (gameId === "yut") return <div className="victory-scene yut-sticks-win" aria-hidden="true"><i /><i /><i /><i /></div>;
  if (gameId === "rummikub") return <div className="victory-scene code-tiles rummikub-win" aria-hidden="true"><i>7</i><i>8</i><b>9</b><i>★</i></div>;
  if (gameId === "word-defense") return <div className="victory-scene defense-win" aria-hidden="true"><i>⌨</i><b>BOOM!</b><i>⚡</i></div>;
  return <div className="victory-scene code-tiles" aria-hidden="true"><i>2</i><i>4</i><b>?</b><i>9</i></div>;
}

function playerColor(index: number) {
  return ["#38bdf8", "#fb7185", "#a3e635", "#c084fc", "#f97316", "#22c55e", "#2563eb", "#f43f5e", "#facc15", "#94a3b8"][index % 10];
}

function Gomoku({ game, playerId, disabled, onAction }: GameViewProps) {
  const board = game.state.board as Array<string | null>;
  const myTurn = game.players[game.turn]?.id === playerId;
  return <div className="board-wrap"><div className="gomoku-board">{board.map((owner, index) => <button key={index} disabled={disabled || !myTurn || Boolean(owner) || game.phase === "finished"} onClick={() => onAction({ type: "PLACE", payload: { index } })} aria-label={`${Math.floor(index / 15) + 1}행 ${index % 15 + 1}열`}>{owner && <i style={{ background: owner === game.players[0].id ? "#111827" : "#f8fafc" }} />}</button>)}</div></div>;
}

const GO_STAR_POINTS = new Set([60, 66, 72, 174, 180, 186, 288, 294, 300]);

function GoBoard({ game, playerId, disabled, onAction }: GameViewProps) {
  const board = game.state.board as Array<string | null>;
  const black = game.players[0];
  const white = game.players[1];
  const myTurn = game.players[game.turn]?.id === playerId;
  const scoring = game.state.mode === "scoring";
  const dead = new Set<number>((game.state.deadStones ?? []) as number[]);
  const confirmations = (game.state.scoreConfirmations ?? []) as string[];
  const lastMoveIndex = game.state.lastMove?.type === "place" ? Number(game.state.lastMove.index) : -1;
  const finalScore = game.state.finalScore as { black: number; white: number; komi: number } | null;

  return (
    <div className="go-game">
      <div className="go-player-strip">
        <div className={game.turn === 0 && !scoring ? "active" : ""}><i className="black" /><span><b>{black?.name}</b><small>흑 · 잡은 돌 {Number(game.state.captures?.[black?.id] ?? 0)}개</small></span></div>
        <div className={game.turn === 1 && !scoring ? "active" : ""}><i className="white" /><span><b>{white?.name}</b><small>백 · 잡은 돌 {Number(game.state.captures?.[white?.id] ?? 0)}개 · 덤 6집반</small></span></div>
      </div>
      <div className="go-board-frame">
        <div className="go-board-grid" role="grid" aria-label="19줄 바둑판">
          {board.map((owner, index) => {
            const row = Math.floor(index / 19) + 1;
            const col = index % 19 + 1;
            const isDead = dead.has(index);
            return (
              <button
                key={index}
                className={`${lastMoveIndex === index ? "last-move" : ""} ${isDead ? "dead" : ""}`}
                disabled={disabled || game.phase === "finished" || (!scoring && (!myTurn || Boolean(owner))) || (scoring && !owner)}
                onClick={() => onAction({ type: scoring ? "TOGGLE_DEAD" : "PLACE", payload: { index } })}
                aria-label={`${row}행 ${col}열${owner ? ` ${owner === black?.id ? "흑돌" : "백돌"}${isDead ? " 죽은 돌 표시" : ""}` : " 빈 교차점"}`}
              >
                {!owner && GO_STAR_POINTS.has(index) && <span className="go-star" aria-hidden="true" />}
                {owner && <span className={`go-stone ${owner === black?.id ? "black" : "white"}`} aria-hidden="true"><i /></span>}
              </button>
            );
          })}
        </div>
      </div>
      {scoring ? (
        <div className="go-scoring-panel">
          <div><span className="eyebrow">SCORING</span><strong>죽은 돌을 눌러 표시하세요</strong><small>양쪽이 같은 표시를 확인해야 계가가 끝납니다. 의견이 다르면 계속 둘 수 있어요.</small></div>
          <div className="go-score-actions">
            <button className="secondary-button" onClick={() => onAction({ type: "RESUME_PLAY" })}>계속 두기</button>
            <button className="primary-button" disabled={confirmations.includes(playerId)} onClick={() => onAction({ type: "CONFIRM_SCORE" })}>{confirmations.includes(playerId) ? "확인 완료" : `계가 확인 (${confirmations.length}/2)`}</button>
          </div>
        </div>
      ) : (
        <div className="go-controls">
          <div><strong>{disabled ? "관전 중" : myTurn ? "내 차례" : "상대 차례"}</strong><small>마지막 수는 파란 점으로 표시됩니다.</small></div>
          <button className="go-pass" disabled={disabled || !myTurn || game.phase === "finished"} onClick={() => onAction({ type: "PASS" })}>넘기기</button>
          <button className="go-resign" disabled={disabled || game.phase === "finished"} onClick={() => onAction({ type: "RESIGN" })}>기권</button>
        </div>
      )}
      {finalScore && <div className="go-final-score"><span>최종 계가</span><b>흑 {finalScore.black}집</b><b>백 {finalScore.white}집 <small>(덤 {finalScore.komi})</small></b></div>}
      <p className="go-help">한국기원 규칙 · 19줄 · 흑 선착 · 백 덤 6집반 · 패·자충수·빅·동형반복 적용</p>
    </div>
  );
}

function ConnectFour({ game, playerId, disabled, onAction }: GameViewProps) {
  const board = game.state.board as Array<string | null>;
  const myTurn = game.players[game.turn]?.id === playerId;
  return <div className="connect-wrap"><div className="drop-buttons">{Array.from({ length: 7 }, (_, col) => <button key={col} disabled={disabled || !myTurn || game.phase === "finished"} onClick={() => onAction({ type: "DROP", payload: { col } })}>↓</button>)}</div><div className="connect-board">{board.map((owner, index) => <span key={index}><i style={owner ? { background: playerColor(game.players.findIndex((p) => p.id === owner)) } : undefined} /></span>)}</div></div>;
}

const PIECES: Record<string, string> = {
  wK: "♔", wQ: "♕", wR: "♖", wB: "♗", wN: "♘", wP: "♙",
  bK: "♚", bQ: "♛", bR: "♜", bB: "♝", bN: "♞", bP: "♟",
};

const CHESS_PIECE_NAMES: Record<string, string> = {
  K: "킹", Q: "퀸", R: "룩", B: "비숍", N: "나이트", P: "폰",
};

const CHESS_PROMOTIONS = [
  { value: "q", piece: "Q", name: "퀸" },
  { value: "r", piece: "R", name: "룩" },
  { value: "b", piece: "B", name: "비숍" },
  { value: "n", piece: "N", name: "나이트" },
] as const;

function chessCoordinate(index: number) {
  return `${String.fromCharCode(97 + (index % 8))}${8 - Math.floor(index / 8)}`;
}

function Chess({ game, playerId, disabled, onAction }: GameViewProps) {
  const [selection, setSelection] = useState<{ index: number; turn: number } | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: number; to: number; turn: number } | null>(null);
  const board = game.state.board as Array<string | null>;
  const myTurn = game.players[game.turn]?.id === playerId;
  const viewerIndex = game.players.findIndex((item) => item.id === playerId);
  const myColor = viewerIndex === 1 ? "b" : "w";
  const blackView = viewerIndex === 1;
  const topPlayerIndex = blackView ? 0 : 1;
  const bottomPlayerIndex = blackView ? 1 : 0;
  const topPlayer = game.players[topPlayerIndex];
  const bottomPlayer = game.players[bottomPlayerIndex];
  const lastMove = game.state.lastMove as { from: number; to: number; san?: string; events?: Array<{ type: "castle" | "en-passant" | "promotion" | "check"; label: string }> } | null;
  const selected = selection?.turn === game.turn ? selection.index : null;
  const promotionChoice = pendingPromotion?.turn === game.turn ? pendingPromotion : null;
  const displayIndexes = useMemo(() => getChessViewIndexes(game, playerId), [game, playerId]);
  const legalTargets = useMemo(() => selected === null ? [] : getChessLegalTargets(game, playerId, selected), [game, playerId, selected]);
  const click = (index: number) => {
    if (disabled || !myTurn || game.phase === "finished") return;
    const piece = board[index];
    if (piece?.[0] === myColor) {
      setSelection((current) => current?.index === index ? null : { index, turn: game.turn });
      return;
    }
    if (selected !== null && legalTargets.includes(index)) {
      const selectedPiece = board[selected];
      if (selectedPiece?.[1] === "P" && (index < 8 || index >= 56)) {
        setPendingPromotion({ from: selected, to: index, turn: game.turn });
        setSelection(null);
        return;
      }
      onAction({ type: "MOVE", payload: { from: selected, to: index } });
      setSelection(null);
      return;
    }
    setSelection(null);
  };

  const promote = (promotion: typeof CHESS_PROMOTIONS[number]["value"]) => {
    if (!promotionChoice) return;
    onAction({ type: "MOVE", payload: { from: promotionChoice.from, to: promotionChoice.to, promotion } });
    setPendingPromotion(null);
  };

  const playerBar = (player: typeof topPlayer, playerIndex: number, position: "top" | "bottom") => {
    const color = playerIndex === 0 ? "white" : "black";
    const active = game.phase !== "finished" && game.turn === playerIndex;
    return (
      <div className={`chess-player-bar ${position} ${active ? "active" : ""}`}>
        <span className={`chess-color-token ${color}`} aria-hidden="true">{color === "white" ? "♔" : "♚"}</span>
        <div><strong>{player?.name ?? "플레이어"}</strong><small>{color === "white" ? "백" : "흑"}{player?.id === playerId ? " · 나" : ""}</small></div>
        <span className="chess-player-state">{active ? "두는 중" : game.phase === "finished" ? "종료" : "대기"}</span>
      </div>
    );
  };

  const status = disabled
    ? "관전 중"
    : myTurn
      ? game.state.inCheck ? "체크! 왕을 지켜야 합니다" : "내 차례입니다"
      : "상대가 두는 중입니다";

  return (
    <div className="chess-shell">
      {lastMove?.events && lastMove.events.length > 0 && <div className="chess-event-stack" aria-live="assertive">{lastMove.events.map((event, index) => <strong key={`${lastMove.from}-${lastMove.to}-${event.type}`} className={event.type} style={{ animationDelay: `${index * 0.34}s` }}>{event.label}</strong>)}</div>}
      {promotionChoice && (
        <div className="chess-promotion-picker" role="dialog" aria-modal="true" aria-labelledby="promotion-title">
          <div className="chess-promotion-card">
            <span className="eyebrow">PAWN PROMOTION</span>
            <h3 id="promotion-title">프로모션할 기물을 골라주세요</h3>
            <p>폰 대신 사용할 기물을 하나 선택하세요.</p>
            <div>
              {CHESS_PROMOTIONS.map((choice) => (
                <button key={choice.value} type="button" onClick={() => promote(choice.value)} aria-label={`${choice.name}(으)로 프로모션`}>
                  <span className={`chess-piece ${myColor === "w" ? "white" : "black"}`} aria-hidden="true">{PIECES[`${myColor}${choice.piece}`]}</span>
                  <strong>{choice.name}</strong>
                </button>
              ))}
            </div>
            <button className="promotion-cancel" type="button" onClick={() => setPendingPromotion(null)}>취소</button>
          </div>
        </div>
      )}
      {playerBar(topPlayer, topPlayerIndex, "top")}
      <div className="chess-board-frame">
        <div className="chess-board" role="group" aria-label={`${blackView ? "흑" : "백"} 시점 체스판`}>
          {displayIndexes.map((index, displayPosition) => {
            const piece = board[index];
            const row = Math.floor(index / 8);
            const col = index % 8;
            const displayRow = Math.floor(displayPosition / 8);
            const displayCol = displayPosition % 8;
            const legal = legalTargets.includes(index);
            const squareColor = (row + col) % 2 === 0 ? "light" : "dark";
            const className = [
              "chess-square",
              squareColor,
              selected === index ? "selected" : "",
              legal ? "legal-target" : "",
              legal && piece ? "capture-target" : "",
              lastMove && (lastMove.from === index || lastMove.to === index) ? "last-move" : "",
            ].filter(Boolean).join(" ");
            const coordinate = chessCoordinate(index);
            const pieceName = piece ? `${piece[0] === "w" ? "백" : "흑"} ${CHESS_PIECE_NAMES[piece[1]]}` : "빈 칸";
            return (
              <button
                key={index}
                className={className}
                onClick={() => click(index)}
                disabled={disabled || !myTurn || game.phase === "finished"}
                aria-label={`${coordinate} ${pieceName}`}
                aria-pressed={selected === index}
              >
                {displayCol === 0 && <span className="chess-rank-label" aria-hidden="true">{8 - row}</span>}
                {displayRow === 7 && <span className="chess-file-label" aria-hidden="true">{String.fromCharCode(97 + col)}</span>}
                {piece && <span className={`chess-piece ${piece[0] === "w" ? "white" : "black"}`} aria-hidden="true">{PIECES[piece]}</span>}
              </button>
            );
          })}
        </div>
      </div>
      {playerBar(bottomPlayer, bottomPlayerIndex, "bottom")}
      <div className={`chess-status ${myTurn ? "mine" : ""} ${game.state.inCheck ? "check" : ""}`} role="status">
        <span>{status}</span>
        {lastMove?.san && <small>최근 수 {lastMove.san}</small>}
      </div>
      <p className="chess-help">기물을 선택하면 이동 가능한 칸이 표시됩니다 · 체크메이트, 캐슬링, 앙파상, 프로모션 적용</p>
    </div>
  );
}

function WordChain({ game, playerId, disabled, onAction }: GameViewProps) {
  const [word, setWord] = useState("");
  const myTurn = game.players[game.turn]?.id === playerId;
  const eliminated = (game.state.eliminated ?? []) as string[];
  const isEliminated = eliminated.includes(playerId);
  const duration = Number(game.state.turnDurationMs ?? 20_000);
  const secondsLeft = Math.max(0, Math.ceil((Number(game.state.turnEndsAt) - Number(game.state.projectedAt ?? game.state.turnEndsAt)) / 1000));
  const progress = Math.max(0, Math.min(100, (secondsLeft * 1_000 / duration) * 100));
  const submit = () => { if (word.trim()) { onAction({ type: "SUBMIT_WORD", payload: { word } }); setWord(""); } };
  const placeholder = isEliminated ? "시간 초과로 탈락했습니다" : myTurn ? "단어 입력" : "상대 차례를 기다리는 중";
  return <div className="word-game"><div className={`word-turn-timer ${secondsLeft <= 5 ? "urgent" : ""}`}><div><span>남은 시간</span><b>{secondsLeft}초</b></div><i><span style={{ width: `${progress}%` }} /></i></div><div className="word-orbit"><span className="needed-letter">{game.state.lastSyllable || "시작"}</span><p>{game.state.lastSyllable ? `'${game.state.lastSyllable}'(으)로 시작하는 단어 · 두음법칙 적용` : "첫 단어를 입력하세요"}</p></div>{eliminated.length > 0 && <div className="word-eliminated">{eliminated.map((id) => <span key={id}>{game.players.find((player) => player.id === id)?.name ?? "퇴장한 플레이어"} 탈락</span>)}</div>}<div className="word-history">{game.state.words.length ? game.state.words.map((item: { word: string }, index: number) => <span key={`${item.word}-${index}`}>{item.word}</span>) : <small>아직 나온 단어가 없어요.</small>}</div><form className="game-input" onSubmit={(event) => { event.preventDefault(); submit(); }}><input value={word} onChange={(event) => setWord(event.target.value)} disabled={disabled || !myTurn || isEliminated || game.phase === "finished"} placeholder={placeholder} /><button disabled={disabled || !myTurn || isEliminated}>제출</button></form></div>;
}

function Drawing({ game, playerId, disabled, onAction }: GameViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeStroke = useRef<Array<{ x: number; y: number }>>([]);
  const [guess, setGuess] = useState("");
  const isDrawer = game.players[game.state.drawerIndex]?.id === playerId;
  const revealingAnswer = Boolean(game.state.answerRevealUntil);
  const secondsLeft = game.state.roundEndsAt ? Math.max(0, Math.ceil((Number(game.state.roundEndsAt) - Number(game.state.projectedAt ?? game.state.roundEndsAt)) / 1000)) : null;
  const drawAll = game.state.strokes as Array<{ points: Array<{ x: number; y: number }>; color?: string; width?: number }>;
  const strokeSignature = useMemo(() => JSON.stringify(drawAll), [drawAll]);
  const paintedSignature = useRef("");
  useEffect(() => {
    if (paintedSignature.current === strokeSignature) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fffdf8"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const stroke of drawAll) paintStroke(ctx, stroke.points, stroke.color, stroke.width);
    paintedSignature.current = strokeSignature;
  }, [drawAll, strokeSignature]);
  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * event.currentTarget.width, y: ((event.clientY - rect.top) / rect.height) * event.currentTarget.height };
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isDrawer || disabled || revealingAnswer || !game.state.prompt || !activeStroke.current.length) return;
    const next = point(event); activeStroke.current.push(next);
    const ctx = event.currentTarget.getContext("2d");
    if (ctx) paintStroke(ctx, activeStroke.current.slice(-2), "#111827", 5);
  };
  const end = () => {
    if (activeStroke.current.length > 1) onAction({ type: "DRAW", payload: { stroke: { points: activeStroke.current, color: "#111827", width: 5 } } });
    activeStroke.current = [];
  };
  if (isDrawer && !game.state.prompt) return <div className="prompt-picker"><span className="eyebrow">그릴 단어를 골라주세요</span><h3>세 가지 중 하나를 선택하세요</h3><div>{game.state.promptChoices.map((prompt: string) => <button key={prompt} onClick={() => onAction({ type: "SELECT_PROMPT", payload: { prompt } })}>{prompt}</button>)}</div><p>단어를 고르면 60초 타이머가 시작됩니다.</p></div>;
  return <div className="drawing-game"><div className="drawing-toolbar"><span>{isDrawer ? `제시어: ${game.state.prompt}` : "그림을 보고 맞혀보세요"}</span><div>{secondsLeft !== null && <b className={secondsLeft <= 10 ? "game-timer urgent" : "game-timer"}>⏱ {secondsLeft}초</b>}{isDrawer && !revealingAnswer && <button onClick={() => onAction({ type: "CLEAR_DRAWING" })}>모두 지우기</button>}</div></div><div className="drawing-canvas-wrap"><canvas ref={canvasRef} width={720} height={420} onPointerDown={(event) => { if (isDrawer && game.state.prompt && !revealingAnswer) { event.currentTarget.setPointerCapture(event.pointerId); activeStroke.current = [point(event)]; } }} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />{revealingAnswer && <div className="drawing-answer-reveal"><span>정답</span><strong>{game.state.revealedAnswer ?? game.state.prompt}</strong><small>5초 뒤 다음 라운드로 넘어갑니다.</small></div>}</div><div className="guess-log">{game.state.guesses.slice(-4).map((item: { playerId: string; guess: string }, index: number) => <span key={index}>{game.players.find((p) => p.id === item.playerId)?.name}: {item.guess}</span>)}</div>{!isDrawer && <form className="game-input" onSubmit={(event) => { event.preventDefault(); if (guess.trim()) { onAction({ type: "GUESS", payload: { guess } }); setGuess(""); } }}><input value={guess} onChange={(event) => setGuess(event.target.value)} disabled={disabled || revealingAnswer || game.phase === "finished"} placeholder={revealingAnswer ? "정답 공개 중" : "정답 입력"} /><button disabled={revealingAnswer}>맞히기</button></form>}</div>;
}

function paintStroke(ctx: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>, color = "#111827", width = 5) {
  if (points.length < 2) return;
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y); points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y)); ctx.stroke();
}

function Chosung({ game, disabled, onAction }: Omit<GameViewProps, "playerId">) {
  const [guess, setGuess] = useState("");
  return <div className="quiz-game"><span className="eyebrow">초성 퀴즈 · 12초마다 힌트 공개</span><div className="chosung-display">{game.state.initial}</div><div className="hint-stack">{game.state.revealed >= 1 && <p><b>분야</b>{game.state.category}</p>}{game.state.revealed >= 2 && <p><b>설명</b>{game.state.clue}</p>}{game.state.revealed >= 3 && <p><b>첫 글자</b>{game.state.firstSyllable}</p>}</div><form className="game-input" onSubmit={(event) => { event.preventDefault(); if (guess.trim()) { onAction({ type: "GUESS", payload: { guess } }); setGuess(""); } }}><input value={guess} onChange={(event) => setGuess(event.target.value)} disabled={disabled || game.phase === "finished"} placeholder="정답 입력" /><button>정답</button></form></div>;
}

function SameAnswer({ game, playerId, disabled, onAction }: GameViewProps) {
  const submittedAnswer = game.state.submissions[playerId] as string | undefined;
  const results = game.state.results as { scorerIds: string[] } | null;
  const options = game.state.options as string[];
  const submittedCount = Object.keys(game.state.submissions).length;
  const finalRound = game.round >= Number(game.state.maxRounds ?? 5);
  return (
    <div className="same-answer">
      <span className="eyebrow">남들과 같은 보기를 고르면 0점 · 혼자 고르면 +1점</span>
      <h3>{game.state.prompt}</h3>
      {results ? (
        <div className="same-answer-score-reveal">
          <span>{game.round}라운드 결과</span>
          <h4>{results.scorerIds.length ? "이번 라운드 득점자" : "이번 라운드 득점자 없음"}</h4>
          {results.scorerIds.length > 0 && <div>{results.scorerIds.map((id) => <strong key={id}>{game.players.find((player) => player.id === id)?.name}<b>+1</b></strong>)}</div>}
          <p>{finalRound ? "잠시 후 최종 결과를 보여드릴게요." : "잠시 후 다음 라운드가 시작됩니다."}</p>
        </div>
      ) : (
        <>
          <p className="same-answer-guide">참가자 {game.players.length}명에 맞춰 보기 {options.length}개가 준비됐어요.</p>
          <div className="same-answer-options">
            {options.map((option, index) => (
              <button
                key={option}
                className={submittedAnswer === option ? "selected" : ""}
                disabled={disabled || Boolean(submittedAnswer) || game.phase === "finished"}
                onClick={() => onAction({ type: "SELECT_ANSWER", payload: { answer: option } })}
              >
                <span>{index + 1}</span><strong>{option}</strong>{submittedAnswer === option && <b>선택 완료</b>}
              </button>
            ))}
          </div>
          <p className="same-answer-progress">{submittedAnswer ? "선택 완료! 다른 참가자를 기다리는 중…" : "나만 고를 것 같은 보기를 선택하세요."}<b>{submittedCount}/{game.players.length}</b></p>
        </>
      )}
    </div>
  );
}

function Liar({ game, playerId, disabled, onAction }: GameViewProps) {
  const [clue, setClue] = useState("");
  const submitted = Boolean(game.state.clues[playerId]);
  return <div className="liar-game"><div className={game.state.isLiar ? "secret-card liar" : "secret-card"}><span>{game.state.isLiar ? "당신은 라이어" : "모두가 받은 단어"}</span><strong>{game.state.isLiar ? "눈치껏 섞이세요" : game.state.word}</strong></div><div className="clue-list">{Object.entries(game.state.clues).map(([id, value]) => <p key={id}><b>{game.players.find((p) => p.id === id)?.name}</b>{String(value)}</p>)}</div>{!submitted && !game.state.revealed && <form className="game-input" onSubmit={(event) => { event.preventDefault(); if (clue.trim()) onAction({ type: "SUBMIT_CLUE", payload: { clue } }); }}><input value={clue} onChange={(event) => setClue(event.target.value)} disabled={disabled} maxLength={40} placeholder="단어를 직접 말하지 않고 설명" /><button>설명 제출</button></form>}{Object.keys(game.state.clues).length === game.players.length && !game.state.revealed && <div className="vote-grid">{game.players.filter((p) => p.id !== playerId).map((player) => <button key={player.id} onClick={() => onAction({ type: "VOTE", payload: { targetId: player.id } })}>{player.name}에게 투표</button>)}</div>}</div>;
}

const UNO_COLOR_NAMES: Record<UnoColor, string> = { red: "빨강", yellow: "노랑", green: "초록", blue: "파랑" };

function unoCardText(card: UnoCard) {
  if (card.kind === "number") return String(card.value);
  return ({ skip: "⊘", reverse: "↻", draw2: "+2", wild: "◇", wild4: "+4" } as Record<string, string>)[card.kind];
}

function UnoCardFace({ card, compact = false, chosenColor, animateColor = false }: {
  card: UnoCard; compact?: boolean; chosenColor?: UnoColor; animateColor?: boolean;
}) {
  const displayColor = card.color ?? chosenColor ?? "wild";
  const isChosenWild = !card.color && Boolean(chosenColor);
  return <span className={`uno-card-face ${displayColor} ${compact ? "compact" : ""} ${isChosenWild ? "chosen-wild" : ""} ${animateColor ? "color-changing" : ""}`}><small>{isChosenWild ? `WILD → ${UNO_COLOR_NAMES[chosenColor!]}` : card.color ? UNO_COLOR_NAMES[card.color] : "WILD"}</small><strong>{unoCardText(card)}</strong>{isChosenWild && <i className="uno-wild-mark" aria-hidden="true">◆</i>}</span>;
}

function Uno({ game, playerId, disabled, onAction }: GameViewProps) {
  const [wildCardId, setWildCardId] = useState<string | null>(null);
  const hands = game.state.hands as Record<string, Array<UnoCard | null>>;
  const myHand = (hands[playerId] ?? []).filter((card): card is UnoCard => Boolean(card));
  const discard = game.state.discardPile as UnoCard[];
  const top = discard.at(-1);
  const myTurn = game.players[game.turn]?.id === playerId;
  const pendingDraw = Number(game.state.pendingDraw ?? 0);
  const pendingDrawKind = game.state.pendingDrawKind as "draw2" | "wild4" | null;
  const canStack = (card: UnoCard) => !pendingDraw || card.kind === "wild4" || (pendingDrawKind === "draw2" && card.kind === "draw2");
  const play = (card: UnoCard) => {
    if (!card.color) setWildCardId(card.id);
    else onAction({ type: "PLAY_CARD", payload: { cardId: card.id } });
  };
  return (
    <div className="uno-game">
      <div className="uno-opponents">
        {game.players.filter((player) => player.id !== playerId).map((player) => (
          <div key={player.id} className={game.players[game.turn]?.id === player.id ? "active" : ""}>
            <b>{player.name}</b>
            {game.phase === "finished" ? (
              <span className="uno-revealed-hand">
                {(hands[player.id] ?? []).filter((card): card is UnoCard => Boolean(card)).map((card) => <UnoCardFace key={card.id} card={card} compact />)}
                {(hands[player.id]?.length ?? 0) === 0 && <em>남은 카드 없음</em>}
              </span>
            ) : <span className="uno-mini-hand">{(hands[player.id] ?? []).slice(0, 12).map((_, index) => <i key={index} />)}</span>}
            <small>{hands[player.id]?.length ?? 0}장</small>
          </div>
        ))}
      </div>
      <div className="uno-table">
        {pendingDraw > 0 && <div className="uno-stack-alert" role="status"><span>누적 공격</span><strong>+{pendingDraw}</strong><small>{pendingDrawKind === "wild4" ? "+4만 이어낼 수 있어요" : "+2 또는 +4로 이어낼 수 있어요"}</small></div>}
        <button className={pendingDraw ? "uno-draw-pile penalty" : "uno-draw-pile"} disabled={disabled || !myTurn || game.phase === "finished"} onClick={() => onAction({ type: "DRAW_CARD" })}><span>{pendingDraw ? "TAKE" : "DRAW"}</span><b>{pendingDraw ? `+${pendingDraw}` : game.state.drawPile.length}</b><small>{pendingDraw ? `${pendingDraw}장 받기` : "한 장 뽑기"}</small></button>
        <div className="uno-discard">{top && <UnoCardFace key={`${top.id}-${game.state.currentColor}`} card={top} chosenColor={!top.color ? game.state.currentColor as UnoColor : undefined} animateColor={!top.color} />}</div>
        <div className={`uno-current-color ${game.state.currentColor}`}><i />{UNO_COLOR_NAMES[game.state.currentColor as UnoColor]}</div>
      </div>
      <div className="uno-my-area">
        <div><b>내 카드</b><small>{myTurn ? pendingDraw ? "누적하거나 카드를 받아야 해요" : "내 차례" : `${game.players[game.turn]?.name}님 차례`}</small></div>
        <div className="uno-hand">{myHand.map((card) => <button key={card.id} className={pendingDraw && canStack(card) ? "stackable" : ""} disabled={disabled || !myTurn || game.phase === "finished" || !canStack(card)} onClick={() => play(card)} aria-label={`${card.color ? UNO_COLOR_NAMES[card.color] : "와일드"} ${unoCardText(card)}`}><UnoCardFace card={card} compact /></button>)}</div>
      </div>
      {wildCardId && <div className="uno-color-picker"><div><b>바꿀 색을 고르세요</b><div>{(Object.keys(UNO_COLOR_NAMES) as UnoColor[]).map((color) => <button key={color} className={color} onClick={() => { onAction({ type: "PLAY_CARD", payload: { cardId: wildCardId, color } }); setWildCardId(null); }}>{UNO_COLOR_NAMES[color]}</button>)}</div><button className="cancel" onClick={() => setWildCardId(null)}>취소</button></div></div>}
    </div>
  );
}

const YUT_COORDS = [
  [90, 90], [74, 90], [58, 90], [42, 90], [26, 90], [10, 90],
  [10, 74], [10, 58], [10, 42], [10, 26], [10, 10],
  [26, 10], [42, 10], [58, 10], [74, 10], [90, 10],
  [90, 26], [90, 42], [90, 58], [90, 74],
] as const;

function Yut({ game, playerId, disabled, onAction }: GameViewProps) {
  const [selectedMove, setSelectedMove] = useState<number | null>(null);
  const pieces = game.state.pieces as Record<string, number[]>;
  const pendingMoves = game.state.pendingMoves as number[];
  const myTurn = game.players[game.turn]?.id === playerId;
  const usableMove = pendingMoves.length === 1 ? 0 : selectedMove;
  const movePiece = (pieceIndex: number) => {
    if (usableMove === null || usableMove >= pendingMoves.length) return;
    onAction({ type: "MOVE_PIECE", payload: { pieceIndex, moveIndex: usableMove } });
    setSelectedMove(null);
  };
  return (
    <div className="yut-game">
      <div className="yut-board" aria-label="윷놀이 판">
        <i className="yut-line horizontal" /><i className="yut-line vertical" /><i className="yut-line diagonal-a" /><i className="yut-line diagonal-b" />
        {YUT_COORDS.map(([left, top], position) => {
          const occupants = game.players.flatMap((player, playerIndex) => (pieces[player.id] ?? []).map((value, pieceIndex) => ({ value, pieceIndex, player, playerIndex }))).filter((piece) => piece.value === position);
          const myPiece = occupants.find((piece) => piece.player.id === playerId);
          return <button key={position} className="yut-node" style={{ left: `${left}%`, top: `${top}%` }} disabled={disabled || !myTurn || usableMove === null || !myPiece} onClick={() => myPiece && movePiece(myPiece.pieceIndex)} aria-label={`${position + 1}번 자리`}>{occupants.map((piece) => <i key={`${piece.player.id}-${piece.pieceIndex}`} style={{ background: playerColor(piece.playerIndex) }} />)}</button>;
        })}
        <span className="yut-center">윷</span>
      </div>
      <div className="yut-controls">
        <div className="yut-sticks">{game.state.lastThrow ? game.state.lastThrow.sticks.map((flat: boolean, index: number) => <i key={index} className={flat ? "flat" : "round"}>{flat ? "●" : ""}</i>) : Array.from({ length: 4 }, (_, index) => <i key={index} />)}</div>
        <button className="primary-yut" disabled={disabled || !myTurn || !game.state.canThrow || game.phase === "finished"} onClick={() => onAction({ type: "THROW" })}>윷 던지기</button>
        <div className="yut-moves"><span>남은 이동</span>{pendingMoves.length ? pendingMoves.map((move, index) => <button key={`${move}-${index}`} className={usableMove === index ? "selected" : ""} onClick={() => setSelectedMove(index)}>{["", "도", "개", "걸", "윷", "모"][move]} · {move}칸</button>) : <small>윷을 던져주세요</small>}</div>
        <div className="yut-teams">{game.players.map((player, index) => { const values = pieces[player.id] ?? []; return <div key={player.id} className={player.id === playerId ? "mine" : ""}><b><i style={{ background: playerColor(index) }} />{player.name}</b><span>대기 {values.filter((value) => value < 0).length} · 완주 {values.filter((value) => value >= 20).length}</span>{player.id === playerId && <div className="yut-home-pieces">{values.map((value, pieceIndex) => value < 0 && <button key={pieceIndex} disabled={disabled || !myTurn || usableMove === null} onClick={() => movePiece(pieceIndex)} style={{ background: playerColor(index) }} aria-label={`대기 중인 ${pieceIndex + 1}번 말`} />)}</div>}</div>; })}</div>
      </div>
    </div>
  );
}

function DavinciTileFace({ tile, selectable = false }: { tile: DavinciTile; selectable?: boolean }) {
  return <span className={`davinci-tile-face ${tile.color} ${tile.isJoker ? "joker" : ""} ${tile.revealed ? "revealed" : ""} ${selectable ? "selectable" : ""}`}><small>{tile.color === "black" ? "B" : "W"}</small><strong>{tile.isJoker ? "—" : tile.number ?? "?"}</strong>{tile.revealed && <i>공개</i>}</span>;
}

function DavinciCode({ game, playerId, disabled, onAction }: GameViewProps) {
  const [target, setTarget] = useState<{ playerId: string; tileId: string } | null>(null);
  const hands = game.state.hands as Record<string, DavinciTile[]>;
  const myTurn = game.players[game.turn]?.id === playerId;
  const unplacedJokers = (game.state.unplacedJokers ?? {}) as Record<string, string[]>;
  const myUnplacedJokerId = unplacedJokers[playerId]?.[0] ?? null;
  const hasPendingJoker = Object.values(unplacedJokers).some((tileIds) => tileIds.length > 0);
  const myUnplacedJoker = (hands[playerId] ?? []).find((tile) => tile.id === myUnplacedJokerId) ?? null;
  const placementHand = (hands[playerId] ?? []).filter((tile) => tile.id !== myUnplacedJokerId);
  const canGuess = myTurn && game.state.hasDrawn && !hasPendingJoker && game.phase === "playing";
  const opponents = game.players.filter((player) => player.id !== playerId);
  const guess = (number: number) => {
    if (!target) return;
    onAction({ type: "GUESS_TILE", payload: { targetPlayerId: target.playerId, tileId: target.tileId, number } });
    setTarget(null);
  };
  return (
    <div className="davinci-game">
      <div className="davinci-opponents">{opponents.map((player) => <section key={player.id} className={game.players[game.turn]?.id === player.id ? "active" : ""}><header><b>{player.name}</b><span>{game.phase === "finished" ? "모든 패 공개" : `${(hands[player.id] ?? []).filter((tile) => tile.revealed).length}/${hands[player.id]?.length ?? 0} 공개`}</span></header><div>{(hands[player.id] ?? []).map((tile) => <button key={tile.id} disabled={disabled || !canGuess || tile.revealed} className={target?.tileId === tile.id ? "selected" : ""} onClick={() => setTarget({ playerId: player.id, tileId: tile.id })}><DavinciTileFace tile={tile} selectable={canGuess && !tile.revealed} /></button>)}</div></section>)}</div>
      <div className="davinci-center"><div className="davinci-deck"><span>CODE</span><b>{game.state.deck.length}</b><small>남은 타일</small></div><div className="davinci-actions"><button disabled={disabled || !myTurn || game.state.hasDrawn || hasPendingJoker || game.phase === "finished"} onClick={() => onAction({ type: "DRAW_TILE" })}>타일 뽑기</button><button className="stop" disabled={disabled || !myTurn || !game.state.hasDrawn || !game.state.hasGuessed || hasPendingJoker || game.phase === "finished"} onClick={() => onAction({ type: "END_TURN" })}>추리 멈추기</button></div></div>
      <section className="davinci-mine"><header><b>내 암호</b><span>같은 숫자는 검정이 먼저 · 조커는 원하는 위치에 한 번만 배치</span></header><div>{(hands[playerId] ?? []).map((tile) => <DavinciTileFace key={tile.id} tile={tile} />)}</div></section>
      {target && <div className="davinci-picker"><div><b>이 타일은 무엇일까요?</b><div>{Array.from({ length: 12 }, (_, number) => <button key={number} onClick={() => guess(number)}>{number}</button>)}<button className="joker-guess" onClick={() => guess(-1)}>— 조커</button></div><button className="cancel" onClick={() => setTarget(null)}>취소</button></div></div>}
      {myUnplacedJoker && <div className="davinci-picker davinci-joker-placement"><div><b>{myUnplacedJoker.color === "black" ? "검은색" : "흰색"} 조커를 어디에 놓을까요?</b><p>한 번 놓은 조커는 다시 옮길 수 없습니다.</p><div>{Array.from({ length: placementHand.length + 1 }, (_, position) => <button key={position} onClick={() => onAction({ type: "PLACE_JOKER", payload: { tileId: myUnplacedJoker.id, position } })}>{position === 0 ? "맨 앞" : position === placementHand.length ? "맨 뒤" : `${position}번 뒤`}</button>)}</div></div></div>}
    </div>
  );
}
