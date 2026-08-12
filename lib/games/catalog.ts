export type GameId =
  | "gomoku"
  | "go"
  | "word-chain"
  | "drawing"
  | "chosung"
  | "same-answer"
  | "liar"
  | "connect-four"
  | "chess"
  | "uno"
  | "yut"
  | "davinci-code"
  | "rummikub"
  | "word-defense";

export type GameInfo = {
  id: GameId;
  name: string;
  shortName: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  playTime: string;
  accent: string;
  icon: string;
};

const ALL_GAMES: GameInfo[] = [
  {
    id: "gomoku",
    name: "오목",
    shortName: "오목",
    description: "돌 다섯 개를 먼저 이으면 승리",
    minPlayers: 2,
    maxPlayers: 2,
    playTime: "5~15분",
    accent: "#facc15",
    icon: "●○",
  },
  {
    id: "go",
    name: "바둑",
    shortName: "바둑",
    description: "하루 동안 이어 두는 로그인 전용 19줄 바둑",
    minPlayers: 2,
    maxPlayers: 2,
    playTime: "30분~수일",
    accent: "#84a98c",
    icon: "●\n○",
  },
  {
    id: "word-chain",
    name: "끝말잇기",
    shortName: "끝말잇기",
    description: "마지막 글자로 단어를 이어가기",
    minPlayers: 2,
    maxPlayers: 10,
    playTime: "5~15분",
    accent: "#38bdf8",
    icon: "사↻과",
  },
  {
    id: "drawing",
    name: "그림 맞히기",
    shortName: "그림",
    description: "그림을 그리고 가장 먼저 정답 맞히기",
    minPlayers: 3,
    maxPlayers: 10,
    playTime: "5~15분",
    accent: "#fb7185",
    icon: "✎",
  },
  {
    id: "chosung",
    name: "초성 퀴즈",
    shortName: "초성",
    description: "시간이 흐를수록 공개되는 힌트 퀴즈",
    minPlayers: 2,
    maxPlayers: 10,
    playTime: "5~10분",
    accent: "#60a5fa",
    icon: "ㄱㄴㄷ",
  },
  {
    id: "same-answer",
    name: "같은 답 피하기",
    shortName: "답 피하기",
    description: "남들과 겹치지 않는 보기를 골라 점수 얻기",
    minPlayers: 3,
    maxPlayers: 10,
    playTime: "5~10분",
    accent: "#c084fc",
    icon: "≠",
  },
  {
    id: "liar",
    name: "라이어 게임",
    shortName: "라이어",
    description: "같은 단어 사이에 숨은 라이어 찾기",
    minPlayers: 4,
    maxPlayers: 10,
    playTime: "10~20분",
    accent: "#f43f5e",
    icon: "◉◉◉",
  },
  {
    id: "connect-four",
    name: "사목",
    shortName: "사목",
    description: "떨어뜨린 돌 네 개를 먼저 연결",
    minPlayers: 2,
    maxPlayers: 2,
    playTime: "3~10분",
    accent: "#f97316",
    icon: "●●\n●●",
  },
  {
    id: "chess",
    name: "체스",
    shortName: "체스",
    description: "체크메이트와 캐슬링이 적용되는 정식 체스",
    minPlayers: 2,
    maxPlayers: 2,
    playTime: "10~45분",
    accent: "#94a3b8",
    icon: "♞",
  },
  {
    id: "uno",
    name: "우노",
    shortName: "우노",
    description: "같은 색이나 숫자의 카드를 먼저 모두 내기",
    minPlayers: 2,
    maxPlayers: 10,
    playTime: "10~30분",
    accent: "#ef4444",
    icon: "↻7",
  },
  {
    id: "yut",
    name: "윷놀이",
    shortName: "윷놀이",
    description: "윷을 던져 네 개의 말을 먼저 완주시키기",
    minPlayers: 2,
    maxPlayers: 4,
    playTime: "15~30분",
    accent: "#f59e0b",
    icon: "윷",
  },
  {
    id: "davinci-code",
    name: "다빈치 코드",
    shortName: "다빈치",
    description: "단서를 모아 상대의 숨겨진 숫자 맞히기",
    minPlayers: 2,
    maxPlayers: 4,
    playTime: "5~20분",
    accent: "#94a3b8",
    icon: "◆7",
  },
  {
    id: "rummikub",
    name: "루미큐브",
    shortName: "루미큐브",
    description: "숫자 타일을 조합하고 재배치해 내 패를 먼저 비우기",
    minPlayers: 2,
    maxPlayers: 4,
    playTime: "20~45분",
    accent: "#14b8a6",
    icon: "7·8·9",
  },
  {
    id: "word-defense",
    name: "협동 키보드 디펜스",
    shortName: "키보드 디펜스",
    description: "떨어지는 단어를 함께 입력해 3분 동안 기지를 방어",
    minPlayers: 2,
    maxPlayers: 8,
    playTime: "3분",
    accent: "#8b5cf6",
    icon: "⌨⚡",
  },
];

// 보류한 게임은 엔진을 보존한 채 로비와 새 방 만들기에서만 숨긴다.
const HIDDEN_GAME_IDS = new Set<GameId>(["word-chain", "yut"]);
export const GAME_CATALOG = ALL_GAMES.filter((game) => !HIDDEN_GAME_IDS.has(game.id));

export function isGameAvailable(gameId: string): gameId is GameId {
  return GAME_CATALOG.some((game) => game.id === gameId);
}

export const GAME_BY_ID = Object.fromEntries(
  ALL_GAMES.map((game) => [game.id, game]),
) as Record<GameId, GameInfo>;
