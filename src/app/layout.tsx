import type { Metadata } from "next";
import ChakraProvider from "./Providers/ChakraProvider";
import { Footer } from "./components/Footer";
import "./globals.css";
export const metadata: Metadata = {
  title: "Ask WRI",
  description:
    "Find relevant publications for your research from across WRI, highlight specific passages, and generate citations in your chosen format.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <ChakraProvider>
          {children}
          <Footer />
        </ChakraProvider>
      </body>
    </html>
  );
}
