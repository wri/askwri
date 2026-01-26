'use client'

import {
  ChakraProvider as ChakraProviderComponent,
  createSystem,
} from '@chakra-ui/react'
import { designSystemStyles } from '@worldresources/wri-design-systems'

const customStylesSystem = createSystem(designSystemStyles._config, {
  // preflight: false,
  theme: {
    tokens: {
      colors: {
        // neutral: {},
        primary: {
          100: { value: '#F6FDFF' },
          200: { value: '#E9FAFE' },
          300: { value: '#D4F6FF' },
          400: { value: '#9AE9F9' },
          500: { value: '#5FD9F0' },
          600: { value: '#26C3EA' },
          700: { value: '#0074A2' },
          800: { value: '#00567B' },
          900: { value: '#001B54' },
        },
        secondary: {
          100: { value: '#FEFBEB' },
          200: { value: '#FFF1C8' },
          300: { value: '#FFE38C' },
          400: { value: '#F6C665' },
          500: { value: '#E4AD3C' },
          600: { value: '#CC9B1F' },
          700: { value: '#8F6218' },
          800: { value: '#6E4A10' },
          900: { value: '#332500' },
        },
        // success: {},
        // warning: {},
        // error: {},
        accessible: {
          'text-on-primary-mids': { value: '#001B54' },
          'text-on-secondary-mids': { value: '#332500' },
          'controls-on-neutral-lights': { value: '#00567B' },
          'controls-on-neutral-darks': { value: '#D4F6FF' },
        },
      },
    },
  },
})

const ChakraProvider = ({ children }: { children: React.ReactNode }) => (
  <ChakraProviderComponent value={customStylesSystem}>
    {children}
  </ChakraProviderComponent>
)

export default ChakraProvider