'use client'

import { ChakraProvider as ChakraProviderComponent } from '@chakra-ui/react'
import { designSystemStyles } from '@worldresources/wri-design-systems'

const ChakraProvider = ({ children }: { children: React.ReactNode }) => (
  <ChakraProviderComponent value={designSystemStyles}>
    {children}
  </ChakraProviderComponent>
)

export default ChakraProvider
