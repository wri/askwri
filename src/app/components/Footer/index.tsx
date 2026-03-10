'use client'

import Link from 'next/link'
import { Footer as WriFooter } from '@worldresources/wri-design-systems'

export const Footer = () => (
  <WriFooter filled={false}>
    <Link
      target='_blank'
      href='https://www.wri.org/about/privacy-policy'
      rel='noopener noreferrer'
    >
      Privacy policy
    </Link>
    <Link
      target='_blank'
      href='https://www.wri.org/about/legal/general-terms-use'
      rel='noopener noreferrer'
    >
      Terms of service
    </Link>
    <Link
      target='_blank'
      href='https://gfw.atlassian.net/wiki/external/YzBhMzJlMmExNWE3NDU3MjkwYWFiYzQ4YTNlMGQ0MWY'
      rel='noopener noreferrer'
    >
      Methodology
    </Link>
  </WriFooter>
)
