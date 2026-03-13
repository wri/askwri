import type { Metadata } from 'next'
import Script from 'next/script'
import type { ReactNode } from 'react'
import ChakraProvider from './Providers/ChakraProvider'
import { Footer } from './components/Footer'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ask WRI',
  description:
    'Find relevant Knowledge Products for your research, identify insights, and export citations.',
}

const isQa = process.env.NEXT_PUBLIC_ENVIRONMENT === 'qa'

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang='en'>
    <head>
      {/* Hotjar Tracking Code for Ask WRI */}
      <Script id='hotjar' strategy='afterInteractive'>
        {`
          (function(h,o,t,j,a,r){
            h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};
            h._hjSettings={hjid:6656811,hjsv:6};
            a=o.getElementsByTagName('head')[0];
            r=o.createElement('script');r.async=1;
            r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;
            a.appendChild(r);
          })(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');
        `}
      </Script>
    </head>
    <body>
      <ChakraProvider>
        {children}
        <Footer />
      </ChakraProvider>
      {isQa && (
        <div
          style={{
            backgroundColor: '#C11101',
            color: 'white',
            padding: '10px 20px',
            textAlign: 'center',
            position: 'fixed',
            bottom: '3%',
            right: '3%',
            zIndex: 1000,
            borderRadius: '16px',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          QA
        </div>
      )}
    </body>
  </html>
)

export default RootLayout
