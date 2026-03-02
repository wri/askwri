'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Button, Navbar as WriNavbar } from '@worldresources/wri-design-systems'
import { FiPlus } from 'react-icons/fi'
import { WriLogoIcon } from '../icons/WriLogo'

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
            window.open(
              'https://surveys.hotjar.com/4ba2c242-87ac-44a0-9f6f-6caed18f1cf2',
              '_blank',
              'noopener,noreferrer',
            )
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
