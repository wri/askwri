"use client";
import { Heading } from "@chakra-ui/react";
import { WriLogoIcon } from "./components/icons/WriLogo";

export default function HomePage() {
  return (
    <main>
      <section style={{ textAlign: "center", marginTop: "100px" }}>
        <WriLogoIcon height="100px" />
        <Heading size="4xl">Ask WRI</Heading>
      </section>
    </main>
  );
}
