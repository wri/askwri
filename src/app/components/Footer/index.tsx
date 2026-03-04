'use client'

import Link from 'next/link'
import { Footer as WriFooter } from '@worldresources/wri-design-systems'

export const Footer = () => (
  <WriFooter filled={false}>
    <Link href='https://www.wri.org/about/privacy-policy'>Privacy policy</Link>
    <Link href='https://www.wri.org/about/legal/general-terms-use'>
      Terms of service
    </Link>
    <Link href='https://gfw.atlassian.net/wiki/pages/resumedraft.action?draftId=2762145800&draftShareId=a970c169-8d79-43c9-a949-bf62acd52855'>
      Methodology
    </Link>
  </WriFooter>
)
