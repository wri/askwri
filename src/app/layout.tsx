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

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang='en'>
    <head>
      {/* Hotjar Tracking Code for Ask WRI */}
      {/* Hotjar Tracking Code for Ask WRI */}
      {(() => {
        const id = Number(process.env.NEXT_PUBLIC_HOTJAR_ID);
        return id > 0 ? (
          <Script id="hotjar" strategy="afterInteractive">
            {`
              (function(h,o,t,j,a,r){
                h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};
                h._hjSettings={hjid:${id},hjsv:6};
                a=o.getElementsByTagName('head')[0];
                r=o.createElement('script');r.async=1;
                r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;
                a.appendChild(r);
              })(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');
            `}
          </Script>
        ) : null;
      })()}
    </head>
    <body>
      <ChakraProvider>
        {children}
        <Footer />
      </ChakraProvider>
    </body>
  </html>
)

export default RootLayout
