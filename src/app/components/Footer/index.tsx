"use client";

import Link from "next/link";
import { Footer as WriFooter } from "@worldresources/wri-design-systems";

export const Footer = () => (
  <WriFooter filled={false}>
    <Link href="https://www.wri.org/privacy-policy">Privacy policy</Link>
    <Link href="https://www.wri.org/terms-of-use">Terms of service</Link>
    <Link href="https://www.wri.org/methodology">Methodology</Link>
  </WriFooter>
);
