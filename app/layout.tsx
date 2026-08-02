import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "게임 로비",
  description: "친구들과 가볍게 즐기는 온라인 미니게임 로비",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "게임 로비",
    description: "방을 만들고 친구들과 아홉 가지 미니게임을 즐겨보세요.",
    type: "website",
    locale: "ko_KR",
    images: [{ url: "/og.png", width: 1536, height: 1024, alt: "여러 미니게임을 함께 즐기는 게임 로비" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "게임 로비",
    description: "친구들과 가볍게 즐기는 온라인 미니게임 로비",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
