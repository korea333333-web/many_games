import type { Metadata } from "next";
import { GamePlatform } from "./components/GamePlatform";

export const metadata: Metadata = {
  title: "게임 로비",
  description: "친구들과 가볍게 즐기는 온라인 미니게임 로비",
};

export default function Home() {
  return <GamePlatform />;
}
