"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GAME_BY_ID, GAME_CATALOG, type GameId, type GameInfo } from "@/lib/games/catalog";
import type { GameCommand, GameEnvelope } from "@/lib/games/engine";
import { hasUnreadMessage, latestMessageId } from "@/lib/chat/unread";
import { GameStage } from "./GameStage";

type Identity = { id: string; nickname: string };
type RoomListItem = {
  id: string; title: string; gameId: GameId; hostId: string; hostName: string;
  status: "waiting" | "playing"; capacity: number; locked: boolean; memberCount: number; playerCount: number;
  settings: { rounds?: number };
};
type Member = { id: string; name: string; role: "player" | "spectator"; joinedAt: string };
type ActiveRoom = RoomListItem & { members: Member[]; viewerRole: string; game: GameEnvelope | null; revision: number };
type ChatMessage = { id: number; senderId: string; senderName: string; recipientId?: string; recipientName?: string; body: string; createdAt: string };
type Snapshot = {
  rooms: RoomListItem[];
  onlinePlayers: Array<{ id: string; nickname: string; lastSeen: string }>;
  globalMessages: ChatMessage[];
  directMessages: ChatMessage[];
  activeRoom: ActiveRoom | null;
};

const EMPTY_SNAPSHOT: Snapshot = { rooms: [], onlinePlayers: [], globalMessages: [], directMessages: [], activeRoom: null };
const ACTION_LOADING_LABELS: Record<string, string> = {
  createRoom: "새 방을 만들고 있어요",
  joinRoom: "방에 들어가는 중이에요",
  leaveRoom: "로비로 돌아가는 중이에요",
  startGame: "게임을 준비하고 있어요",
  gameAction: "플레이를 반영하고 있어요",
  setNickname: "프로필을 저장하고 있어요",
  sendGlobal: "메시지를 보내고 있어요",
  sendDirect: "메시지를 보내고 있어요",
};

function playerCountLabel(game: Pick<GameInfo, "minPlayers" | "maxPlayers">) {
  return game.minPlayers === game.maxPlayers ? `${game.minPlayers}명` : `${game.minPlayers}~${game.maxPlayers}명`;
}

function newIdentity(): Identity {
  const id = crypto.randomUUID().replaceAll("-", "");
  return { id, nickname: `플레이어${id.slice(-4)}` };
}

export function GamePlatform() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [gameFilter, setGameFilter] = useState<GameId | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "waiting" | "playing" | "locked">("all");
  const [search, setSearch] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [nicknameOpen, setNicknameOpen] = useState(false);
  const [joinTarget, setJoinTarget] = useState<RoomListItem | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("잠시만 기다려 주세요");
  const [hasUnreadChat, setHasUnreadChat] = useState(false);
  const pollInFlight = useRef(false);
  const snapshotRef = useRef<Snapshot>(EMPTY_SNAPSHOT);
  const latestMessageIdRef = useRef<number | null>(null);
  const chatOpenRef = useRef(false);

  useEffect(() => {
    const stored = localStorage.getItem("game-lobby-identity");
    const value = stored ? JSON.parse(stored) as Identity : newIdentity();
    localStorage.setItem("game-lobby-identity", JSON.stringify(value));
    const storedRoom = localStorage.getItem("game-lobby-active-room");
    queueMicrotask(() => {
      setIdentity(value);
      if (storedRoom) setActiveRoomId(storedRoom);
    });
  }, []);

  useEffect(() => {
    if (!identity) return;
    if (activeRoomId) localStorage.setItem("game-lobby-active-room", activeRoomId);
    else localStorage.removeItem("game-lobby-active-room");
  }, [identity, activeRoomId]);

  const applySnapshot = useCallback((data: Snapshot, expectedRoomId: string | null) => {
    if (!identity) return;
    const previous = snapshotRef.current;
    const allMessages = [...data.globalMessages, ...data.directMessages];
    const newestMessageId = latestMessageId(allMessages);
    if (!chatOpenRef.current && hasUnreadMessage(allMessages, latestMessageIdRef.current, identity.id)) setHasUnreadChat(true);
    latestMessageIdRef.current = Math.max(latestMessageIdRef.current ?? 0, newestMessageId);
    if (previous.activeRoom?.game && !data.activeRoom?.game && previous.activeRoom.game.phase !== "finished") {
      setNotice("필요한 인원이 나가 게임이 중단되었습니다. 대기방으로 돌아왔습니다.");
    }
    snapshotRef.current = data;
    setSnapshot(data);
    if (expectedRoomId && !data.activeRoom) setActiveRoomId(null);
  }, [identity]);

  const refresh = useCallback(async (roomIdOverride?: string | null) => {
    if (!identity) return;
    const roomId = roomIdOverride === undefined ? activeRoomId : roomIdOverride;
    const params = new URLSearchParams({ playerId: identity.id, nickname: identity.nickname });
    if (roomId) params.set("roomId", roomId);
    try {
      const response = await fetch(`/api/sync?${params}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "서버 연결 실패");
      applySnapshot(data as Snapshot, roomId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "서버 연결 실패");
    }
  }, [identity, activeRoomId, applySnapshot]);

  useEffect(() => {
    if (!identity) return;
    const poll = async () => {
      if (document.hidden || pollInFlight.current) return;
      pollInFlight.current = true;
      try { await refresh(); }
      finally { pollInFlight.current = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), activeRoomId ? 300 : 1600);
    return () => window.clearInterval(timer);
  }, [identity, activeRoomId, refresh]);

  const command = useCallback(async (type: string, payload: Record<string, unknown> = {}) => {
    if (!identity) return null;
    setLoading(true);
    setLoadingLabel(ACTION_LOADING_LABELS[type] ?? "요청을 처리하고 있어요");
    setNotice("");
    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, playerId: identity.id, nickname: identity.nickname, roomId: activeRoomId, payload }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "요청 실패");
      if (data.player?.nickname && data.player.nickname !== identity.nickname) {
        const next = { ...identity, nickname: data.player.nickname };
        localStorage.setItem("game-lobby-identity", JSON.stringify(next));
        setIdentity(next);
      }
      const nextRoomId = type === "leaveRoom"
        ? null
        : (type === "createRoom" || type === "joinRoom") && data.roomId
          ? String(data.roomId)
          : activeRoomId;
      if (data.snapshot) applySnapshot(data.snapshot as Snapshot, nextRoomId);
      else await refresh(nextRoomId);
      if (nextRoomId !== activeRoomId) setActiveRoomId(nextRoomId);
      return data;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "요청 실패");
      return null;
    } finally {
      setLoading(false);
    }
  }, [identity, activeRoomId, applySnapshot, refresh]);

  const rooms = useMemo(() => snapshot.rooms.filter((room) => {
    if (gameFilter !== "all" && room.gameId !== gameFilter) return false;
    if (statusFilter === "locked" && !room.locked) return false;
    if ((statusFilter === "waiting" || statusFilter === "playing") && room.status !== statusFilter) return false;
    const query = search.trim().toLowerCase();
    return !query || room.title.toLowerCase().includes(query) || GAME_BY_ID[room.gameId].name.includes(query);
  }), [snapshot.rooms, gameFilter, statusFilter, search]);

  const openChat = useCallback(() => {
    chatOpenRef.current = true;
    setHasUnreadChat(false);
    setChatOpen(true);
  }, []);

  const closeChat = useCallback(() => {
    chatOpenRef.current = false;
    setChatOpen(false);
  }, []);

  const saveNickname = async (nickname: string) => {
    const next = { ...identity!, nickname: nickname.trim().slice(0, 14) };
    if (!next.nickname) return;
    setLoading(true);
    setLoadingLabel(ACTION_LOADING_LABELS.setNickname);
    setNotice("");
    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "setNickname", playerId: next.id, nickname: next.nickname, roomId: activeRoomId, payload: {} }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "닉네임 변경 실패");
      const saved = { ...next, nickname: data.player?.nickname ?? next.nickname };
      localStorage.setItem("game-lobby-identity", JSON.stringify(saved));
      setIdentity(saved);
      if (data.snapshot) applySnapshot(data.snapshot as Snapshot, activeRoomId);
      setNicknameOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "닉네임 변경 실패");
    } finally {
      setLoading(false);
    }
  };

  if (!identity) return <div className="boot-screen">로비에 연결하는 중…</div>;

  const enterRoom = async (room: RoomListItem, password = "") => {
    const result = await command("joinRoom", { roomId: room.id, password });
    if (result) {
      setJoinTarget(null);
    }
  };

  const joinRoom = (room: RoomListItem) => {
    if (room.locked) setJoinTarget(room);
    else void enterRoom(room);
  };

  if (activeRoomId && snapshot.activeRoom) {
    return (
      <>
        <RoomView
          room={snapshot.activeRoom}
          identity={identity}
          loading={loading}
          onLeave={() => command("leaveRoom", { roomId: activeRoomId })}
          onStart={() => command("startGame", { roomId: activeRoomId })}
          onAction={(gameCommand) => command("gameAction", { roomId: activeRoomId, command: gameCommand })}
          onChat={openChat}
          hasUnreadChat={hasUnreadChat}
        />
        <ChatDrawer open={chatOpen} onClose={closeChat} identity={identity} snapshot={snapshot} command={command} />
        {notice && <Toast message={notice} onClose={() => setNotice("")} />}
        {loading && <ActionLoading label={loadingLabel} />}
      </>
    );
  }

  return (
    <div className="platform-shell">
      <aside className="game-rail" aria-label="게임 필터">
        <div className="brand-mark" aria-label="게임 로비"><span>G</span></div>
        <button className={gameFilter === "all" ? "rail-item active" : "rail-item"} onClick={() => setGameFilter("all")}>
          <span className="rail-icon">▦</span><span>전체</span>
        </button>
        {GAME_CATALOG.map((game) => (
          <button key={game.id} className={gameFilter === game.id ? "rail-item active" : "rail-item"} onClick={() => setGameFilter(game.id)} title={game.name}>
            <span className="rail-game-icon" style={{ background: game.accent }}>{game.icon}</span><span>{game.shortName}</span>
          </button>
        ))}
      </aside>

      <main className="lobby-main">
        <header className="topbar">
          <div className="topbar-title"><h1>게임 로비</h1><span className="online-pill"><i />현재 {snapshot.onlinePlayers.length || 1}명 접속 중</span></div>
          <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="방 이름 또는 게임 검색" /></label>
          <div className="top-actions">
            <button className={hasUnreadChat ? "icon-button has-unread" : "icon-button"} onClick={openChat} aria-label={hasUnreadChat ? "새 메시지 있음 · 채팅 열기" : "채팅 열기"}>▤{hasUnreadChat && <i className="chat-unread-dot" />}</button>
            <button className="profile-button" onClick={() => setNicknameOpen(true)}><span>{identity.nickname[0]}</span><strong>{identity.nickname}</strong></button>
            <button className="primary-button create-button" onClick={() => setCreateOpen(true)}>＋ 방 만들기</button>
          </div>
        </header>

        <section className="lobby-content">
          <div className="lobby-heading"><div><h2>참여할 방을 골라보세요</h2><p>친구들과 가볍게 즐기는 온라인 미니게임입니다.</p></div><button className="secondary-button" onClick={() => rooms[0] && joinRoom(rooms[0])} disabled={!rooms.length}>빠른 입장</button></div>
          <div className="status-filters">
            {([['all', '전체'], ['waiting', '대기 중'], ['playing', '게임 중'], ['locked', '비밀번호 방']] as const).map(([value, label]) => (
              <button key={value} className={statusFilter === value ? "active" : ""} onClick={() => setStatusFilter(value)}>{label}</button>
            ))}
          </div>
          {rooms.length ? (
            <div className="room-grid">
              {rooms.map((room) => <RoomCard key={room.id} room={room} onJoin={() => joinRoom(room)} />)}
            </div>
          ) : (
            <div className="empty-lobby"><span>✦</span><h3>아직 열린 방이 없어요</h3><p>첫 번째 방을 만들어 친구들을 불러보세요.</p><button className="primary-button" onClick={() => setCreateOpen(true)}>방 만들기</button></div>
          )}
        </section>
      </main>

      <button className="mobile-create" onClick={() => setCreateOpen(true)} aria-label="방 만들기">＋</button>
      <ChatDrawer open={chatOpen} onClose={closeChat} identity={identity} snapshot={snapshot} command={command} />
      {createOpen && <CreateRoomModal loading={loading} onClose={() => setCreateOpen(false)} onCreate={async (payload) => { const result = await command("createRoom", payload); if (result?.roomId) setCreateOpen(false); }} />}
      {nicknameOpen && <NicknameModal initialValue={identity.nickname} loading={loading} onClose={() => setNicknameOpen(false)} onSave={saveNickname} />}
      {joinTarget && <PasswordModal roomTitle={joinTarget.title} loading={loading} onClose={() => setJoinTarget(null)} onSubmit={(password) => enterRoom(joinTarget, password)} />}
      {notice && <Toast message={notice} onClose={() => setNotice("")} />}
      {loading && <ActionLoading label={loadingLabel} />}
    </div>
  );
}

function NicknameModal({ initialValue, loading, onClose, onSave }: {
  initialValue: string; loading: boolean; onClose: () => void; onSave: (nickname: string) => void;
}) {
  const [nickname, setNickname] = useState(initialValue);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal-card compact-modal" role="dialog" aria-modal="true" aria-labelledby="nickname-title" onSubmit={(event) => { event.preventDefault(); if (nickname.trim()) onSave(nickname); }}>
        <div className="modal-head"><div><span className="eyebrow">내 프로필</span><h2 id="nickname-title">닉네임 변경</h2></div><button type="button" onClick={onClose} aria-label="닫기">×</button></div>
        <label>새 닉네임<input autoFocus value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={14} placeholder="닉네임 입력" /></label>
        <p className="modal-note">최대 14글자까지 사용할 수 있어요.</p>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>취소</button><button className="primary-button" disabled={loading || !nickname.trim()}>저장</button></div>
      </form>
    </div>
  );
}

function PasswordModal({ roomTitle, loading, onClose, onSubmit }: {
  roomTitle: string; loading: boolean; onClose: () => void; onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal-card compact-modal" role="dialog" aria-modal="true" aria-labelledby="password-title" onSubmit={(event) => { event.preventDefault(); onSubmit(password); }}>
        <div className="modal-head"><div><span className="eyebrow">비밀번호 방</span><h2 id="password-title">{roomTitle}</h2></div><button type="button" onClick={onClose} aria-label="닫기">×</button></div>
        <label>방 비밀번호<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={40} placeholder="비밀번호 입력" /></label>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>취소</button><button className="primary-button" disabled={loading || !password}>입장</button></div>
      </form>
    </div>
  );
}

function RoomCard({ room, onJoin }: { room: RoomListItem; onJoin: () => void }) {
  const game = GAME_BY_ID[room.gameId];
  return (
    <article className={room.status === "playing" ? "room-card playing" : "room-card"}>
      <div className="room-art" style={{ background: game.accent }}><span>{game.icon}</span></div>
      <div className="room-info">
        <div className="room-tags"><span className="game-tag">{game.name}</span><span className={`status-tag ${room.status}`}>{room.status === "waiting" ? "대기 중" : "게임 중"}</span>{room.locked && <span title="비밀번호 방">🔒</span>}</div>
        <h3>{room.title}</h3>
        <div className="room-meta"><span className="host-avatar">{room.hostName[0]}</span><span>{room.hostName}</span><span>♙ {room.memberCount} / {room.capacity}</span></div>
      </div>
      <button className={room.status === "waiting" ? "join-button" : "watch-button"} onClick={onJoin}>{room.status === "waiting" ? "입장" : "관전"}</button>
    </article>
  );
}

function CreateRoomModal({ loading, onClose, onCreate }: { loading: boolean; onClose: () => void; onCreate: (payload: Record<string, unknown>) => void }) {
  const [gameId, setGameId] = useState<GameId>("gomoku");
  const [title, setTitle] = useState("");
  const [password, setPassword] = useState("");
  const [rounds, setRounds] = useState(5);
  const game = GAME_BY_ID[gameId];
  const supportsRounds = gameId === "drawing" || gameId === "chosung" || gameId === "same-answer";
  const roundOptions = gameId === "same-answer" ? [5, 10] : [3, 5, 7, 10];
  return (
    <div className="modal-backdrop" onMouseDown={(event) => !loading && event.target === event.currentTarget && onClose()}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div className="modal-head"><div><span className="eyebrow">새로운 게임</span><h2 id="create-title">방 만들기</h2></div><button onClick={onClose} aria-label="닫기">×</button></div>
        <label>게임 선택<select value={gameId} onChange={(event) => { const nextGameId = event.target.value as GameId; setGameId(nextGameId); if (nextGameId === "same-answer" && rounds !== 5 && rounds !== 10) setRounds(5); }}>{GAME_CATALOG.map((item) => <option key={item.id} value={item.id}>{item.name} · {playerCountLabel(item)}</option>)}</select></label>
        <div className="selected-game"><span style={{ background: game.accent }}>{game.icon}</span><div><strong>{game.name}</strong><p>{game.description}</p></div></div>
        {supportsRounds && <label>라운드 수<select value={rounds} onChange={(event) => setRounds(Number(event.target.value))}>{roundOptions.map((count) => <option key={count} value={count}>{count}라운드</option>)}</select></label>}
        <label>방 제목<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={30} placeholder={`${game.name} 같이 해요`} /></label>
        <label>비밀번호 <small>선택</small><input value={password} onChange={(event) => setPassword(event.target.value)} maxLength={40} type="password" placeholder="비워두면 공개 방" /></label>
        <p className="modal-note">방에는 최대 10명까지 들어올 수 있으며, 남는 인원은 관전합니다.</p>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={loading}>취소</button><button className="primary-button" disabled={loading} onClick={() => onCreate({ gameId, title, password, settings: supportsRounds ? { rounds } : {} })}>{loading ? "만드는 중…" : "방 만들기"}</button></div>
      </div>
    </div>
  );
}

function RoomView({ room, identity, loading, onLeave, onStart, onAction, onChat, hasUnreadChat }: {
  room: ActiveRoom; identity: Identity; loading: boolean; onLeave: () => void; onStart: () => void;
  onAction: (command: Omit<GameCommand, "playerId">) => void; onChat: () => void; hasUnreadChat: boolean;
}) {
  const gameInfo = GAME_BY_ID[room.gameId];
  const isHost = room.hostId === identity.id;
  return (
    <div className="room-screen">
      <header className="room-topbar">
        <button className="back-button" onClick={onLeave}>← 로비</button>
        <div><span className="eyebrow">{gameInfo.name}</span><h1>{room.title}</h1></div>
        <div className="room-top-actions"><span>{room.members.length}/10명</span><button className={hasUnreadChat ? "icon-button has-unread" : "icon-button"} onClick={onChat} aria-label={hasUnreadChat ? "새 메시지 있음 · 채팅 열기" : "채팅 열기"}>▤{hasUnreadChat && <i className="chat-unread-dot" />}</button></div>
      </header>
      <main className="room-layout">
        <aside className="member-panel">
          <div className="member-title"><h2>참가자</h2><span>{room.members.filter((member) => member.role === "player").length}/{gameInfo.maxPlayers}</span></div>
          <div className="member-list">{room.members.map((member) => <div className="member-row" key={member.id}><span className="member-avatar">{member.name[0]}</span><div><strong>{member.name}{member.id === identity.id && " (나)"}</strong><small>{member.id === room.hostId ? "방장" : member.role === "player" ? "플레이어" : "관전자"}</small></div></div>)}</div>
          {!room.game && isHost && <button className="primary-button full-button" onClick={onStart} disabled={loading}>게임 시작</button>}
          {!room.game && !isHost && <p className="waiting-copy">방장이 게임을 준비하고 있어요.</p>}
        </aside>
        <section className="game-panel">
          {room.game ? <GameStage game={room.game} playerId={identity.id} viewerRole={room.viewerRole} onAction={onAction} /> : <div className="game-waiting"><div className="big-game-icon" style={{ background: gameInfo.accent }}>{gameInfo.icon}</div><span className="eyebrow">{playerCountLabel(gameInfo)}{room.settings.rounds ? ` · ${room.settings.rounds}라운드` : ""}</span><h2>{gameInfo.name}</h2><p>{gameInfo.description}</p></div>}
        </section>
      </main>
    </div>
  );
}

function ChatDrawer({ open, onClose, identity, snapshot, command }: {
  open: boolean; onClose: () => void; identity: Identity; snapshot: Snapshot;
  command: (type: string, payload?: Record<string, unknown>) => Promise<unknown>;
}) {
  const [tab, setTab] = useState<"global" | "direct">("global");
  const [body, setBody] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const target = snapshot.onlinePlayers.find((player) => player.id === targetId);
  const messages = tab === "global" ? snapshot.globalMessages : snapshot.directMessages.filter((message) => targetId && ((message.senderId === identity.id && message.recipientId === targetId) || (message.senderId === targetId && message.recipientId === identity.id)));
  const send = async () => {
    if (!body.trim()) return;
    if (tab === "global") await command("sendGlobal", { body });
    else if (targetId) await command("sendDirect", { recipientId: targetId, body });
    setBody("");
  };
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <>
      <button className={open ? "drawer-scrim open" : "drawer-scrim"} onClick={onClose} aria-label="채팅 닫기" />
      <aside className={open ? "chat-drawer open" : "chat-drawer"} aria-hidden={!open}>
        <div className="chat-head"><h2>채팅</h2><button onClick={onClose} aria-label="닫기">×</button></div>
        <div className="chat-tabs"><button className={tab === "global" ? "active" : ""} onClick={() => setTab("global")}>전체 채팅</button><button className={tab === "direct" ? "active" : ""} onClick={() => setTab("direct")}>개인 메시지</button></div>
        {tab === "direct" && !targetId && <div className="people-picker"><input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="닉네임으로 사용자 검색" />{snapshot.onlinePlayers.filter((player) => player.id !== identity.id && player.nickname.includes(userSearch)).map((player) => <button key={player.id} onClick={() => setTargetId(player.id)}><i /><span>{player.nickname}</span><small>온라인</small></button>)}</div>}
        {tab === "direct" && targetId && <button className="dm-target" onClick={() => setTargetId(null)}>← {target?.nickname ?? "대화 상대"}</button>}
        {(tab === "global" || targetId) && <>
          <div className="message-list">{messages.length ? messages.map((message) => <div className={message.senderId === identity.id ? "message own" : "message"} key={message.id}><div><strong>{message.senderId === identity.id ? "나" : message.senderName}</strong><time>{new Date(message.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time></div><p>{message.body}</p></div>) : <div className="empty-chat">아직 메시지가 없어요.</div>}</div>
          <form className="chat-compose" onSubmit={(event) => { event.preventDefault(); send(); }}><input value={body} onChange={(event) => setBody(event.target.value)} maxLength={200} placeholder="메시지를 입력하세요" /><button aria-label="보내기">➤</button></form>
        </>}
      </aside>
    </>
  );
}

function ActionLoading({ label }: { label: string }) {
  return (
    <div className="action-loading" role="status" aria-live="polite" aria-label={label}>
      <div className="action-loading-card">
        <span className="loading-orbit" aria-hidden="true"><i /><i /><i /></span>
        <strong>{label}</strong>
        <small>곧 완료됩니다</small>
      </div>
    </div>
  );
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => { const timer = window.setTimeout(onClose, 4200); return () => window.clearTimeout(timer); }, [message, onClose]);
  return <button className="toast" onClick={onClose}>{message}<span>×</span></button>;
}
