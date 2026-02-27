'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Button, Navbar as WriNavbar } from '@worldresources/wri-design-systems'
import { FiPlus } from 'react-icons/fi'
import { WriLogoIcon } from '../icons/WriLogo'

// Hotjar event typing
declare global {
  interface Window {
    hj?: (...args: any[]) => void
  }
}

const Navbar = () => {
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
        <Button
          key='leave-feedback'
          variant='borderless'
          onClick={() => {
            if (typeof window.hj === 'function') {
              window.hj('event', 'leave_feedback_clicked')
            }
          }}
        >
          Leave Feedback
        </Button>,
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
