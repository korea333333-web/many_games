"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { RealtimeChannel, SupabaseClient, User } from "@supabase/supabase-js";
import { GAME_BY_ID, GAME_CATALOG, type GameId, type GameInfo } from "@/lib/games/catalog";
import type { GameCommand, GameEnvelope } from "@/lib/games/engine";
import { hasUnreadMessage, latestMessageId } from "@/lib/chat/unread";
import { getSupabaseBrowserClient } from "@/lib/supabase/realtime-client";
import { isRankedGame, rankTier, RANKED_GAME_IDS, type LeaderboardEntry, type RankedGameId } from "@/lib/rankings";
import { GameStage } from "./GameStage";

const GameRulebook = dynamic(() => import("./GameRulebook").then((module) => module.GameRulebook), { ssr: false });

type Identity = { id: string; nickname: string };
type AuthAccount = { email: string; avatarUrl: string | null };
type RoomListItem = {
  id: string; title: string; gameId: GameId; hostId: string; hostName: string;
  status: "waiting" | "playing"; capacity: number; locked: boolean; memberCount: number; playerCount: number;
  settings: { rounds?: number; ranked?: boolean };
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
  leaderboard: LeaderboardEntry[];
};

const EMPTY_SNAPSHOT: Snapshot = { rooms: [], onlinePlayers: [], globalMessages: [], directMessages: [], activeRoom: null, leaderboard: [] };
const TIMED_GAME_IDS = new Set<GameId>(["word-chain", "drawing", "chosung", "same-answer"]);
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

function readStoredIdentity(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<Identity> | null;
    if (value && typeof value.id === "string" && typeof value.nickname === "string") {
      return { id: value.id, nickname: value.nickname };
    }
  } catch {
    localStorage.removeItem(key);
  }
  return null;
}

function getGuestIdentity() {
  const storedGuest = readStoredIdentity("game-lobby-guest-identity");
  if (storedGuest) return storedGuest;
  const legacyIdentity = readStoredIdentity("game-lobby-identity");
  const guest = legacyIdentity && !legacyIdentity.id.startsWith("user_") ? legacyIdentity : newIdentity();
  localStorage.setItem("game-lobby-guest-identity", JSON.stringify(guest));
  return guest;
}

function identityFromUser(user: User) {
  const id = `user_${user.id.replaceAll("-", "")}`;
  const stored = readStoredIdentity("game-lobby-identity");
  const metadataName = String(user.user_metadata.full_name ?? user.user_metadata.name ?? "").trim();
  const emailName = user.email?.split("@")[0] ?? "플레이어";
  return {
    id,
    nickname: stored?.id === id ? stored.nickname : (metadataName || emailName).slice(0, 14),
  };
}

function accountFromUser(user: User): AuthAccount {
  return {
    email: user.email ?? "Google 계정",
    avatarUrl: typeof user.user_metadata.avatar_url === "string" ? user.user_metadata.avatar_url : null,
  };
}

export function GamePlatform() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [authAccount, setAuthAccount] = useState<AuthAccount | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
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
  const [gameSyncing, setGameSyncing] = useState(false);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [rulebookOpen, setRulebookOpen] = useState(false);
  const [rulebookGameId, setRulebookGameId] = useState<GameId>("gomoku");
  const [rankingOpen, setRankingOpen] = useState(false);
  const [hasUnreadChat, setHasUnreadChat] = useState(false);
  const pollInFlight = useRef(false);
  const pendingGameActions = useRef(0);
  const snapshotRef = useRef<Snapshot>(EMPTY_SNAPSHOT);
  const latestObservedMessageIdRef = useRef(0);
  const lastReadMessageIdRef = useRef<number | null>(null);
  const chatOpenRef = useRef(false);
  const realtimeRefreshTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    const applyUser = (user: User | null, token: string | null) => {
      const value = user ? identityFromUser(user) : getGuestIdentity();
      const previous = readStoredIdentity("game-lobby-identity");
      localStorage.setItem("game-lobby-identity", JSON.stringify(value));
      const storedLastReadValue = localStorage.getItem(`game-lobby-chat-read:${value.id}`);
      const storedLastRead = storedLastReadValue === null ? Number.NaN : Number(storedLastReadValue);
      lastReadMessageIdRef.current = Number.isFinite(storedLastRead) && storedLastRead >= 0 ? storedLastRead : null;
      const storedRoom = previous?.id === value.id ? localStorage.getItem("game-lobby-active-room") : null;
      if (!storedRoom) localStorage.removeItem("game-lobby-active-room");
      setIdentity(value);
      setAuthAccount(user ? accountFromUser(user) : null);
      setAccessToken(token);
      setActiveRoomId(storedRoom);
    };

    void getSupabaseBrowserClient().then(async (client) => {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      if (cancelled) return;
      applyUser(data.session?.user ?? null, data.session?.access_token ?? null);
      const listener = client.auth.onAuthStateChange((_event, session) => {
        if (!cancelled) applyUser(session?.user ?? null, session?.access_token ?? null);
      });
      unsubscribe = () => listener.data.subscription.unsubscribe();
    }).catch((error) => {
      if (cancelled) return;
      applyUser(null, null);
      setNotice(error instanceof Error ? `로그인 상태를 확인하지 못했습니다: ${error.message}` : "로그인 상태를 확인하지 못했습니다.");
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
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
    latestObservedMessageIdRef.current = Math.max(latestObservedMessageIdRef.current, newestMessageId);
    if (lastReadMessageIdRef.current === null || chatOpenRef.current) {
      lastReadMessageIdRef.current = newestMessageId;
      localStorage.setItem(`game-lobby-chat-read:${identity.id}`, String(newestMessageId));
      if (chatOpenRef.current) setHasUnreadChat(false);
    } else if (hasUnreadMessage(allMessages, lastReadMessageIdRef.current, identity.id)) {
      setHasUnreadChat(true);
    }
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
      const response = await fetch(`/api/sync?${params}`, {
        cache: "no-store",
        headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "서버 연결 실패");
      applySnapshot(data as Snapshot, roomId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "서버 연결 실패");
    }
  }, [identity, activeRoomId, applySnapshot, accessToken]);

  const syncNow = useCallback(async () => {
    if (document.hidden || pollInFlight.current || pendingGameActions.current > 0) return;
    pollInFlight.current = true;
    try { await refresh(); }
    finally { pollInFlight.current = false; }
  }, [refresh]);

  const activeGameId = snapshot.activeRoom?.game?.gameId ?? null;
  const activeGamePhase = snapshot.activeRoom?.game?.phase ?? null;

  useEffect(() => {
    if (!identity) return;
    let cancelled = false;
    const topics = ["lobby", ...(activeRoomId ? [`room:${activeRoomId}`] : [])];
    const subscribed = new Set<string>();
    let realtimeClient: SupabaseClient | null = null;
    let channels: RealtimeChannel[] = [];

    void getSupabaseBrowserClient().then((client) => {
      realtimeClient = client;
      if (cancelled) return;
      channels = topics.map((topic) => client
        .channel(topic)
        .on("broadcast", { event: "state-changed" }, ({ payload }) => {
          if (payload?.origin === identity.id) return;
          if (realtimeRefreshTimer.current !== null) window.clearTimeout(realtimeRefreshTimer.current);
          realtimeRefreshTimer.current = window.setTimeout(() => void syncNow(), 24);
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            subscribed.add(topic);
            if (subscribed.size === topics.length) setRealtimeConnected(true);
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            subscribed.delete(topic);
            setRealtimeConnected(false);
          }
        }));
    }).catch(() => {
      if (!cancelled) setRealtimeConnected(false);
    });

    return () => {
      cancelled = true;
      if (realtimeRefreshTimer.current !== null) {
        window.clearTimeout(realtimeRefreshTimer.current);
        realtimeRefreshTimer.current = null;
      }
      if (realtimeClient) {
        void Promise.all(channels.map((channel) => realtimeClient!.removeChannel(channel)));
      }
    };
  }, [identity, activeRoomId, syncNow]);

  useEffect(() => {
    if (!identity) return;
    void syncNow();
    const needsTimerSync = Boolean(activeGameId && activeGamePhase !== "finished" && TIMED_GAME_IDS.has(activeGameId));
    const fallbackInterval = realtimeConnected
      ? needsTimerSync ? 1_000 : activeRoomId ? 8_000 : 15_000
      : activeRoomId ? 800 : 1_600;
    const timer = window.setInterval(() => void syncNow(), fallbackInterval);
    return () => window.clearInterval(timer);
  }, [identity, activeRoomId, realtimeConnected, activeGameId, activeGamePhase, syncNow]);

  const command = useCallback(async (type: string, payload: Record<string, unknown> = {}) => {
    if (!identity) return null;
    const blocksScreen = type !== "gameAction" && type !== "sendGlobal" && type !== "sendDirect";
    if (blocksScreen) {
      setLoading(true);
      setLoadingLabel(ACTION_LOADING_LABELS[type] ?? "요청을 처리하고 있어요");
    }
    if (type === "gameAction") {
      pendingGameActions.current += 1;
      setGameSyncing(true);
    }
    setNotice("");
    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
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
      if (blocksScreen) setLoading(false);
      if (type === "gameAction") {
        pendingGameActions.current = Math.max(0, pendingGameActions.current - 1);
        if (pendingGameActions.current === 0) setGameSyncing(false);
      }
    }
  }, [identity, activeRoomId, applySnapshot, refresh, accessToken]);

  const rooms = useMemo(() => snapshot.rooms.filter((room) => {
    if (gameFilter !== "all" && room.gameId !== gameFilter) return false;
    if (statusFilter === "locked" && !room.locked) return false;
    if ((statusFilter === "waiting" || statusFilter === "playing") && room.status !== statusFilter) return false;
    const query = search.trim().toLowerCase();
    return !query || room.title.toLowerCase().includes(query) || GAME_BY_ID[room.gameId].name.includes(query);
  }), [snapshot.rooms, gameFilter, statusFilter, search]);

  const openChat = useCallback(() => {
    chatOpenRef.current = true;
    lastReadMessageIdRef.current = latestObservedMessageIdRef.current;
    if (identity) localStorage.setItem(`game-lobby-chat-read:${identity.id}`, String(latestObservedMessageIdRef.current));
    setHasUnreadChat(false);
    setChatOpen(true);
  }, [identity]);

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
        headers: {
          "content-type": "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
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

  const signInWithGoogle = async () => {
    setAuthBusy(true);
    setNotice("");
    try {
      const client = await getSupabaseBrowserClient();
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: window.location.origin,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) throw error;
    } catch (error) {
      setAuthBusy(false);
      setNotice(error instanceof Error ? error.message : "Google 로그인을 시작하지 못했습니다.");
    }
  };

  const signOut = async () => {
    setAuthBusy(true);
    setNotice("");
    try {
      const client = await getSupabaseBrowserClient();
      const { error } = await client.auth.signOut();
      if (error) throw error;
      setNicknameOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "로그아웃하지 못했습니다.");
    } finally {
      setAuthBusy(false);
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
    if (room.settings.ranked && !authAccount) {
      setNotice("랭크전은 Google 로그인 후 참가할 수 있습니다.");
      return;
    }
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
          syncing={gameSyncing}
          onLeave={() => command("leaveRoom", { roomId: activeRoomId })}
          onStart={() => command("startGame", { roomId: activeRoomId })}
          onAction={(gameCommand) => command("gameAction", { roomId: activeRoomId, command: gameCommand })}
          onChat={openChat}
          onRules={() => { setRulebookGameId(snapshot.activeRoom!.gameId); setRulebookOpen(true); }}
          hasUnreadChat={hasUnreadChat}
        />
        <ChatDrawer open={chatOpen} onClose={closeChat} identity={identity} snapshot={snapshot} command={command} />
        <GameRulebook key={`${rulebookGameId}-${rulebookOpen}`} open={rulebookOpen} initialGameId={rulebookGameId} onClose={() => setRulebookOpen(false)} />
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
            <button className="rulebook-trigger" onClick={() => { setRulebookGameId(gameFilter === "all" ? "gomoku" : gameFilter); setRulebookOpen(true); }}><span aria-hidden="true">▥</span><strong>게임 사전</strong></button>
            <button className="ranking-trigger" onClick={() => setRankingOpen(true)} aria-label="랭킹"><span aria-hidden="true">♛</span><strong>랭킹</strong></button>
            <button className={hasUnreadChat ? "icon-button has-unread" : "icon-button"} onClick={openChat} aria-label={hasUnreadChat ? "새 메시지 있음 · 채팅 열기" : "채팅 열기"}>▤{hasUnreadChat && <i className="chat-unread-dot" />}</button>
            {!authAccount && <button type="button" className="top-login-button" onClick={signInWithGoogle} disabled={authBusy} aria-label="Google 계정으로 로그인"><b aria-hidden="true">G</b><span>{authBusy ? "이동 중…" : "Google 로그인"}</span></button>}
            <button className={authAccount ? "profile-button" : "profile-button guest-profile"} onClick={() => setNicknameOpen(true)} aria-label="내 프로필 열기"><ProfileAvatar nickname={identity.nickname} avatarUrl={authAccount?.avatarUrl} /><strong>{identity.nickname}</strong></button>
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
      <GameRulebook key={`${rulebookGameId}-${rulebookOpen}`} open={rulebookOpen} initialGameId={rulebookGameId} onClose={() => setRulebookOpen(false)} />
      {rankingOpen && <LeaderboardModal entries={snapshot.leaderboard} identity={identity} loggedIn={Boolean(authAccount)} onClose={() => setRankingOpen(false)} onLogin={signInWithGoogle} />}
      {createOpen && <CreateRoomModal loading={loading} loggedIn={Boolean(authAccount)} onClose={() => setCreateOpen(false)} onCreate={async (payload) => { const result = await command("createRoom", payload); if (result?.roomId) setCreateOpen(false); }} />}
      {nicknameOpen && <ProfileModal identity={identity} account={authAccount} career={snapshot.leaderboard.find((entry) => entry.playerId === identity.id)} loading={loading} authBusy={authBusy} onClose={() => setNicknameOpen(false)} onSave={saveNickname} onGoogleSignIn={signInWithGoogle} onSignOut={signOut} />}
      {joinTarget && <PasswordModal roomTitle={joinTarget.title} loading={loading} onClose={() => setJoinTarget(null)} onSubmit={(password) => enterRoom(joinTarget, password)} />}
      {notice && <Toast message={notice} onClose={() => setNotice("")} />}
      {loading && <ActionLoading label={loadingLabel} />}
    </div>
  );
}

function ProfileAvatar({ nickname, avatarUrl }: { nickname: string; avatarUrl?: string | null }) {
  return <span className={avatarUrl ? "profile-avatar has-image" : "profile-avatar"} style={avatarUrl ? { backgroundImage: `url(${JSON.stringify(avatarUrl)})` } : undefined}>{avatarUrl ? "" : nickname[0]}</span>;
}

function ProfileModal({ identity, account, career, loading, authBusy, onClose, onSave, onGoogleSignIn, onSignOut }: {
  identity: Identity; account: AuthAccount | null; career?: LeaderboardEntry; loading: boolean; authBusy: boolean; onClose: () => void;
  onSave: (nickname: string) => void; onGoogleSignIn: () => void; onSignOut: () => void;
}) {
  const [nickname, setNickname] = useState(identity.nickname);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal-card compact-modal" role="dialog" aria-modal="true" aria-labelledby="nickname-title" onSubmit={(event) => { event.preventDefault(); if (nickname.trim()) onSave(nickname); }}>
        <div className="modal-head"><div><span className="eyebrow">내 프로필</span><h2 id="nickname-title">프로필 설정</h2></div><button type="button" onClick={onClose} aria-label="닫기">×</button></div>
        <div className="profile-account-card">
          <ProfileAvatar nickname={identity.nickname} avatarUrl={account?.avatarUrl} />
          <div><strong>{identity.nickname}</strong><small>{account?.email ?? "게스트로 접속 중"}</small></div>
          <span className={account ? "account-badge connected" : "account-badge"}>{account ? "Google 연결됨" : "임시 계정"}</span>
        </div>
        {!account && <button type="button" className="google-login-button" onClick={onGoogleSignIn} disabled={authBusy}><b aria-hidden="true">G</b>{authBusy ? "Google로 이동 중…" : "Google로 로그인"}</button>}
        {account && <div className="profile-career"><div><strong>{career?.total.played ?? 0}</strong><span>총 경기</span></div><div><strong>{career?.total.wins ?? 0}</strong><span>승리</span></div><div><strong>{career?.total.played ? Math.round(career.total.wins / career.total.played * 100) : 0}%</strong><span>승률</span></div></div>}
        <label>새 닉네임<input autoFocus value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={14} placeholder="닉네임 입력" /></label>
        <p className="modal-note">최대 14글자까지 사용할 수 있어요.</p>
        <div className="modal-actions profile-actions">{account && <button type="button" className="text-button danger" onClick={onSignOut} disabled={authBusy}>로그아웃</button>}<span /><button type="button" className="secondary-button" onClick={onClose}>취소</button><button className="primary-button" disabled={loading || authBusy || !nickname.trim()}>저장</button></div>
      </form>
    </div>
  );
}

function LeaderboardModal({ entries, identity, loggedIn, onClose, onLogin }: {
  entries: LeaderboardEntry[]; identity: Identity; loggedIn: boolean; onClose: () => void; onLogin: () => void;
}) {
  const [tab, setTab] = useState<"overall" | RankedGameId>("overall");
  const rows = useMemo(() => {
    if (tab === "overall") return entries;
    return entries
      .filter((entry) => (entry.ranked[tab]?.played ?? 0) > 0)
      .sort((left, right) => (right.ranked[tab]?.rating ?? 0) - (left.ranked[tab]?.rating ?? 0)
        || (right.ranked[tab]?.wins ?? 0) - (left.ranked[tab]?.wins ?? 0));
  }, [entries, tab]);
  const myEntry = entries.find((entry) => entry.playerId === identity.id);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card leaderboard-modal" role="dialog" aria-modal="true" aria-labelledby="leaderboard-title">
        <div className="modal-head"><div><span className="eyebrow">HALL OF PLAYERS</span><h2 id="leaderboard-title">🏆 게임 랭킹</h2></div><button type="button" onClick={onClose} aria-label="닫기">×</button></div>
        <div className="leaderboard-tabs">
          <button className={tab === "overall" ? "active" : ""} onClick={() => setTab("overall")}>전체 전적</button>
          {RANKED_GAME_IDS.map((gameId) => <button key={gameId} className={tab === gameId ? "active" : ""} onClick={() => setTab(gameId)}>{GAME_BY_ID[gameId].name}</button>)}
        </div>
        {!loggedIn && <div className="ranking-login-callout"><div><strong>내 기록도 남기고 싶다면?</strong><span>Google 로그인 후 일반 전적과 랭크 점수가 저장됩니다.</span></div><button type="button" onClick={onLogin}>Google 로그인</button></div>}
        {loggedIn && myEntry && <div className="my-ranking-summary"><span>내 전체 기록</span><strong>{myEntry.total.wins}승 · {myEntry.total.played}경기 · 승률 {myEntry.total.played ? Math.round(myEntry.total.wins / myEntry.total.played * 100) : 0}%</strong></div>}
        <div className="leaderboard-list">
          {rows.length ? rows.map((entry, index) => {
            const ranked = tab === "overall" ? null : entry.ranked[tab];
            const record = tab === "overall" ? entry.total : ranked!;
            return <article key={entry.playerId} className={entry.playerId === identity.id ? "leaderboard-row mine" : "leaderboard-row"}><b className={`rank-number rank-${index + 1}`}>{index + 1}</b><span className="rank-avatar">{entry.nickname[0]}</span><div><strong>{entry.nickname}{entry.playerId === identity.id && " (나)"}</strong><small>{tab === "overall" ? `${record.played}경기 · ${record.wins}승 ${record.draws}무 ${record.losses}패` : `${rankTier(ranked!.rating)} · ${record.wins}승 ${record.draws}무 ${record.losses}패`}</small></div><div className="rank-score"><strong>{tab === "overall" ? record.wins : ranked!.rating}</strong><span>{tab === "overall" ? "승" : "RP"}</span></div></article>;
          }) : <div className="empty-ranking"><span>♛</span><strong>아직 기록이 없어요</strong><p>{tab === "overall" ? "로그인하고 첫 게임을 완료해 보세요." : `${GAME_BY_ID[tab].name} 랭크전의 첫 승자가 되어보세요.`}</p></div>}
        </div>
        <p className="ranking-footnote">일반 전적은 모든 게임에 기록됩니다. 랭크 점수는 로그인한 두 명이 완료한 랭크전에만 반영됩니다.</p>
      </section>
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
        <div className="room-tags"><span className="game-tag">{game.name}</span>{room.settings.ranked && <span className="ranked-tag">RANKED</span>}<span className={`status-tag ${room.status}`}>{room.status === "waiting" ? "대기 중" : "게임 중"}</span>{room.locked && <span title="비밀번호 방">🔒</span>}</div>
        <h3>{room.title}</h3>
        <div className="room-meta"><span className="host-avatar">{room.hostName[0]}</span><span>{room.hostName}</span><span>♙ {room.memberCount} / {room.capacity}</span></div>
      </div>
      <button className={room.status === "waiting" ? "join-button" : "watch-button"} onClick={onJoin}>{room.status === "waiting" ? "입장" : "관전"}</button>
    </article>
  );
}

function CreateRoomModal({ loading, loggedIn, onClose, onCreate }: { loading: boolean; loggedIn: boolean; onClose: () => void; onCreate: (payload: Record<string, unknown>) => void }) {
  const [gameId, setGameId] = useState<GameId>("gomoku");
  const [title, setTitle] = useState("");
  const [password, setPassword] = useState("");
  const [rounds, setRounds] = useState(5);
  const [ranked, setRanked] = useState(false);
  const game = GAME_BY_ID[gameId];
  const supportsRounds = gameId === "drawing" || gameId === "chosung" || gameId === "same-answer";
  const supportsRanked = isRankedGame(gameId);
  const roundOptions = gameId === "same-answer" ? [5, 10] : [3, 5, 7, 10];
  return (
    <div className="modal-backdrop" onMouseDown={(event) => !loading && event.target === event.currentTarget && onClose()}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div className="modal-head"><div><span className="eyebrow">새로운 게임</span><h2 id="create-title">방 만들기</h2></div><button onClick={onClose} aria-label="닫기">×</button></div>
        <label>게임 선택<select value={gameId} onChange={(event) => { const nextGameId = event.target.value as GameId; setGameId(nextGameId); if (!isRankedGame(nextGameId)) setRanked(false); if (nextGameId === "same-answer" && rounds !== 5 && rounds !== 10) setRounds(5); }}>{GAME_CATALOG.map((item) => <option key={item.id} value={item.id}>{item.name} · {playerCountLabel(item)}</option>)}</select></label>
        <div className="selected-game"><span style={{ background: game.accent }}>{game.icon}</span><div><strong>{game.name}</strong><p>{game.description}</p></div></div>
        {supportsRanked && <button type="button" className={ranked ? "ranked-mode-card selected" : "ranked-mode-card"} disabled={!loggedIn} onClick={() => { setRanked((value) => !value); setPassword(""); }}><span>♛</span><div><strong>랭크전 {ranked ? "ON" : "OFF"}</strong><small>{loggedIn ? "완료된 경기의 승패와 RP가 기록됩니다." : "Google 로그인 후 선택할 수 있습니다."}</small></div><i>{ranked ? "선택됨" : "선택"}</i></button>}
        {supportsRounds && <label>라운드 수<select value={rounds} onChange={(event) => setRounds(Number(event.target.value))}>{roundOptions.map((count) => <option key={count} value={count}>{count}라운드</option>)}</select></label>}
        <label>방 제목<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={30} placeholder={`${game.name} 같이 해요`} /></label>
        <label>비밀번호 <small>{ranked ? "랭크전은 공개방" : "선택"}</small><input value={password} onChange={(event) => setPassword(event.target.value)} disabled={ranked} maxLength={40} type="password" placeholder={ranked ? "랭크전에서는 사용할 수 없어요" : "비워두면 공개 방"} /></label>
        <p className="modal-note">{ranked ? "로그인한 플레이어 2명이 참가해야 시작할 수 있으며, 중단된 경기는 기록되지 않습니다." : "방에는 최대 10명까지 들어올 수 있으며, 남는 인원은 관전합니다."}</p>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={loading}>취소</button><button className="primary-button" disabled={loading} onClick={() => onCreate({ gameId, title, password, settings: { ...(supportsRounds ? { rounds } : {}), ...(ranked ? { ranked: true } : {}) } })}>{loading ? "만드는 중…" : ranked ? "랭크방 만들기" : "방 만들기"}</button></div>
      </div>
    </div>
  );
}

function RoomView({ room, identity, loading, syncing, onLeave, onStart, onAction, onChat, onRules, hasUnreadChat }: {
  room: ActiveRoom; identity: Identity; loading: boolean; syncing: boolean; onLeave: () => void; onStart: () => void;
  onAction: (command: Omit<GameCommand, "playerId">) => Promise<unknown>; onChat: () => void; onRules: () => void; hasUnreadChat: boolean;
}) {
  const gameInfo = GAME_BY_ID[room.gameId];
  const isHost = room.hostId === identity.id;
  return (
    <div className="room-screen">
      <header className="room-topbar">
        <button className="back-button" onClick={onLeave}>← 로비</button>
        <div><span className="eyebrow">{room.settings.ranked ? `RANKED · ${gameInfo.name}` : gameInfo.name}</span><h1>{room.title}</h1></div>
        <div className="room-top-actions"><span>{room.members.length}/10명</span><span className={syncing ? "room-sync active" : "room-sync"} aria-live="polite"><i />{syncing ? "저장 중" : "연결됨"}</span><button className="rulebook-trigger compact" onClick={onRules} aria-label={`${gameInfo.name} 규칙 보기`}><span aria-hidden="true">▥</span></button><button className={hasUnreadChat ? "icon-button has-unread" : "icon-button"} onClick={onChat} aria-label={hasUnreadChat ? "새 메시지 있음 · 채팅 열기" : "채팅 열기"}>▤{hasUnreadChat && <i className="chat-unread-dot" />}</button></div>
      </header>
      <main className="room-layout">
        <aside className="member-panel">
          {room.settings.ranked && <div className="ranked-room-banner"><span>♛</span><div><strong>랭크전</strong><small>승패와 RP가 반영됩니다</small></div></div>}
          <div className="member-title"><h2>참가자</h2><span>{room.members.filter((member) => member.role === "player").length}/{gameInfo.maxPlayers}</span></div>
          <div className="member-list">{room.members.map((member) => <div className="member-row" key={member.id}><span className="member-avatar">{member.name[0]}</span><div><strong>{member.name}{member.id === identity.id && " (나)"}</strong><small>{member.id === room.hostId ? "방장" : member.role === "player" ? "플레이어" : "관전자"}</small></div></div>)}</div>
          {!room.game && isHost && <button className="primary-button full-button" onClick={onStart} disabled={loading}>게임 시작</button>}
          {!room.game && !isHost && <p className="waiting-copy">방장이 게임을 준비하고 있어요.</p>}
        </aside>
        <section className="game-panel">
          {room.game ? <GameStage game={room.game} revision={room.revision} playerId={identity.id} viewerRole={room.viewerRole} onAction={onAction} /> : <div className="game-waiting"><div className="big-game-icon" style={{ background: gameInfo.accent }}>{gameInfo.icon}</div><span className="eyebrow">{room.settings.ranked ? "♛ 랭크전 · 로그인 2명" : playerCountLabel(gameInfo)}{room.settings.rounds ? ` · ${room.settings.rounds}라운드` : ""}</span><h2>{gameInfo.name}</h2><p>{room.settings.ranked ? "승리하면 RP가 오르고 패배하면 내려갑니다. 중단 경기는 기록되지 않습니다." : gameInfo.description}</p><button className="waiting-rules" onClick={onRules}>▥ 규칙 먼저 보기</button></div>}
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
