# Next.js Web3 Wallet Starter

This project is a minimal Next.js dApp pre-configured with:

- Tailwind CSS for styling
- [wagmi](https://wagmi.sh) + [RainbowKit](https://www.rainbowkit.com/) for Ethereum wallet connections (WalletConnect v2, MetaMask, etc.)
- TypeScript & strict linting

## Getting Started

1. **Install dependencies**

   ```bash
   pnpm install   # or npm install / yarn install
   ```

2. **Configure WalletConnect**

   Create a `.env.local` file in the project root and add your WalletConnect Cloud Project ID:

   ```env
   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=YOUR_PROJECT_ID
   ```

   You can get a free Project ID at <https://cloud.walletconnect.com>.

3. **Run the development server**

   ```bash
   pnpm dev   # or npm run dev / yarn dev
   ```

4. Open <http://localhost:3000> in your browser and click **Connect Wallet**.

## Production Build

```bash
pnpm build
pnpm start
```

## License

MIT 