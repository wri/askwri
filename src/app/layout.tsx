import type { Metadata } from "next";
import "./globals.css";
import Providers from "./Providers";

export const metadata: Metadata = {
  title: "Next.js ECS App",
  description: "A Next.js application deployed on AWS ECS Fargate",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers> {children} </Providers>
      </body>
    </html>
  );
}
