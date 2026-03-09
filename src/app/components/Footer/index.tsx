'use client'

import Link from 'next/link'
import { Footer as WriFooter } from '@worldresources/wri-design-systems'

export const Footer = () => (
  <WriFooter filled={false}>
    <Link target='_blank' href='https://www.wri.org/about/privacy-policy'>
      Privacy policy
    </Link>
    <Link
      target='_blank'
      href='https://www.wri.org/about/legal/general-terms-use'
    >
      Terms of service
    </Link>
    <Link
      target='_blank'
      href='https://gfw.atlassian.net/wiki/external/YzBhMzJlMmExNWE3NDU3MjkwYWFiYzQ4YTNlMGQ0MWY'
    >
      Methodology
    </Link>
  </WriFooter>
)
