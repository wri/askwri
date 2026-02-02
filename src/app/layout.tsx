import type { Metadata } from "next";
import type { ReactNode } from "react";
import ChakraProvider from "./Providers/ChakraProvider";
import { Footer } from "./components/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ask WRI",
  description:
    "Find relevant publications for your research from across WRI, highlight specific passages, and generate citations in your chosen format.",
};

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <body>
      <ChakraProvider>
        {children}
        <Footer />
      </ChakraProvider>
    </body>
  </html>
);

export default RootLayout;
