'use client'

import { usePathname } from 'next/navigation'
import { Footer } from '.'

/**
 * The public WRI footer, suppressed under /admin.
 *
 * The root layout renders one footer for every route, but the admin shell
 * (app/admin/layout.tsx) is a full-height flex column with a footer of its own.
 * Rendering both put the WRI footer on top of the admin one: the admin footer's
 * "Admin Guide" link was visually garbled and unclickable because the public
 * footer covered it.
 *
 * Suppressing rather than moving the render keeps every non-admin route
 * unchanged — the footer stays in the root layout where the public pages expect
 * it, and no page has to remember to add it.
 */
export const SiteFooter = () => {
  const pathname = usePathname()
  if (pathname?.startsWith('/admin')) return null
  return <Footer />
}

export default SiteFooter
