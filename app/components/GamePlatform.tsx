"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { RealtimeChannel, SupabaseClient, User } from "@supabase/supabase-js";
import { GAME_BY_ID, GAME_CATALOG, type GameId, type GameInfo } from "@/lib/games/catalog";
import type { GameCommand, GameEnvelope } from "@/lib/games/engine";
import { hasUnreadMessage, latestMessageId } from "@/lib/chat/unread";
import { getSupabaseBrowserClient } from "@/lib/supabase/realtime-client";
import { isRankedGame, rankTier, RANKED_GAME_IDS, type LeaderboardEntry, type RankedGameId } from "@/lib/rankings";
import type { AdminRole, CosmeticItem, CosmeticKind, FeedbackRecord, WarningRecord } from "@/lib/community";
import { GameStage } from "./GameStage";

const GameRulebook = dynamic(() => import("./GameRulebook").then((module) => module.GameRulebook), { ssr: false });

type Identity = { id: string; nickname: string };
type AuthAccount = { email: string; avatarUrl: string | null };
type RoomListItem = {
  id: string; title: string; gameId: GameId; hostId: string; hostName: string;
  status: "waiting" | "playing"; capacity: number; locked: boolean; memberCount: number; playerCount: number;
  onlineCount: number; persistent: boolean; reservedForViewer: boolean; participantLocked: boolean;
  lastActiveAt: string; expiresAt?: string | null;
  settings: { rounds?: number; ranked?: boolean };
};
type Member = { id: string; name: string; role: "player" | "spectator"; joinedAt: string; online?: boolean; adminRole: AdminRole };
type ActiveRoom = RoomListItem & { members: Member[]; viewerRole: string; game: GameEnvelope | null; revision: number };
type ChatMessage = { id: number; senderId: string; senderName: string; senderAdminRole: AdminRole; recipientId?: string; recipientName?: string; body: string; createdAt: string; deletedAt?: string };
type DirectContact = { id: string; nickname: string; lastSeen: string; online: boolean; pinned: boolean; adminRole: AdminRole };
type OnlinePlayer = { id: string; nickname: string; lastSeen: string; adminRole: AdminRole };
type ServerPresence = OnlinePlayer & { loggedIn: boolean; room: { id: string; title: string; gameId: GameId; status: "waiting" | "playing" } | null };
type AnnouncementView = { id: string; body: string; issuerId: string; issuerName: string; issuerAdminRole: AdminRole; createdAt: string; expiresAt: string };
type PublicProfile = {
  id: string; nickname: string; createdAt: string; updatedAt: string; statusMessage: string; coins: number;
  infiniteCoins: boolean;
  equipped: Partial<Record<CosmeticKind, string>>; adminRole: AdminRole;
  career: { total: { played: number; wins: number; losses: number; draws: number }; games: LeaderboardEntry["games"]; ranked: LeaderboardEntry["ranked"] };
};
type ModerationPlayer = PublicProfile & { warningCount: number; banned: boolean };
type FeedbackView = FeedbackRecord & { nickname?: string };
type Snapshot = {
  rooms: RoomListItem[];
  onlinePlayers: OnlinePlayer[];
  directContacts: DirectContact[];
  pinnedDirectIds: string[];
  globalMessages: ChatMessage[];
  directMessages: ChatMessage[];
  activeRoom: ActiveRoom | null;
  leaderboard: LeaderboardEntry[];
  playerDirectory: PublicProfile[];
  viewerProfile: PublicProfile | null;
  viewerInventoryIds: string[];
  cosmetics: CosmeticItem[];
  adminRole: AdminRole;
  viewerWarnings: WarningRecord[];
  ban: { reason: string; createdAt: string } | null;
  moderationPlayers: ModerationPlayer[];
  feedback: FeedbackView[];
  announcement: AnnouncementView | null;
  serverPresence: ServerPresence[];
  secondaryAdminCount: number;
};

const EMPTY_SNAPSHOT: Snapshot = { rooms: [], onlinePlayers: [], directContacts: [], pinnedDirectIds: [], globalMessages: [], directMessages: [], activeRoom: null, leaderboard: [], playerDirectory: [], viewerProfile: null, viewerInventoryIds: [], cosmetics: [], adminRole: null, viewerWarnings: [], ban: null, moderationPlayers: [], feedback: [], announcement: null, serverPresence: [], secondaryAdminCount: 0 };
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
  toggleDirectPin: "대화 상대를 고정하고 있어요",
  updateProfile: "프로필을 꾸미고 있어요",
  purchaseCosmetic: "치장품을 구입하고 있어요",
  submitFeedback: "피드백을 보내고 있어요",
  grantCoins: "코인을 지급하고 있어요",
  sendAnnouncement: "공지를 전송하고 있어요",
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
  const [profileTargetId, setProfileTargetId] = useState<string | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [joinTarget, setJoinTarget] = useState<RoomListItem | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("잠시만 기다려 주세요");
  const [gameSyncing, setGameSyncing] = useState(false);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [rulebookOpen, setRulebookOpen] = useState(false);
  const [rulebookGameId, setRulebookGameId] = useState<GameId>("gomoku");
  const [rankingOpen, setRankingOpen] = useState(false);
  const [hasUnreadGlobal, setHasUnreadGlobal] = useState(false);
  const [hasUnreadDirect, setHasUnreadDirect] = useState(false);
  const pollInFlight = useRef(false);
  const pendingGameActions = useRef(0);
  const snapshotRef = useRef<Snapshot>(EMPTY_SNAPSHOT);
  const latestObservedGlobalIdRef = useRef(0);
  const latestObservedDirectIdRef = useRef(0);
  const lastReadGlobalIdRef = useRef<number | null>(null);
  const lastReadDirectIdRef = useRef<number | null>(null);
  const chatOpenRef = useRef(false);
  const realtimeRefreshTimer = useRef<number | null>(null);
  const hasUnreadChat = hasUnreadGlobal || hasUnreadDirect;
  const onlineAdminCount = snapshot.onlinePlayers.filter((player) => player.adminRole).length;

  useEffect(() => {
    const openSecretAdmin = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        setAdminOpen(true);
      }
    };
    window.addEventListener("keydown", openSecretAdmin);
    return () => window.removeEventListener("keydown", openSecretAdmin);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    const applyUser = (user: User | null, token: string | null) => {
      const value = user ? identityFromUser(user) : getGuestIdentity();
      const previous = readStoredIdentity("game-lobby-identity");
      localStorage.setItem("game-lobby-identity", JSON.stringify(value));
      const legacyReadValue = localStorage.getItem(`game-lobby-chat-read:${value.id}`);
      const readMarker = (scope: "global" | "direct") => {
        const stored = localStorage.getItem(`game-lobby-chat-${scope}-read:${value.id}`) ?? legacyReadValue;
        const parsed = stored === null ? Number.NaN : Number(stored);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      };
      lastReadGlobalIdRef.current = readMarker("global");
      lastReadDirectIdRef.current = readMarker("direct");
      latestObservedGlobalIdRef.current = 0;
      latestObservedDirectIdRef.current = 0;
      setHasUnreadGlobal(false);
      setHasUnreadDirect(false);
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
    const newestGlobalId = latestMessageId(data.globalMessages);
    const newestDirectId = latestMessageId(data.directMessages);
    latestObservedGlobalIdRef.current = Math.max(latestObservedGlobalIdRef.current, newestGlobalId);
    latestObservedDirectIdRef.current = Math.max(latestObservedDirectIdRef.current, newestDirectId);
    const updateUnread = (
      scope: "global" | "direct",
      messages: ChatMessage[],
      newestId: number,
      lastReadRef: typeof lastReadGlobalIdRef,
      setUnread: (value: boolean) => void,
    ) => {
      if (lastReadRef.current === null || chatOpenRef.current) {
        lastReadRef.current = newestId;
        localStorage.setItem(`game-lobby-chat-${scope}-read:${identity.id}`, String(newestId));
        if (chatOpenRef.current) setUnread(false);
      } else if (hasUnreadMessage(messages, lastReadRef.current, identity.id)) setUnread(true);
    };
    updateUnread("global", data.globalMessages, newestGlobalId, lastReadGlobalIdRef, setHasUnreadGlobal);
    updateUnread("direct", data.directMessages, newestDirectId, lastReadDirectIdRef, setHasUnreadDirect);
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
    const blocksScreen = type !== "gameAction" && type !== "sendGlobal" && type !== "sendDirect" && type !== "toggleDirectPin";
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
      if (data.message && type !== "gameAction") setNotice(String(data.message));
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
    lastReadGlobalIdRef.current = latestObservedGlobalIdRef.current;
    lastReadDirectIdRef.current = latestObservedDirectIdRef.current;
    if (identity) {
      localStorage.setItem(`game-lobby-chat-global-read:${identity.id}`, String(latestObservedGlobalIdRef.current));
      localStorage.setItem(`game-lobby-chat-direct-read:${identity.id}`, String(latestObservedDirectIdRef.current));
    }
    setHasUnreadGlobal(false);
    setHasUnreadDirect(false);
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
       setProfileTargetId(null);
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
      setProfileTargetId(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "로그아웃하지 못했습니다.");
    } finally {
      setAuthBusy(false);
    }
  };

  if (!identity) return <div className="boot-screen">로비에 연결하는 중…</div>;

  if (snapshot.ban) return <BanScreen reason={snapshot.ban.reason} onSignOut={authAccount ? signOut : undefined} />;

  const profileTarget = profileTargetId
    ? snapshot.playerDirectory.find((profile) => profile.id === profileTargetId) ?? (profileTargetId === identity.id ? snapshot.viewerProfile : null)
    : null;
  const unreadWarning = snapshot.viewerWarnings.find((warning) => !warning.acknowledgedAt);

  const enterRoom = async (room: RoomListItem, password = "") => {
    const result = await command("joinRoom", { roomId: room.id, password });
    if (result) {
      setJoinTarget(null);
    }
  };

  const joinRoom = (room: RoomListItem) => {
    if (room.gameId === "go" && !authAccount) {
      setNotice("바둑 이어두기는 Google 로그인 후 참가할 수 있습니다.");
      return;
    }
    if (room.gameId === "go" && room.participantLocked && !room.reservedForViewer) {
      setNotice("이 바둑방은 처음 참가한 두 사람만 다시 들어갈 수 있습니다.");
      return;
    }
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
        {snapshot.announcement && <AnnouncementBanner key={snapshot.announcement.id} announcement={snapshot.announcement} />}
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
          hasUnreadGlobal={hasUnreadGlobal}
          hasUnreadDirect={hasUnreadDirect}
          onProfile={setProfileTargetId}
        />
        <ChatDrawer open={chatOpen} onClose={closeChat} identity={identity} snapshot={snapshot} command={command} loggedIn={Boolean(authAccount)} onProfile={setProfileTargetId} />
        <GameRulebook key={`${rulebookGameId}-${rulebookOpen}`} open={rulebookOpen} initialGameId={rulebookGameId} onClose={() => setRulebookOpen(false)} />
        {profileTarget && <PlayerProfileModal key={profileTarget.id} profile={profileTarget} isOwn={profileTarget.id === identity.id} identity={identity} account={profileTarget.id === identity.id ? authAccount : null} inventoryIds={profileTarget.id === identity.id ? snapshot.viewerInventoryIds : []} cosmetics={snapshot.cosmetics} loading={loading} authBusy={authBusy} onClose={() => setProfileTargetId(null)} onSaveNickname={saveNickname} onCommand={command} onGoogleSignIn={signInWithGoogle} onSignOut={signOut} />}
        {adminOpen && <AdminModal role={snapshot.adminRole} loggedIn={Boolean(authAccount)} players={snapshot.moderationPlayers} feedback={snapshot.feedback} presence={snapshot.serverPresence} secondaryAdminCount={snapshot.secondaryAdminCount} command={command} onClose={() => setAdminOpen(false)} onLogin={signInWithGoogle} />}
        {feedbackOpen && <FeedbackModal command={command} previous={snapshot.feedback} onClose={() => setFeedbackOpen(false)} />}
        {unreadWarning && <WarningModal warning={unreadWarning} onAcknowledge={() => command("acknowledgeWarning", { warningId: unreadWarning.id })} />}
        {notice && <Toast message={notice} onClose={() => setNotice("")} />}
        {loading && <ActionLoading label={loadingLabel} />}
      </>
    );
  }

  return (
    <div className="platform-shell">
      {snapshot.announcement && <AnnouncementBanner key={snapshot.announcement.id} announcement={snapshot.announcement} />}
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
          <div className="topbar-title"><h1>게임 로비</h1><span className="online-pill"><i />현재 {snapshot.onlinePlayers.length || 1}명 접속 중</span>{onlineAdminCount > 0 && <span className="admin-online-pill"><i />관리자 {onlineAdminCount}명 접속</span>}</div>
          <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="방 이름 또는 게임 검색" /></label>
          <div className="top-actions">
            <button className="rulebook-trigger" onClick={() => { setRulebookGameId(gameFilter === "all" ? "gomoku" : gameFilter); setRulebookOpen(true); }}><span aria-hidden="true">▥</span><strong>게임 사전</strong></button>
            <button className="feedback-trigger" onClick={() => setFeedbackOpen(true)} aria-label="피드백"><span aria-hidden="true">✎</span><strong>피드백</strong></button>
            <button className="ranking-trigger" onClick={() => setRankingOpen(true)} aria-label="랭킹"><span aria-hidden="true">♛</span><strong>랭킹</strong></button>
            <button className={hasUnreadChat ? "icon-button has-unread" : "icon-button"} onClick={openChat} aria-label={hasUnreadChat ? "새 메시지 있음 · 채팅 열기" : "채팅 열기"}>▤<ChatUnreadDots global={hasUnreadGlobal} direct={hasUnreadDirect} /></button>
            {!authAccount && <button type="button" className="top-login-button" onClick={signInWithGoogle} disabled={authBusy} aria-label="Google 계정으로 로그인"><b aria-hidden="true">G</b><span>{authBusy ? "이동 중…" : "Google 로그인"}</span></button>}
            <button className={authAccount ? "profile-button" : "profile-button guest-profile"} onClick={() => setProfileTargetId(identity.id)} aria-label="내 프로필 열기"><ProfileAvatar nickname={identity.nickname} avatarUrl={authAccount?.avatarUrl} /><strong>{identity.nickname}</strong><AdminBadge role={snapshot.adminRole} /></button>
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
      <ChatDrawer open={chatOpen} onClose={closeChat} identity={identity} snapshot={snapshot} command={command} loggedIn={Boolean(authAccount)} onProfile={setProfileTargetId} />
      <GameRulebook key={`${rulebookGameId}-${rulebookOpen}`} open={rulebookOpen} initialGameId={rulebookGameId} onClose={() => setRulebookOpen(false)} />
      {rankingOpen && <LeaderboardModal entries={snapshot.leaderboard} identity={identity} loggedIn={Boolean(authAccount)} onClose={() => setRankingOpen(false)} onLogin={signInWithGoogle} onProfile={setProfileTargetId} />}
      {createOpen && <CreateRoomModal loading={loading} loggedIn={Boolean(authAccount)} onClose={() => setCreateOpen(false)} onCreate={async (payload) => { const result = await command("createRoom", payload); if (result?.roomId) setCreateOpen(false); }} />}
      {profileTarget && <PlayerProfileModal key={profileTarget.id} profile={profileTarget} isOwn={profileTarget.id === identity.id} identity={identity} account={profileTarget.id === identity.id ? authAccount : null} inventoryIds={profileTarget.id === identity.id ? snapshot.viewerInventoryIds : []} cosmetics={snapshot.cosmetics} loading={loading} authBusy={authBusy} onClose={() => setProfileTargetId(null)} onSaveNickname={saveNickname} onCommand={command} onGoogleSignIn={signInWithGoogle} onSignOut={signOut} />}
      {adminOpen && <AdminModal role={snapshot.adminRole} loggedIn={Boolean(authAccount)} players={snapshot.moderationPlayers} feedback={snapshot.feedback} presence={snapshot.serverPresence} secondaryAdminCount={snapshot.secondaryAdminCount} command={command} onClose={() => setAdminOpen(false)} onLogin={signInWithGoogle} />}
      {feedbackOpen && <FeedbackModal command={command} previous={snapshot.feedback} onClose={() => setFeedbackOpen(false)} />}
      {unreadWarning && <WarningModal warning={unreadWarning} onAcknowledge={() => command("acknowledgeWarning", { warningId: unreadWarning.id })} />}
      {joinTarget && <PasswordModal roomTitle={joinTarget.title} loading={loading} onClose={() => setJoinTarget(null)} onSubmit={(password) => enterRoom(joinTarget, password)} />}
      {notice && <Toast message={notice} onClose={() => setNotice("")} />}
      {loading && <ActionLoading label={loadingLabel} />}
    </div>
  );
}

function ProfileAvatar({ nickname, avatarUrl }: { nickname: string; avatarUrl?: string | null }) {
  return <span className={avatarUrl ? "profile-avatar has-image" : "profile-avatar"} style={avatarUrl ? { backgroundImage: `url(${JSON.stringify(avatarUrl)})` } : undefined}>{avatarUrl ? "" : nickname[0]}</span>;
}

function AdminBadge({ role }: { role: AdminRole }) {
  return role ? <span className={`admin-badge ${role}`}>{role === "master" ? "최고관리자" : "관리자"}</span> : null;
}

function AnnouncementBanner({ announcement }: { announcement: AnnouncementView }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const remaining = Math.max(0, Date.parse(announcement.expiresAt) - Date.now());
    const timer = window.setTimeout(() => setVisible(false), remaining);
    return () => window.clearTimeout(timer);
  }, [announcement.expiresAt]);
  if (!visible) return null;
  const long = announcement.body.length > 36;
  return <aside className="announcement-banner" role="status" aria-live="polite"><span className="announcement-label">공지</span><div className={long ? "announcement-copy long" : "announcement-copy"}><span>{announcement.body}</span></div><b>{announcement.issuerAdminRole === "master" ? "최고관리자" : "관리자"}</b></aside>;
}

function equippedItem(profile: PublicProfile, cosmetics: CosmeticItem[], kind: CosmeticKind) {
  return cosmetics.find((item) => item.id === profile.equipped[kind]);
}

function profileBackground(profile: PublicProfile) {
  if (profile.equipped.background === "background-grid") return { backgroundImage: "linear-gradient(rgba(96,165,250,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,.18) 1px, transparent 1px), linear-gradient(135deg,#172554,#1e293b)", backgroundSize: "24px 24px,24px 24px,auto" };
  if (profile.equipped.background === "background-sunset") return { backgroundImage: "linear-gradient(135deg,#7c2d12,#be123c 48%,#312e81)" };
  if (profile.equipped.background === "background-galaxy") return { backgroundImage: "radial-gradient(circle at 20% 20%,#a78bfa 0 2px,transparent 3px),radial-gradient(circle at 78% 35%,#fde68a 0 1px,transparent 2px),linear-gradient(135deg,#090a2a,#4c1d95,#0f172a)" };
  return undefined;
}

function PlayerProfileModal({ profile, isOwn, identity, account, inventoryIds, cosmetics, loading, authBusy, onClose, onSaveNickname, onCommand, onGoogleSignIn, onSignOut }: {
  profile: PublicProfile; isOwn: boolean; identity: Identity; account: AuthAccount | null; inventoryIds: string[]; cosmetics: CosmeticItem[];
  loading: boolean; authBusy: boolean; onClose: () => void; onSaveNickname: (nickname: string) => void;
  onCommand: (type: string, payload?: Record<string, unknown>) => Promise<unknown>; onGoogleSignIn: () => void; onSignOut: () => void;
}) {
  const [tab, setTab] = useState<"profile" | "closet" | "shop">("profile");
  const [nickname, setNickname] = useState(identity.nickname);
  const [statusMessage, setStatusMessage] = useState(profile.statusMessage);
  const [equipped, setEquipped] = useState(profile.equipped);
  const previewProfile: PublicProfile = { ...profile, statusMessage, equipped };
  const badge = equippedItem(previewProfile, cosmetics, "badge");
  const trophy = equippedItem(previewProfile, cosmetics, "trophy");
  const winRate = profile.career.total.played ? Math.round(profile.career.total.wins / profile.career.total.played * 100) : 0;
  const equipCosmetic = async (item: CosmeticItem) => {
    const previous = equipped;
    const next = { ...equipped, [item.kind]: item.id };
    setEquipped(next);
    const result = await onCommand("updateProfile", { statusMessage: profile.statusMessage, equipped: next });
    if (!result) setEquipped(previous);
  };
  const purchaseCosmetic = async (item: CosmeticItem) => {
    const result = await onCommand("purchaseCosmetic", { itemId: item.id });
    if (result) setEquipped((value) => ({ ...value, [item.kind]: item.id }));
  };
  const saveProfile = async () => {
    if (nickname.trim() !== identity.nickname) await onSaveNickname(nickname);
    if (account) await onCommand("updateProfile", { statusMessage, equipped });
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <div className="modal-head"><div><span className="eyebrow">PLAYER CARD</span><h2 id="profile-title">플레이어 프로필</h2></div><button type="button" onClick={onClose} aria-label="닫기">×</button></div>
        <div className="profile-hero" style={profileBackground(previewProfile)}>
          <div className="profile-avatar-xl"><ProfileAvatar nickname={profile.nickname} avatarUrl={isOwn ? account?.avatarUrl : null} />{badge && <span title={badge.name}>{badge.icon}</span>}</div>
          <div><div className="profile-name"><strong>{profile.nickname}</strong><AdminBadge role={profile.adminRole} /></div><p>{statusMessage || "아직 상태 메시지가 없어요."}</p><small>가입 {new Date(profile.createdAt).toLocaleDateString("ko-KR")}</small></div>
          {trophy && <b className="profile-trophy" title={trophy.name}>{trophy.icon}</b>}
        </div>
        <div className="profile-career"><div><strong>{profile.career.total.played}</strong><span>총 경기</span></div><div><strong>{profile.career.total.wins}</strong><span>승리</span></div><div><strong>{winRate}%</strong><span>승률</span></div><div><strong>{profile.infiniteCoins ? "∞" : profile.coins}</strong><span>코인</span></div></div>
        {isOwn && <div className="profile-tabs"><button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>내 정보</button><button className={tab === "closet" ? "active" : ""} onClick={() => setTab("closet")} disabled={!account}>옷장</button><button className={tab === "shop" ? "active" : ""} onClick={() => setTab("shop")} disabled={!account}>상점</button></div>}
        {isOwn && tab === "profile" && <>
          {!account && <button type="button" className="google-login-button" onClick={onGoogleSignIn} disabled={authBusy}><b aria-hidden="true">G</b>{authBusy ? "Google로 이동 중…" : "Google로 로그인하고 전적 저장"}</button>}
          <label>닉네임<input value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={14} /></label>
          <label>상태 메시지<input value={statusMessage} onChange={(event) => setStatusMessage(event.target.value)} maxLength={60} placeholder="지금 내 상태를 한 줄로 알려주세요" disabled={!account} /></label>
          {!account && <p className="modal-note">로그인하면 승리할 때마다 30코인을 받고 프로필을 꾸밀 수 있어요.</p>}
        </>}
        {isOwn && account && tab === "closet" && <><p className="closet-guide">아이템을 누르면 바로 장착되고 자동 저장됩니다.</p><div className="cosmetic-grid">{cosmetics.filter((item) => inventoryIds.includes(item.id)).map((item) => <button key={item.id} className={equipped[item.kind] === item.id ? "cosmetic-card equipped" : "cosmetic-card"} disabled={loading} onClick={() => void equipCosmetic(item)}><span style={{ color: item.accent }}>{item.icon}</span><strong>{item.name}</strong><small>{equipped[item.kind] === item.id ? "장착 중" : item.kind === "badge" ? "배지" : item.kind === "trophy" ? "트로피" : "배경"}</small></button>)}</div></>}
        {isOwn && account && tab === "shop" && <><p className="coin-guide">🪙 보유 코인 <strong>{profile.infiniteCoins ? "∞" : profile.coins}</strong> · {profile.infiniteCoins ? "최고 관리자는 코인이 차감되지 않습니다" : "게임에서 이기면 30코인"}</p><div className="cosmetic-grid shop">{cosmetics.filter((item) => item.price > 0).map((item) => { const owned = inventoryIds.includes(item.id); return <button key={item.id} className={owned ? "cosmetic-card owned" : "cosmetic-card"} disabled={loading || owned || (!profile.infiniteCoins && profile.coins < item.price)} onClick={() => void purchaseCosmetic(item)}><span style={{ color: item.accent }}>{item.icon}</span><strong>{item.name}</strong><small>{owned ? "보유 중" : profile.infiniteCoins ? "🪙 무료" : `🪙 ${item.price}`}</small></button>; })}</div></>}
        {!isOwn && <div className="game-record-list">{Object.entries(profile.career.games).map(([gameId, record]) => <div key={gameId}><span>{GAME_BY_ID[gameId as GameId].name}</span><strong>{record.wins}승 {record.draws}무 {record.losses}패</strong></div>)}{!Object.keys(profile.career.games).length && <p>아직 완료한 게임이 없어요.</p>}</div>}
        <div className="modal-actions profile-actions">{isOwn && account && <button type="button" className="text-button danger" onClick={onSignOut} disabled={authBusy}>로그아웃</button>}<span /><button type="button" className="secondary-button" onClick={onClose}>닫기</button>{isOwn && <button type="button" className="primary-button" onClick={saveProfile} disabled={loading || !nickname.trim()}>저장</button>}</div>
      </section>
    </div>
  );
}

function LeaderboardModal({ entries, identity, loggedIn, onClose, onLogin, onProfile }: {
  entries: LeaderboardEntry[]; identity: Identity; loggedIn: boolean; onClose: () => void; onLogin: () => void; onProfile: (id: string) => void;
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
            return <button type="button" onClick={() => onProfile(entry.playerId)} key={entry.playerId} className={entry.playerId === identity.id ? "leaderboard-row mine" : "leaderboard-row"}><b className={`rank-number rank-${index + 1}`}>{index + 1}</b><span className="rank-avatar">{entry.nickname[0]}</span><div><strong>{entry.nickname}{entry.playerId === identity.id && " (나)"}</strong><small>{tab === "overall" ? `${record.played}경기 · ${record.wins}승 ${record.draws}무 ${record.losses}패` : `${rankTier(ranked!.rating)} · ${record.wins}승 ${record.draws}무 ${record.losses}패`}</small></div><div className="rank-score"><strong>{tab === "overall" ? record.wins : ranked!.rating}</strong><span>{tab === "overall" ? "승" : "RP"}</span></div></button>;
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
  const participantOnly = room.persistent && room.participantLocked && !room.reservedForViewer;
  const actionLabel = participantOnly
    ? "참가자 전용"
    : room.persistent && room.reservedForViewer
      ? "이어두기"
      : room.status === "waiting"
        ? "입장"
        : "관전";
  return (
    <article className={`${room.status === "playing" ? "room-card playing" : "room-card"} ${room.persistent ? "persistent" : ""}`}>
      <div className="room-art" style={{ background: game.accent }}><span>{game.icon}</span></div>
      <div className="room-info">
        <div className="room-tags"><span className="game-tag">{game.name}</span>{room.settings.ranked && <span className="ranked-tag">RANKED</span>}{room.persistent && <span className="saved-tag">24H 저장</span>}<span className={`status-tag ${room.status}`}>{room.status === "waiting" ? "대기 중" : "게임 중"}</span>{room.locked && <span title="비밀번호 방">🔒</span>}</div>
        <h3>{room.title}</h3>
        <div className="room-meta"><span className="host-avatar">{room.hostName[0]}</span><span>{room.hostName}</span><span>♙ {room.memberCount} / {room.capacity}</span><span>◷ {game.playTime}</span>{room.persistent && <span>접속 {room.onlineCount}명</span>}</div>
      </div>
      <button className={room.status === "waiting" || room.reservedForViewer ? "join-button" : "watch-button"} onClick={onJoin} disabled={participantOnly}>{actionLabel}</button>
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
  const requiresLogin = gameId === "go";
  const roundOptions = gameId === "same-answer" ? [5, 10] : [3, 5, 7, 10];
  return (
    <div className="modal-backdrop" onMouseDown={(event) => !loading && event.target === event.currentTarget && onClose()}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div className="modal-head"><div><span className="eyebrow">새로운 게임</span><h2 id="create-title">방 만들기</h2></div><button onClick={onClose} aria-label="닫기">×</button></div>
        <label>게임 선택<select value={gameId} onChange={(event) => { const nextGameId = event.target.value as GameId; setGameId(nextGameId); if (!isRankedGame(nextGameId)) setRanked(false); if (nextGameId === "same-answer" && rounds !== 5 && rounds !== 10) setRounds(5); }}>{GAME_CATALOG.map((item) => <option key={item.id} value={item.id}>{item.name} · {playerCountLabel(item)}</option>)}</select></label>
        <div className="selected-game"><span style={{ background: game.accent }}>{game.icon}</span><div><strong>{game.name}</strong><p>{game.description} · 예상 {game.playTime}</p></div></div>
        {supportsRanked && <button type="button" className={ranked ? "ranked-mode-card selected" : "ranked-mode-card"} disabled={!loggedIn} onClick={() => { setRanked((value) => !value); setPassword(""); }}><span>♛</span><div><strong>랭크전 {ranked ? "ON" : "OFF"}</strong><small>{loggedIn ? "완료된 경기의 승패와 RP가 기록됩니다." : "Google 로그인 후 선택할 수 있습니다."}</small></div><i>{ranked ? "선택됨" : "선택"}</i></button>}
        {supportsRounds && <label>라운드 수<select value={rounds} onChange={(event) => setRounds(Number(event.target.value))}>{roundOptions.map((count) => <option key={count} value={count}>{count}라운드</option>)}</select></label>}
        <label>방 제목<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={30} placeholder={`${game.name} 같이 해요`} /></label>
        <label>비밀번호 <small>{ranked ? "랭크전은 공개방" : "선택"}</small><input value={password} onChange={(event) => setPassword(event.target.value)} disabled={ranked} maxLength={40} type="password" placeholder={ranked ? "랭크전에서는 사용할 수 없어요" : "비워두면 공개 방"} /></label>
        <p className="modal-note">{requiresLogin ? loggedIn ? "바둑판과 참가자 2명이 서버에 저장됩니다. 두 사람 모두 나간 뒤 24시간 동안 돌아오지 않으면 방이 삭제됩니다." : "바둑 이어두기 방은 Google 로그인이 필요합니다." : ranked ? "로그인한 플레이어 2명이 참가해야 시작할 수 있으며, 중단된 경기는 기록되지 않습니다." : "방에는 최대 10명까지 들어올 수 있으며, 남는 인원은 관전합니다."}</p>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={loading}>취소</button><button className="primary-button" disabled={loading || (requiresLogin && !loggedIn)} onClick={() => onCreate({ gameId, title, password, settings: { ...(supportsRounds ? { rounds } : {}), ...(ranked ? { ranked: true } : {}) } })}>{loading ? "만드는 중…" : requiresLogin && !loggedIn ? "로그인 필요" : ranked ? "랭크방 만들기" : "방 만들기"}</button></div>
      </div>
    </div>
  );
}

function ChatUnreadDots({ global, direct }: { global: boolean; direct: boolean }) {
  return <>{global && <i className="chat-unread-dot global" title="새 전체 채팅" />}{direct && <i className="chat-unread-dot direct" title="새 개인 메시지" />}</>;
}

function RoomView({ room, identity, loading, syncing, onLeave, onStart, onAction, onChat, onRules, onProfile, hasUnreadGlobal, hasUnreadDirect }: {
  room: ActiveRoom; identity: Identity; loading: boolean; syncing: boolean; onLeave: () => void; onStart: () => void;
  onAction: (command: Omit<GameCommand, "playerId">) => Promise<unknown>; onChat: () => void; onRules: () => void; onProfile: (id: string) => void; hasUnreadGlobal: boolean; hasUnreadDirect: boolean;
}) {
  const gameInfo = GAME_BY_ID[room.gameId];
  const isHost = room.hostId === identity.id;
  const canStart = isHost || (room.persistent && room.reservedForViewer);
  const hasUnreadChat = hasUnreadGlobal || hasUnreadDirect;
  return (
    <div className="room-screen">
      <header className="room-topbar">
        <button className="back-button" onClick={onLeave}>← 로비</button>
        <div><span className="eyebrow">{room.settings.ranked ? `RANKED · ${gameInfo.name}` : gameInfo.name}</span><h1>{room.title}</h1></div>
        <div className="room-top-actions"><span>{room.members.length}/{room.capacity}명</span><span className={syncing ? "room-sync active" : "room-sync"} aria-live="polite"><i />{syncing ? "저장 중" : room.persistent ? "자동 저장됨" : "연결됨"}</span><button className="rulebook-trigger compact" onClick={onRules} aria-label={`${gameInfo.name} 규칙 보기`}><span aria-hidden="true">▥</span></button><button className={hasUnreadChat ? "icon-button has-unread" : "icon-button"} onClick={onChat} aria-label={hasUnreadChat ? "새 메시지 있음 · 채팅 열기" : "채팅 열기"}>▤<ChatUnreadDots global={hasUnreadGlobal} direct={hasUnreadDirect} /></button></div>
      </header>
      <main className="room-layout">
        <aside className="member-panel">
          {room.settings.ranked && <div className="ranked-room-banner"><span>♛</span><div><strong>랭크전</strong><small>승패와 RP가 반영됩니다</small></div></div>}
          {room.persistent && <div className="saved-room-banner"><span>☁</span><div><strong>이어두기 자동 저장</strong><small>마지막 접속 뒤 24시간 보관</small></div></div>}
          <div className="member-title"><h2>참가자</h2><span>{room.members.filter((member) => member.role === "player").length}/{gameInfo.maxPlayers}</span></div>
          <div className="member-list">{room.members.map((member) => <button type="button" onClick={() => onProfile(member.id)} className={`member-row ${member.online === false ? "offline" : ""}`} key={member.id}><span className="member-avatar">{member.name[0]}</span><div><strong>{member.name}{member.id === identity.id && " (나)"} <AdminBadge role={member.adminRole} /></strong><small>{member.id === room.hostId ? "방장" : member.role === "player" ? "플레이어" : "관전자"}{room.persistent ? member.online === false ? " · 오프라인" : " · 접속 중" : ""}</small></div></button>)}</div>
          {!room.game && canStart && <button className="primary-button full-button" onClick={onStart} disabled={loading || room.playerCount < gameInfo.minPlayers}>게임 시작</button>}
          {!room.game && !canStart && <p className="waiting-copy">방장이 게임을 준비하고 있어요.</p>}
        </aside>
        <section className="game-panel">
          {room.game ? <GameStage game={room.game} revision={room.revision} playerId={identity.id} viewerRole={room.viewerRole} onAction={onAction} /> : <div className="game-waiting"><div className="big-game-icon" style={{ background: gameInfo.accent }}>{gameInfo.icon}</div><span className="eyebrow">{room.settings.ranked ? "♛ 랭크전 · 로그인 2명" : playerCountLabel(gameInfo)} · 예상 {gameInfo.playTime}{room.settings.rounds ? ` · ${room.settings.rounds}라운드` : ""}</span><h2>{gameInfo.name}</h2><p>{room.settings.ranked ? "승리하면 RP가 오르고 패배하면 내려갑니다. 중단 경기는 기록되지 않습니다." : gameInfo.description}</p><button className="waiting-rules" onClick={onRules}>▥ 규칙 먼저 보기</button></div>}
        </section>
      </main>
    </div>
  );
}

function ChatDrawer({ open, onClose, identity, snapshot, command, loggedIn, onProfile }: {
  open: boolean; onClose: () => void; identity: Identity; snapshot: Snapshot;
  command: (type: string, payload?: Record<string, unknown>) => Promise<unknown>;
  loggedIn: boolean; onProfile: (id: string) => void;
}) {
  const [tab, setTab] = useState<"global" | "direct">("global");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const target = snapshot.directContacts.find((player) => player.id === targetId);
  const contacts = snapshot.directContacts.filter((player) => player.nickname.includes(userSearch.trim()));
  const messages = tab === "global" ? snapshot.globalMessages : snapshot.directMessages.filter((message) => targetId && ((message.senderId === identity.id && message.recipientId === targetId) || (message.senderId === targetId && message.recipientId === identity.id)));
  const send = async () => {
    const messageBody = body.trim();
    const recipientId = targetId;
    const messageTab = tab;
    if (!messageBody || sendingRef.current || (messageTab === "direct" && !recipientId)) return;
    sendingRef.current = true;
    setSending(true);
    setBody("");
    try {
      if (messageTab === "global") await command("sendGlobal", { body: messageBody });
      else await command("sendDirect", { recipientId, body: messageBody });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const togglePin = async (contactId: string) => {
    await command("toggleDirectPin", { targetId: contactId });
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
        <div className="chat-tabs"><button className={tab === "global" ? "active global" : "global"} onClick={() => setTab("global")}><i />전체 채팅</button><button className={tab === "direct" ? "active direct" : "direct"} onClick={() => setTab("direct")}><i />개인 메시지</button></div>
        {tab === "direct" && !targetId && <div className="people-picker"><input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="닉네임으로 사용자 검색" />{!loggedIn && <p className="pin-login-note">📌 대화 상대 고정은 Google 로그인 후 사용할 수 있어요.</p>}{contacts.map((player) => <div className={`person-row ${player.pinned ? "pinned" : ""}`} key={player.id}><button className="person-open" onClick={() => setTargetId(player.id)}><i className={player.online ? "online" : "offline"} /><span>{player.pinned && "📌 "}{player.nickname}</span><small>{player.online ? "온라인" : "오프라인"}</small></button>{loggedIn && <button className="person-pin" title={player.pinned ? "고정 해제" : "대화 상대 고정"} aria-label={`${player.nickname} ${player.pinned ? "고정 해제" : "고정"}`} onClick={() => void togglePin(player.id)}>{player.pinned ? "★" : "☆"}</button>}</div>)}{!contacts.length && <div className="empty-chat compact">검색 결과가 없어요.</div>}</div>}
        {tab === "direct" && targetId && <div className="dm-target-row"><button className="dm-target" onClick={() => setTargetId(null)}>← {target?.nickname ?? messages.at(-1)?.recipientName ?? messages.at(-1)?.senderName ?? "대화 상대"}</button>{loggedIn && <button className={snapshot.pinnedDirectIds.includes(targetId) ? "dm-pin active" : "dm-pin"} onClick={() => void togglePin(targetId)}>{snapshot.pinnedDirectIds.includes(targetId) ? "★ 고정됨" : "☆ 고정"}</button>}</div>}
        {(tab === "global" || targetId) && <>
          <div className="message-list">{messages.length ? messages.map((message) => <div className={`${message.senderId === identity.id ? "message own" : "message"} ${message.deletedAt ? "deleted" : ""}`} key={message.id}><div><button type="button" className="message-sender" onClick={() => onProfile(message.senderId)}>{message.senderId === identity.id ? "나" : message.senderName}</button><AdminBadge role={message.senderAdminRole} /><time>{new Date(message.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time>{snapshot.adminRole && !message.deletedAt && <button type="button" className="message-delete" onClick={() => command("deleteMessage", { messageId: message.id })}>삭제</button>}</div><p>{message.body}</p></div>) : <div className="empty-chat">아직 메시지가 없어요.</div>}</div>
          <form className="chat-compose" onSubmit={(event) => { event.preventDefault(); void send(); }}><input value={body} onChange={(event) => setBody(event.target.value)} maxLength={200} disabled={sending} placeholder={sending ? "전송 중…" : "메시지를 입력하세요"} /><button aria-label="보내기" disabled={sending || !body.trim()}>➤</button></form>
        </>}
      </aside>
    </>
  );
}

function AdminModal({ role, loggedIn, players, feedback, presence, secondaryAdminCount, command, onClose, onLogin }: {
  role: AdminRole; loggedIn: boolean; players: ModerationPlayer[]; feedback: FeedbackView[]; presence: ServerPresence[]; secondaryAdminCount: number;
  command: (type: string, payload?: Record<string, unknown>) => Promise<unknown>; onClose: () => void; onLogin: () => void;
}) {
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [coinAmount, setCoinAmount] = useState("100");
  const [tab, setTab] = useState<"players" | "operations" | "feedback" | "security">("operations");
  const shownPlayers = players.filter((player) => player.nickname.toLowerCase().includes(search.trim().toLowerCase()));
  const act = async (type: string, payload: Record<string, unknown>) => {
    const result = await command(type, payload);
    if (result && type === "claimMasterAdmin") setPassword("");
    if (result && type === "sendAnnouncement") setAnnouncement("");
  };
  return (
    <div className="modal-backdrop admin-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-title">
        <div className="modal-head"><div><span className="eyebrow">SECRET CONTROL · CTRL + ENTER</span><h2 id="admin-title">관리자 제어실</h2></div><button onClick={onClose} aria-label="닫기">×</button></div>
        {!loggedIn ? <div className="admin-gate"><span>⌁</span><strong>로그인된 계정이 필요합니다</strong><p>관리자 권한은 Google 계정에 연결되어 저장됩니다.</p><button className="google-login-button" onClick={onLogin}><b>G</b>Google 로그인</button></div>
          : !role ? <form className="admin-gate" onSubmit={(event) => { event.preventDefault(); void act("claimMasterAdmin", { password }); }}><span>⌁</span><strong>최고관리자 권한 가져오기</strong><p>비밀번호가 맞으면 기존 최고관리자 권한은 이 계정으로 이전됩니다.</p><input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={64} placeholder="관리자 비밀번호" /><button className="primary-button" disabled={!password}>확인</button></form>
            : <>
              <div className="admin-session"><AdminBadge role={role} /><span>{role === "master" ? "코인 지급·권한 회수·밴을 포함한 모든 기능을 사용할 수 있습니다." : "접속자 확인·공지·경고·채팅 관리가 가능합니다."}</span></div>
              <div className="profile-tabs admin-tabs"><button className={tab === "operations" ? "active" : ""} onClick={() => setTab("operations")}>서버 운영</button><button className={tab === "players" ? "active" : ""} onClick={() => setTab("players")}>플레이어</button><button className={tab === "feedback" ? "active" : ""} onClick={() => setTab("feedback")}>피드백</button>{role === "master" && <button className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}>보안</button>}</div>
              {tab === "operations" && <div className="admin-operations"><form className="announcement-form" onSubmit={(event) => { event.preventDefault(); void act("sendAnnouncement", { body: announcement }); }}><div><strong>서버 공지</strong><small>모든 화면 상단에 1분 동안 표시 · 공지 쿨타임 1분</small></div><textarea value={announcement} onChange={(event) => setAnnouncement(event.target.value)} maxLength={200} placeholder="게임 중인 플레이어에게도 방해되지 않게 표시됩니다." /><button className="primary-button" disabled={announcement.trim().length < 2}>공지 보내기</button></form><div className="presence-head"><div><strong>현재 접속자</strong><small>{presence.length}명 접속 중</small></div><span>실시간</span></div><div className="server-presence-list">{presence.length ? presence.map((player) => <article key={player.id}><i className="presence-dot" /><div><strong>{player.nickname} <AdminBadge role={player.adminRole} /></strong><small>{player.loggedIn ? "Google 계정" : "게스트"} · {player.room ? `${GAME_BY_ID[player.room.gameId].name} ${player.room.status === "playing" ? "게임 중" : "대기 중"}` : "로비"}</small></div><time>{new Date(player.lastSeen).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time></article>) : <div className="empty-chat compact">현재 접속자가 없어요.</div>}</div></div>}
              {tab === "players" && <><div className="admin-player-tools"><input className="admin-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="닉네임 검색" />{role === "master" && <label>지급 코인<input type="number" min="1" max="100000" value={coinAmount} onChange={(event) => setCoinAmount(event.target.value)} /></label>}</div><div className="admin-limit"><span>파란 관리자 <b>{secondaryAdminCount}</b>/10명</span><small>최고 관리자는 언제든 권한을 회수할 수 있습니다.</small></div><input className="admin-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={120} placeholder="경고·밴 사유를 먼저 입력하세요" /><div className="admin-player-list">{shownPlayers.map((player) => <article key={player.id}><div className="admin-player-name"><span>{player.nickname[0]}</span><div><strong>{player.nickname} <AdminBadge role={player.adminRole} /></strong><small>{player.career.total.wins}승 · 🪙 {player.infiniteCoins ? "∞" : player.coins} · 경고 {player.warningCount}회{player.banned ? " · 밴됨" : ""}</small></div></div><div className="admin-row-actions"><button onClick={() => void act("warnPlayer", { targetId: player.id, message: reason })}>경고</button>{role === "master" && player.id.startsWith("user_") && player.adminRole !== "master" && <button disabled={player.adminRole !== "admin" && secondaryAdminCount >= 10} onClick={() => void act("setSecondaryAdmin", { targetId: player.id, enabled: player.adminRole !== "admin" })}>{player.adminRole === "admin" ? "관리자 회수" : "관리자 지정"}</button>}{role === "master" && player.id.startsWith("user_") && <button onClick={() => void act("grantCoins", { targetId: player.id, amount: Number(coinAmount) })}>코인 지급</button>}{role === "master" && player.adminRole !== "master" && <button className={player.banned ? "safe" : "danger"} onClick={() => void act("setPlayerBan", { targetId: player.id, banned: !player.banned, reason })}>{player.banned ? "밴 해제" : "밴"}</button>}</div></article>)}</div></>}
              {tab === "feedback" && <div className="feedback-admin-list">{feedback.length ? feedback.map((item) => <article key={item.id} className={item.resolvedAt ? "resolved" : ""}><div><b>{item.category === "bug" ? "버그" : item.category === "idea" ? "아이디어" : "기타"}</b><strong>{item.nickname ?? "플레이어"}</strong><time>{new Date(item.createdAt).toLocaleDateString("ko-KR")}</time></div><p>{item.body}</p><button onClick={() => void act("resolveFeedback", { feedbackId: item.id, resolved: !item.resolvedAt })}>{item.resolvedAt ? "다시 열기" : "처리 완료"}</button></article>) : <div className="empty-chat compact">도착한 피드백이 없어요.</div>}</div>}
              {tab === "security" && role === "master" && <form className="admin-password-form" onSubmit={(event) => { event.preventDefault(); void act("changeAdminPassword", { currentPassword, newPassword }); }}><strong>관리자 비밀번호 변경</strong><p>다음 Ctrl+Enter 로그인부터 새 비밀번호를 사용합니다.</p><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="현재 비밀번호" /><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="새 비밀번호 (4글자 이상)" /><button className="primary-button" disabled={!currentPassword || newPassword.length < 4}>비밀번호 변경</button></form>}
            </>}
      </section>
    </div>
  );
}

function FeedbackModal({ command, previous, onClose }: {
  command: (type: string, payload?: Record<string, unknown>) => Promise<unknown>; previous: FeedbackView[]; onClose: () => void;
}) {
  const [category, setCategory] = useState<FeedbackRecord["category"]>("idea");
  const [body, setBody] = useState("");
  const send = async () => {
    const result = await command("submitFeedback", { category, body });
    if (result) { setBody(""); onClose(); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal-card feedback-modal" role="dialog" aria-modal="true"><div className="modal-head"><div><span className="eyebrow">TELL US</span><h2>피드백 보내기</h2></div><button onClick={onClose}>×</button></div><p>불편한 점이나 새 게임 아이디어를 남겨주세요. 관리자가 확인할 수 있어요.</p><label>종류<select value={category} onChange={(event) => setCategory(event.target.value as FeedbackRecord["category"])}><option value="idea">아이디어</option><option value="bug">버그 신고</option><option value="other">기타</option></select></label><label>내용<textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={500} placeholder="어떤 점을 바꾸면 더 재미있을까요?" /></label>{previous.length > 0 && <small className="feedback-history">내가 보낸 피드백 {previous.length}개가 저장되어 있어요.</small>}<div className="modal-actions"><button className="secondary-button" onClick={onClose}>취소</button><button className="primary-button" onClick={send} disabled={body.trim().length < 4}>보내기</button></div></section></div>;
}

function WarningModal({ warning, onAcknowledge }: { warning: WarningRecord; onAcknowledge: () => Promise<unknown> }) {
  return <div className="modal-backdrop warning-backdrop"><section className="modal-card warning-modal" role="alertdialog" aria-modal="true"><span className="warning-icon">!</span><span className="eyebrow">ADMIN WARNING</span><h2>관리자 경고를 받았습니다</h2><p>{warning.message}</p><small>{new Date(warning.createdAt).toLocaleString("ko-KR")}</small><button className="primary-button" onClick={() => void onAcknowledge()}>확인했습니다</button></section></div>;
}

function BanScreen({ reason, onSignOut }: { reason: string; onSignOut?: () => void }) {
  return <main className="ban-screen"><section><span>×</span><p className="eyebrow">ACCESS RESTRICTED</p><h1>이 계정은 이용할 수 없습니다</h1><p>{reason}</p>{onSignOut && <button className="secondary-button" onClick={onSignOut}>다른 계정으로 로그인</button>}</section></main>;
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
