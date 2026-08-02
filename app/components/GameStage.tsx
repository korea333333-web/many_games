"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { GameCommand, GameEnvelope } from "@/lib/games/engine";
import { GAME_BY_ID } from "@/lib/games/catalog";

type Props = {
  game: GameEnvelope;
  playerId: string;
  viewerRole: string;
  onAction: (command: Omit<GameCommand, "playerId">) => void;
};

type GameViewProps = Pick<Props, "game" | "playerId" | "onAction"> & { disabled: boolean };

export function GameStage({ game, playerId, viewerRole, onAction }: Props) {
  const info = GAME_BY_ID[game.gameId];
  const player = game.players.find((item) => item.id === playerId);
  const spectator = viewerRole === "spectator" || !player;
  return (
    <div className="game-stage">
      <div className="stage-header">
        <div><span className="eyebrow">{info.name} · {spectator ? "관전 중" : `${game.round}라운드`}</span><h2>{game.message}</h2></div>
        <div className="score-strip">{game.players.map((item, index) => <div key={item.id} className={item.id === playerId ? "current" : ""}><i style={{ background: playerColor(index) }} /> <span>{item.name}</span><b>{item.score}</b></div>)}</div>
      </div>
      <div className="stage-body">
        {game.gameId === "gomoku" && <Gomoku game={game} playerId={playerId} disabled={spectator} onAction={onAction} />}
        {game.gameId === "connect-four" && <ConnectFour game={game} playerId={playerId} disabled={spectator} onAction={onAction} />}
        {game.gameId === "chess" && <Chess game={game} playerId={playerId} disabled={spectator} onAction={onAction} />}
        {game.gameId === "word-chain" && <WordChain game={game} playerId={playerId} disabled={spectator} onAction={onAction} />}
        {game.gameId === "drawing" && <Drawing game={game} playerId={playerId} disabled={spectator} onAction={onAction} />}
        {game.gameId === "chosung" && <Chosung game={game} disabled={spectator} onAction={onAction} />}
        {game.gameId === "same-answer" && <SameAnswer game={game} playerId={playerId} disabled={spectator} onAction={onAction} />}
        {game.gameId === "liar" && <Liar game={game} playerId={playerId} disabled={spectator} onAction={onAction} />}
        {game.gameId === "push-out" && <PushOut game={game} playerId={playerId} disabled={spectator} onAction={onAction} />}
      </div>
      {game.phase === "finished" && !spectator && <button className="primary-button rematch-button" onClick={() => onAction({ type: "REMATCH" })}>다시 하기</button>}
    </div>
  );
}

function playerColor(index: number) {
  return ["#2563eb", "#fb7185", "#a3e635", "#c084fc", "#f97316", "#22c55e", "#38bdf8", "#f43f5e", "#facc15", "#94a3b8"][index % 10];
}

function Gomoku({ game, playerId, disabled, onAction }: GameViewProps) {
  const board = game.state.board as Array<string | null>;
  const myTurn = game.players[game.turn]?.id === playerId;
  return <div className="board-wrap"><div className="gomoku-board">{board.map((owner, index) => <button key={index} disabled={disabled || !myTurn || Boolean(owner) || game.phase === "finished"} onClick={() => onAction({ type: "PLACE", payload: { index } })} aria-label={`${Math.floor(index / 15) + 1}행 ${index % 15 + 1}열`}>{owner && <i style={{ background: owner === game.players[0].id ? "#111827" : "#f8fafc" }} />}</button>)}</div></div>;
}

function ConnectFour({ game, playerId, disabled, onAction }: GameViewProps) {
  const board = game.state.board as Array<string | null>;
  const myTurn = game.players[game.turn]?.id === playerId;
  return <div className="connect-wrap"><div className="drop-buttons">{Array.from({ length: 7 }, (_, col) => <button key={col} disabled={disabled || !myTurn || game.phase === "finished"} onClick={() => onAction({ type: "DROP", payload: { col } })}>↓</button>)}</div><div className="connect-board">{board.map((owner, index) => <span key={index}><i style={owner ? { background: playerColor(game.players.findIndex((p) => p.id === owner)) } : undefined} /></span>)}</div></div>;
}

const PIECES: Record<string, string> = { wK: "♔", wQ: "♕", wR: "♖", wB: "♗", wN: "♘", wP: "♙", bK: "♚", bQ: "♛", bR: "♜", bB: "♝", bN: "♞", bP: "♟" };

function Chess({ game, playerId, disabled, onAction }: GameViewProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const board = game.state.board as Array<string | null>;
  const myTurn = game.players[game.turn]?.id === playerId;
  const click = (index: number) => {
    if (disabled || !myTurn || game.phase === "finished") return;
    if (selected === null) setSelected(index);
    else { onAction({ type: "MOVE", payload: { from: selected, to: index } }); setSelected(null); }
  };
  return <div className="chess-shell"><div className="chess-board">{board.map((piece, index) => <button key={index} className={selected === index ? "selected" : ""} onClick={() => click(index)}>{piece ? PIECES[piece] : ""}</button>)}</div><p>캐주얼 규칙 · 왕을 잡으면 승리 · 폰 승급 지원</p></div>;
}

function WordChain({ game, playerId, disabled, onAction }: GameViewProps) {
  const [word, setWord] = useState("");
  const myTurn = game.players[game.turn]?.id === playerId;
  const submit = () => { if (word.trim()) { onAction({ type: "SUBMIT_WORD", payload: { word } }); setWord(""); } };
  return <div className="word-game"><div className="word-orbit"><span className="needed-letter">{game.state.lastSyllable || "시작"}</span><p>{game.state.lastSyllable ? `'${game.state.lastSyllable}'(으)로 시작하는 단어` : "첫 단어를 입력하세요"}</p></div><div className="word-history">{game.state.words.length ? game.state.words.map((item: any, index: number) => <span key={`${item.word}-${index}`}>{item.word}</span>) : <small>아직 나온 단어가 없어요.</small>}</div><form className="game-input" onSubmit={(event) => { event.preventDefault(); submit(); }}><input value={word} onChange={(event) => setWord(event.target.value)} disabled={disabled || !myTurn || game.phase === "finished"} placeholder={myTurn ? "단어 입력" : "상대 차례를 기다리는 중"} /><button disabled={disabled || !myTurn}>제출</button></form></div>;
}

function Drawing({ game, playerId, disabled, onAction }: GameViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeStroke = useRef<Array<{ x: number; y: number }>>([]);
  const [guess, setGuess] = useState("");
  const [custom, setCustom] = useState("");
  const isDrawer = game.players[game.state.drawerIndex]?.id === playerId;
  const drawAll = useMemo(() => game.state.strokes as Array<{ points: Array<{ x: number; y: number }>; color?: string; width?: number }>, [game.state.strokes]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fffdf8"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const stroke of drawAll) paintStroke(ctx, stroke.points, stroke.color, stroke.width);
  }, [drawAll]);
  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * event.currentTarget.width, y: ((event.clientY - rect.top) / rect.height) * event.currentTarget.height };
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isDrawer || disabled || !game.state.prompt || !activeStroke.current.length) return;
    const next = point(event); activeStroke.current.push(next);
    const ctx = event.currentTarget.getContext("2d");
    if (ctx) paintStroke(ctx, activeStroke.current.slice(-2), "#111827", 5);
  };
  const end = () => {
    if (activeStroke.current.length > 1) onAction({ type: "DRAW", payload: { stroke: { points: activeStroke.current, color: "#111827", width: 5 } } });
    activeStroke.current = [];
  };
  if (isDrawer && !game.state.prompt) return <div className="prompt-picker"><span className="eyebrow">그릴 단어를 골라주세요</span><h3>세 가지 중 하나를 선택하세요</h3><div>{game.state.promptChoices.map((prompt: string) => <button key={prompt} onClick={() => onAction({ type: "SELECT_PROMPT", payload: { prompt } })}>{prompt}</button>)}</div><p>또는 직접 단어를 정할 수 있어요.</p><form onSubmit={(event) => { event.preventDefault(); custom.trim() && onAction({ type: "SELECT_PROMPT", payload: { custom } }); }}><input value={custom} onChange={(event) => setCustom(event.target.value)} maxLength={20} placeholder="원하는 단어" /><button>선택</button></form></div>;
  return <div className="drawing-game"><div className="drawing-toolbar"><span>{isDrawer ? `제시어: ${game.state.prompt}` : "그림을 보고 맞혀보세요"}</span>{isDrawer && <button onClick={() => onAction({ type: "CLEAR_DRAWING" })}>모두 지우기</button>}</div><canvas ref={canvasRef} width={720} height={420} onPointerDown={(event) => { if (isDrawer && game.state.prompt) { event.currentTarget.setPointerCapture(event.pointerId); activeStroke.current = [point(event)]; } }} onPointerMove={move} onPointerUp={end} onPointerCancel={end} /><div className="guess-log">{game.state.guesses.slice(-4).map((item: any, index: number) => <span key={index}>{game.players.find((p) => p.id === item.playerId)?.name}: {item.guess}</span>)}</div>{!isDrawer && <form className="game-input" onSubmit={(event) => { event.preventDefault(); if (guess.trim()) { onAction({ type: "GUESS", payload: { guess } }); setGuess(""); } }}><input value={guess} onChange={(event) => setGuess(event.target.value)} disabled={disabled} placeholder="정답 입력" /><button>맞히기</button></form>}</div>;
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
  const [answer, setAnswer] = useState("");
  const submitted = Boolean(game.state.submissions[playerId]);
  return <div className="same-answer"><span className="eyebrow">남들과 겹치면 0점</span><h3>{game.state.prompt}</h3>{game.state.results ? <div className="answer-results">{game.state.results.map((result: any) => <div className={result.unique ? "unique" : "duplicate"} key={result.playerId}><strong>{game.players.find((p) => p.id === result.playerId)?.name}</strong><span>{result.value}</span><b>{result.unique ? "+1" : "겹침"}</b></div>)}</div> : <><p>{Object.keys(game.state.submissions).length}/{game.players.length}명이 답을 냈어요.</p><form className="game-input" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) onAction({ type: "SUBMIT_ANSWER", payload: { answer } }); }}><input value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={disabled || submitted} placeholder={submitted ? "제출 완료" : "나만 생각할 것 같은 답"} /><button disabled={submitted}>제출</button></form></>}</div>;
}

function Liar({ game, playerId, disabled, onAction }: GameViewProps) {
  const [clue, setClue] = useState("");
  const submitted = Boolean(game.state.clues[playerId]);
  return <div className="liar-game"><div className={game.state.isLiar ? "secret-card liar" : "secret-card"}><span>{game.state.isLiar ? "당신은 라이어" : "모두가 받은 단어"}</span><strong>{game.state.isLiar ? "눈치껏 섞이세요" : game.state.word}</strong></div><div className="clue-list">{Object.entries(game.state.clues).map(([id, value]) => <p key={id}><b>{game.players.find((p) => p.id === id)?.name}</b>{String(value)}</p>)}</div>{!submitted && !game.state.revealed && <form className="game-input" onSubmit={(event) => { event.preventDefault(); if (clue.trim()) onAction({ type: "SUBMIT_CLUE", payload: { clue } }); }}><input value={clue} onChange={(event) => setClue(event.target.value)} disabled={disabled} maxLength={40} placeholder="단어를 직접 말하지 않고 설명" /><button>설명 제출</button></form>}{Object.keys(game.state.clues).length === game.players.length && !game.state.revealed && <div className="vote-grid">{game.players.filter((p) => p.id !== playerId).map((player) => <button key={player.id} onClick={() => onAction({ type: "VOTE", payload: { targetId: player.id } })}>{player.name}에게 투표</button>)}</div>}</div>;
}

function PushOut({ game, playerId, disabled, onAction }: GameViewProps) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (disabled || game.phase === "finished") return;
      const direction: Record<string, [number, number]> = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] };
      const value = direction[event.key];
      if (value) { event.preventDefault(); onAction({ type: "MOVE", payload: { dx: value[0], dy: value[1] } }); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [disabled, game.phase, onAction]);
  const move = (dx: number, dy: number) => onAction({ type: "MOVE", payload: { dx, dy } });
  return <div className="push-game"><div className="arena">{game.players.map((player, index) => { const pos = game.state.positions[player.id]; return pos?.alive && <div className={player.id === playerId ? "arena-player me" : "arena-player"} key={player.id} style={{ left: `${(pos.x + 1) * 50}%`, top: `${(pos.y + 1) * 50}%`, background: playerColor(index) }}><span>{player.name.slice(0, 2)}</span></div>; })}</div><div className="dpad"><button onClick={() => move(0, -1)}>↑</button><button onClick={() => move(-1, 0)}>←</button><button onClick={() => move(0, 1)}>↓</button><button onClick={() => move(1, 0)}>→</button></div><p>WASD 또는 방향키로 움직이세요. 다른 플레이어와 부딪치면 밀어냅니다.</p></div>;
}
