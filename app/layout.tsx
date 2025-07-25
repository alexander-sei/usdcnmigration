"use client"
import React from 'react';
import './globals.css';
import { Providers } from './providers';
import { Inter } from 'next/font/google'; 
import { TERMS_TEXT } from '../lib/constants';
import { useState, useEffect } from 'react';

const inter = Inter({ subsets: ['latin'] });

 const metadata = {
  title: 'USDC Migration helper',
  description: 'USDC Migration helper',
  // Add various icon types so browsers can automatically pick them up
  icons: {
    icon: '/favicon.ico', // Default favicon
    shortcut: '/favicon-16x16.png', // 16×16 PNG
    apple: '/apple-touch-icon.png', // Apple touch icon
    other: [
      { rel: 'icon', url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { rel: 'icon', url: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { rel: 'icon', url: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {


  const [showTerms, setShowTerms] = useState<boolean>(true);


  const handleAcceptTerms = () => {

    setShowTerms(false);
  };

    // Terms of Use modal overlay component
const TermsModal: React.FC<{ onAccept: () => void }> = ({ onAccept }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    onClick={(e) => {
      // Clicking on the backdrop (outside the modal content) should also close
      if (e.target === e.currentTarget) {
        onAccept();
      }
    }}
  >
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] overflow-y-auto p-6 space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white text-center">Terms Of Use</h2>
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800 dark:text-gray-200">
        {TERMS_TEXT}
      </div>
      <button
        type="button"
        onClick={() => onAccept()}
        className="w-full inline-flex items-center justify-center px-6 py-3 font-semibold text-white bg-gradient-to-r from-fuchsia-500 to-purple-600 hover:from-fuchsia-600 hover:to-purple-700 rounded-full shadow-lg transition-transform duration-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        I Agree
      </button>
    </div>
  </div>
);

  
  return (
    <html lang="en">
      <body className={`${inter.className} bg-gradient-to-br to-black min-h-screen text-white antialiased`}>
      {showTerms ? <TermsModal onAccept={handleAcceptTerms} /> : <Providers>{children}</Providers>}
      </body>
    </html>
  );
} 