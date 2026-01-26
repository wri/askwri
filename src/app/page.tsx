"use client";
import { Heading } from "@chakra-ui/react";
import { WriLogoIcon } from "@/app/components/icons/WriLogo";

export default function HomePage() {
  return (
    <main>
      <section className="text-center">
        <WriLogoIcon height="100px" />
        <Heading size="4xl">Ask WRI</Heading>
      </section>
    </main>
  );
}
