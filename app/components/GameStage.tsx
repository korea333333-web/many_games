"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { getChessLegalTargets, getChessViewIndexes, reduceGame, type DavinciTile, type GameCommand, type GameEnvelope, type UnoCard, type UnoColor } from "@/lib/games/engine";
import { GAME_BY_ID, type GameId } from "@/lib/games/catalog";

type Props = {
  game: GameEnvelope;
  revision: number;
  playerId: string;
  viewerRole: string;
  onAction: (command: Omit<GameCommand, "playerId">) => Promise<unknown>;
};

type GameViewProps = Pick<Props, "game" | "playerId" | "onAction"> & { disabled: boolean };

const INSTANT_GAMES = new Set<GameId>(["gomoku", "connect-four", "chess"]);

export function GameStage({ game, revision, playerId, viewerRole, onAction }: Props) {
  const [optimistic, setOptimistic] = useState<{ revision: number; game: GameEnvelope } | null>(null);
  const shownGame = optimistic?.revision === revision ? optimistic.game : game;
  const info = GAME_BY_ID[shownGame.gameId];
  const player = shownGame.players.find((item) => item.id === playerId);
  const spectator = viewerRole === "spectator" || !player;
  const winners = shownGame.players.filter((item) => shownGame.winnerIds.includes(item.id));
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
      </div>
      {shownGame.feedback && <AnswerFeedback game={shownGame} playerId={playerId} />}
      {shownGame.phase === "finished" && <VictoryOverlay gameId={shownGame.gameId} winners={winners.map((item) => item.name)} message={shownGame.message} />}
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
};

function VictoryOverlay({ gameId, winners, message }: { gameId: GameId; winners: string[]; message: string }) {
  const title = winners.length ? `${winners.join(", ")} 승리!` : "무승부!";
  const theme = VICTORY_THEMES[gameId];
  return (
    <div className={`victory-overlay victory-${gameId}`} role="status" aria-live="assertive">
      <div className="victory-particles" aria-hidden="true">{Array.from({ length: 16 }, (_, index) => <i key={index} />)}</div>
      <div className={`victory-card theme-${gameId}`}>
        <VictoryScene gameId={gameId} />
        <span className="victory-trophy" aria-hidden="true">{winners.length ? theme.icon : "◆"}</span>
        <span className="eyebrow">{winners.length ? theme.kicker : "DRAW GAME"}</span>
        <h2>{title}</h2>
        <p>{message}</p>
        <small>잠시 후 같은 방의 대기 화면으로 돌아갑니다.</small>
      </div>
    </div>
  );
}

function VictoryScene({ gameId }: { gameId: GameId }) {
  if (gameId === "gomoku") return <div className="victory-scene stones" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div>;
  if (gameId === "connect-four") return <div className="victory-scene discs" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <i key={index} />)}</div>;
  if (gameId === "chess") return <div className="victory-scene chess-mate" aria-hidden="true"><i>♔</i><b>CHECKMATE</b><i>♚</i></div>;
  if (gameId === "word-chain") return <div className="victory-scene word-ribbon" aria-hidden="true"><i>끝</i><i>말</i><i>잇</i><i>기</i></div>;
  if (gameId === "drawing") return <div className="victory-scene paint" aria-hidden="true"><i /><i /><i /><b>✎</b></div>;
  if (gameId === "chosung") return <div className="victory-scene consonants" aria-hidden="true"><i>ㅊ</i><i>ㅅ</i><i>ㅋ</i><i>ㅈ</i></div>;
  if (gameId === "same-answer") return <div className="victory-scene unique-answer" aria-hidden="true"><i>A</i><i>A</i><b>C</b><i>B</i><i>B</i></div>;
  if (gameId === "liar") return <div className="victory-scene mask" aria-hidden="true"><i>◐</i><b>?</b><i>◑</i></div>;
  if (gameId === "uno") return <div className="victory-scene card-fan" aria-hidden="true"><i>7</i><i>↻</i><i>+4</i><i>W</i></div>;
  if (gameId === "yut") return <div className="victory-scene yut-sticks-win" aria-hidden="true"><i /><i /><i /><i /></div>;
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

function chessCoordinate(index: number) {
  return `${String.fromCharCode(97 + (index % 8))}${8 - Math.floor(index / 8)}`;
}

function Chess({ game, playerId, disabled, onAction }: GameViewProps) {
  const [selection, setSelection] = useState<{ index: number; turn: number } | null>(null);
  const board = game.state.board as Array<string | null>;
  const myTurn = game.players[game.turn]?.id === playerId;
  const viewerIndex = game.players.findIndex((item) => item.id === playerId);
  const myColor = viewerIndex === 1 ? "b" : "w";
  const blackView = viewerIndex === 1;
  const topPlayerIndex = blackView ? 0 : 1;
  const bottomPlayerIndex = blackView ? 1 : 0;
  const topPlayer = game.players[topPlayerIndex];
  const bottomPlayer = game.players[bottomPlayerIndex];
  const lastMove = game.state.lastMove as { from: number; to: number; san?: string; events?: Array<{ type: "castle" | "en-passant" | "check"; label: string }> } | null;
  const selected = selection?.turn === game.turn ? selection.index : null;
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
      onAction({ type: "MOVE", payload: { from: selected, to: index } });
      setSelection(null);
      return;
    }
    setSelection(null);
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
      <p className="chess-help">기물을 선택하면 이동 가능한 칸이 표시됩니다 · 체크메이트, 캐슬링, 앙파상 적용</p>
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

function UnoCardFace({ card, compact = false }: { card: UnoCard; compact?: boolean }) {
  const color = card.color ?? "wild";
  return <span className={`uno-card-face ${color} ${compact ? "compact" : ""}`}><small>{card.color ? UNO_COLOR_NAMES[card.color] : "WILD"}</small><strong>{unoCardText(card)}</strong></span>;
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
            <b>{player.name}</b><span className="uno-mini-hand">{(hands[player.id] ?? []).slice(0, 12).map((_, index) => <i key={index} />)}</span><small>{hands[player.id]?.length ?? 0}장</small>
          </div>
        ))}
      </div>
      <div className="uno-table">
        {pendingDraw > 0 && <div className="uno-stack-alert" role="status"><span>누적 공격</span><strong>+{pendingDraw}</strong><small>{pendingDrawKind === "wild4" ? "+4만 이어낼 수 있어요" : "+2 또는 +4로 이어낼 수 있어요"}</small></div>}
        <button className={pendingDraw ? "uno-draw-pile penalty" : "uno-draw-pile"} disabled={disabled || !myTurn || game.phase === "finished"} onClick={() => onAction({ type: "DRAW_CARD" })}><span>{pendingDraw ? "TAKE" : "DRAW"}</span><b>{pendingDraw ? `+${pendingDraw}` : game.state.drawPile.length}</b><small>{pendingDraw ? `${pendingDraw}장 받기` : "한 장 뽑기"}</small></button>
        <div className="uno-discard">{top && <UnoCardFace card={top} />}</div>
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
  return <span className={`davinci-tile-face ${tile.color} ${tile.revealed ? "revealed" : ""} ${selectable ? "selectable" : ""}`}><small>{tile.color === "black" ? "B" : "W"}</small><strong>{tile.number ?? "?"}</strong>{tile.revealed && <i>공개</i>}</span>;
}

function DavinciCode({ game, playerId, disabled, onAction }: GameViewProps) {
  const [target, setTarget] = useState<{ playerId: string; tileId: string } | null>(null);
  const hands = game.state.hands as Record<string, DavinciTile[]>;
  const myTurn = game.players[game.turn]?.id === playerId;
  const canGuess = myTurn && game.state.hasDrawn && game.phase === "playing";
  const opponents = game.players.filter((player) => player.id !== playerId);
  const guess = (number: number) => {
    if (!target) return;
    onAction({ type: "GUESS_TILE", payload: { targetPlayerId: target.playerId, tileId: target.tileId, number } });
    setTarget(null);
  };
  return (
    <div className="davinci-game">
      <div className="davinci-opponents">{opponents.map((player) => <section key={player.id} className={game.players[game.turn]?.id === player.id ? "active" : ""}><header><b>{player.name}</b><span>{(hands[player.id] ?? []).filter((tile) => tile.revealed).length}/{hands[player.id]?.length ?? 0} 공개</span></header><div>{(hands[player.id] ?? []).map((tile) => <button key={tile.id} disabled={disabled || !canGuess || tile.revealed} className={target?.tileId === tile.id ? "selected" : ""} onClick={() => setTarget({ playerId: player.id, tileId: tile.id })}><DavinciTileFace tile={tile} selectable={canGuess && !tile.revealed} /></button>)}</div></section>)}</div>
      <div className="davinci-center"><div className="davinci-deck"><span>CODE</span><b>{game.state.deck.length}</b><small>남은 타일</small></div><div className="davinci-actions"><button disabled={disabled || !myTurn || game.state.hasDrawn || game.phase === "finished"} onClick={() => onAction({ type: "DRAW_TILE" })}>타일 뽑기</button><button className="stop" disabled={disabled || !myTurn || !game.state.hasDrawn || game.phase === "finished"} onClick={() => onAction({ type: "END_TURN" })}>추리 멈추기</button></div></div>
      <section className="davinci-mine"><header><b>내 암호</b><span>검정이 같은 숫자의 흰색보다 앞에 놓입니다.</span></header><div>{(hands[playerId] ?? []).map((tile) => <DavinciTileFace key={tile.id} tile={tile} />)}</div></section>
      {target && <div className="davinci-picker"><div><b>이 타일의 숫자는?</b><div>{Array.from({ length: 12 }, (_, number) => <button key={number} onClick={() => guess(number)}>{number}</button>)}</div><button className="cancel" onClick={() => setTarget(null)}>취소</button></div></div>}
    </div>
  );
}
