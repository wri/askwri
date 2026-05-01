'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Button, Navbar as WriNavbar } from '@worldresources/wri-design-systems'
import { FiPlus } from 'react-icons/fi'
import { WriLogoIcon } from '../icons/WriLogo'

const Navbar = ({ query }: { query: string }) => {
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
          onClick={() => router.push('/')}
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
