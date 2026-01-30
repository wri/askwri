'use client'

import { Button, Navbar as WriNavbar } from '@worldresources/wri-design-systems'
import Link from 'next/link'
import { FiPlus } from 'react-icons/fi'
import { WriLogoIcon } from '../components/icons/WriLogo'
import { usePathname } from 'next/navigation'
import { ROUTES } from '../constants'

const Navbar = () => {
  const pathname = usePathname()

  return (
    <WriNavbar
      logo={
        <Link href={ROUTES.HOME}>
          <WriLogoIcon height='32px' width='92px' />
        </Link>
      }
      linkRouter={Link}
      pathname={pathname}
      utilitySection={[
        <Button key='new-search' variant='secondary' onClick={() => {}}>
          Leave Feedback
        </Button>,
        <Button
          key='new-search'
          variant='secondary'
          leftIcon={<FiPlus />}
          onClick={() => {}}
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
