import type { Metadata } from 'next'
import Script from 'next/script'
import type { ReactNode } from 'react'
import ChakraProvider from './Providers/ChakraProvider'
import { Footer } from './components/Footer'
import IsQA from './IsQA'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ask WRI',
  description:
    'Find relevant Knowledge Products for your research, identify insights, and export citations.',
  icons: { icon: '/favicon.ico' },
}

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang='en'>
    <head>
      {/* Hotjar Tracking Code for Ask WRI */}
      {process.env.NEXT_PUBLIC_HOTJAR_ID && (
        <Script id='hotjar' strategy='afterInteractive'>
          {`
          (function(h,o,t,j,a,r){
            h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};
            h._hjSettings={hjid:${process.env.NEXT_PUBLIC_HOTJAR_ID},hjsv:6};
            a=o.getElementsByTagName('head')[0];
            r=o.createElement('script');r.async=1;
            r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;
            a.appendChild(r);
          })(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');
        `}
        </Script>
      )}
    </head>
    <body>
      <ChakraProvider>
        {children}
        <Footer />
      </ChakraProvider>
      <IsQA />
    </body>
  </html>
)

export default RootLayout
