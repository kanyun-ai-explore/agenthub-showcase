import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./mobile.css";

export const metadata: Metadata = {
  title: "AgentHub Showcase",
  description: "在 AgentHub 上真实跑起来的 Agent：电商导购与商家助手、在线教育的 AI 教研团队。手机里的每一步都是真实调用。",
  icons: { icon: "/brand/agenthub-mark-192.png" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
