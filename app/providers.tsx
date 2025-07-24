'use client';

import React from 'react';

import '@rainbow-me/rainbowkit/styles.css';

import {
  RainbowKitProvider,
  connectorsForWallets,
} from '@rainbow-me/rainbowkit';
import {
  metaMaskWallet,
  coinbaseWallet,
  rainbowWallet,
  braveWallet,
  trustWallet,
  rabbyWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { WagmiProvider, http, createConfig } from 'wagmi';
import { polygon, sei } from 'wagmi/chains';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'YOUR_PROJECT_ID';

const chains = [polygon, sei] as const;

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Recommended',
      wallets: [
        metaMaskWallet,
        coinbaseWallet,
        rainbowWallet,
        braveWallet,
        trustWallet,
        rabbyWallet,
        walletConnectWallet,
      ],
    },
  ],
  {
    appName: 'Next.js Web3 Wallet',
    projectId,
  },
);

const config = createConfig({
  chains,
  connectors,
  transports: {
    [polygon.id]: http(),
    [sei.id]: http('https://sei-rpc.publicnode.com'),
  },
  ssr: true,
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config} reconnectOnMount={true}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
} 