"use client";

import { useEffect, useState } from "react";
import { GAME_BY_ID, GAME_CATALOG, type GameId } from "@/lib/games/catalog";
import { GAME_RULES } from "@/lib/games/rules";

type Props = {
  open: boolean;
  initialGameId?: GameId;
  onClose: () => void;
};

export function GameRulebook({ open, initialGameId = "gomoku", onClose }: Props) {
  const [selectedId, setSelectedId] = useState<GameId>(initialGameId);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose]);

  if (!open) return null;
  const game = GAME_BY_ID[selectedId];
  const rules = GAME_RULES[selectedId];

  return (
    <div className="rulebook-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="rulebook" role="dialog" aria-modal="true" aria-labelledby="rulebook-title">
        <header className="rulebook-head">
          <div><span className="eyebrow">HOW TO PLAY</span><h2 id="rulebook-title">게임 사전</h2><p>처음 보는 게임도 그림과 순서대로 빠르게 익혀보세요.</p></div>
          <button onClick={onClose} aria-label="게임 사전 닫기">×</button>
        </header>
        <div className="rulebook-layout">
          <nav className="rulebook-index" aria-label="게임 목록">
            {GAME_CATALOG.map((item) => (
              <button key={item.id} className={selectedId === item.id ? "active" : ""} onClick={() => setSelectedId(item.id)} aria-pressed={selectedId === item.id}>
                <span style={{ background: item.accent }}>{item.icon}</span><div><strong>{item.name}</strong><small>{item.minPlayers === item.maxPlayers ? `${item.minPlayers}명` : `${item.minPlayers}~${item.maxPlayers}명`}</small></div>
              </button>
            ))}
          </nav>
          <article className="rulebook-page" key={selectedId}>
            <div className="rulebook-game-title"><span style={{ background: game.accent }}>{game.icon}</span><div><p>{rules.tagline}</p><h3>{game.name}</h3></div></div>
            <RuleVisual gameId={selectedId} />
            <section className="rule-goal"><span>목표</span><strong>{rules.goal}</strong></section>
            <section className="rule-section"><h4>게임 진행</h4><ol>{rules.flow.map((step) => <li key={step}><i /> <span>{step}</span></li>)}</ol></section>
            <section className="rule-win"><span aria-hidden="true">🏁</span><div><small>승리 조건</small><strong>{rules.win}</strong></div></section>
            <section className="rule-section rule-notes"><h4>알아두기</h4><ul>{rules.notes.map((note) => <li key={note}>{note}</li>)}</ul></section>
          </article>
        </div>
      </section>
    </div>
  );
}

function RuleVisual({ gameId }: { gameId: GameId }) {
  if (gameId === "gomoku") return <figure className="rule-visual gomoku" role="img" aria-label="가로로 이어진 다섯 개의 검은 돌"><div>{Array.from({ length: 25 }, (_, index) => <i key={index} className={Math.floor(index / 5) === 2 ? "stone" : ""} />)}</div><figcaption>돌 5개를 한 줄로</figcaption></figure>;
  if (gameId === "word-chain") return <figure className="rule-visual word-chain" role="img" aria-label="사과에서 과자로 이어지는 끝말잇기"><div><b>사과</b><i>→</i><b>과자</b><i>→</i><b>자동차</b></div><figcaption>끝 글자가 다음 단어의 시작</figcaption></figure>;
  if (gameId === "drawing") return <figure className="rule-visual drawing" role="img" aria-label="그림을 그리고 정답을 맞히는 과정"><div className="mini-canvas"><i /><i /><i /></div><div className="mini-guess"><span>정답?</span><b>고양이!</b></div><figcaption>그림만 보고 빠르게 맞히기</figcaption></figure>;
  if (gameId === "chosung") return <figure className="rule-visual chosung" role="img" aria-label="초성에 힌트가 차례로 추가되는 모습"><div><strong>ㅊ ㅋ</strong><span>분야</span><span>설명</span><span>첫 글자</span></div><figcaption>12초마다 힌트 한 칸 공개</figcaption></figure>;
  if (gameId === "same-answer") return <figure className="rule-visual same-answer" role="img" aria-label="겹치지 않은 C 답만 점수를 얻는 모습"><div><span>A</span><span>A</span><span className="unique">C<small>+1</small></span><span>B</span><span>B</span></div><figcaption>혼자 고른 답만 득점</figcaption></figure>;
  if (gameId === "liar") return <figure className="rule-visual liar" role="img" aria-label="같은 단어를 받은 시민 사이에 물음표 카드를 든 라이어"><div><span>바다</span><span>바다</span><span className="liar-card">?</span><span>바다</span></div><figcaption>단어를 모르는 한 명은 누구?</figcaption></figure>;
  if (gameId === "connect-four") return <figure className="rule-visual connect-four" role="img" aria-label="대각선으로 이어진 네 개의 노란 원판"><div>{Array.from({ length: 28 }, (_, index) => <i key={index} className={[24, 18, 12, 6].includes(index) ? "win" : index > 17 ? "other" : ""} />)}</div><figcaption>원판 4개를 가로·세로·대각선으로</figcaption></figure>;
  if (gameId === "chess") return <figure className="rule-visual chess" role="img" aria-label="킹과 룩이 함께 움직이는 캐슬링과 체크"><div className="chess-demo"><span>♔</span><i>⇢</i><span>♖</span></div><div className="chess-rule-pills"><b>체크!</b><b>캐슬링</b><b>앙파상</b></div><figcaption>특수 수가 나오면 화면에서 바로 알려줘요</figcaption></figure>;
  if (gameId === "uno") return <figure className="rule-visual uno" role="img" aria-label="같은 색과 숫자를 맞추는 우노 카드"><div><span className="red">7</span><span className="red">↻</span><span className="blue">↻</span><span className="wild">W</span></div><figcaption>같은 색 · 숫자 · 기호</figcaption></figure>;
  if (gameId === "yut") return <figure className="rule-visual yut" role="img" aria-label="윷가락 네 개와 이동하는 말"><div className="mini-yut"><i /><i className="flat" /><i /><i className="flat" /></div><div className="mini-yut-path">{Array.from({ length: 7 }, (_, index) => <i key={index} className={index === 3 ? "piece" : ""} />)}</div><figcaption>던진 결과만큼 말을 이동</figcaption></figure>;
  return <figure className="rule-visual davinci" role="img" aria-label="숫자 순서 사이의 숨겨진 타일을 추리"><div><span className="black">2</span><span className="white">4</span><span className="black hidden">?</span><span className="white">9</span></div><figcaption>순서를 보고 숨은 숫자 추리</figcaption></figure>;
}
