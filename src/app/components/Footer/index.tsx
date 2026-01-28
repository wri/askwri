"use client";

import Link from "next/link";
import { Footer as WriFooter } from "@worldresources/wri-design-systems";

export const Footer = () => {
  return (
    <WriFooter filled={false} fixed>
      <Link href="">Privacy policy</Link>
      <Link href="">Terms of service</Link>
      <Link href="">Methodology</Link>
    </WriFooter>
  );
};
