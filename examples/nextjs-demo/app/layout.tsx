import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Aurora Fieldwork',
  description: 'A small demo site used to exercise the OpenGSO loop end to end.',
};

const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Aurora Fieldwork',
  url: 'http://localhost:3000',
  foundingDate: '2019',
  description: 'Cold-weather environmental survey consultancy based in Tromso, Norway.',
  address: { '@type': 'PostalAddress', addressLocality: 'Tromso', addressCountry: 'NO' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
      </head>
      <body
        style={{
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          margin: 0,
          lineHeight: 1.6,
          color: '#16181d',
          background: '#fbfbfa',
        }}
      >
        <header style={{ borderBottom: '1px solid #e6e6e2', padding: '16px 24px' }}>
          <nav style={{ display: 'flex', gap: 20, maxWidth: 760, margin: '0 auto' }}>
            <Link href="/">Home</Link>
            <Link href="/about">About</Link>
            <Link href="/resume">Resume</Link>
          </nav>
        </header>
        <main style={{ maxWidth: 760, margin: '0 auto', padding: '32px 24px 64px' }}>{children}</main>
        <footer style={{ borderTop: '1px solid #e6e6e2', padding: '16px 24px', fontSize: 13, color: '#6b6f76' }}>
          <div style={{ maxWidth: 760, margin: '0 auto' }}>Aurora Fieldwork, an OpenGSO demo.</div>
        </footer>
      </body>
    </html>
  );
}
