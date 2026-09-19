'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Button, Navbar as WriNavbar } from '@worldresources/wri-design-systems'
import { FiPlus } from 'react-icons/fi'
import { WriLogoIcon } from '../icons/WriLogo'

const Navbar = ({
  query,
  newSearchHref = '/',
}: {
  query: string
  /** Where "New search" starts over. `/experts` is its own search surface
   *  (spec §7), so sending its users to the research home would drop them out
   *  of experts mode through the one control that most obviously means
   *  "start again here". */
  newSearchHref?: string
}) => {
  const pathname = usePathname()
  const router = useRouter()

  return (
    <WriNavbar
      logo={
        <Link href='/'>
          <WriLogoIcon height='32px' width='92px' />
        </Link>
      }
      linkRouter={Link}
      pathname={pathname}
      utilitySection={[
        query ? (
          <Button
            key='leave-feedback'
            variant='borderless'
            onClick={() => {
              ;(window as any)?.hj('identify', null, { last_query: query })
              ;(window as any)?.hj('event', 'open_survey')
            }}
          >
            Leave Feedback
          </Button>
        ) : null,
        <Button
          key='new-search'
          variant='secondary'
          leftIcon={<FiPlus />}
          onClick={() => router.push(newSearchHref)}
        >
          New search
        </Button>,
      ]}
      maxWidth={1440}
      fixed
    />
  )
}

export default Navbar
