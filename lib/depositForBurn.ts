// @ts-nocheck
import { Buffer } from 'buffer';
import { DirectSecp256k1Wallet, Registry, GeneratedType } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { MsgDepositForBurn } from "./generated/tx";

export const cctpTypes: ReadonlyArray<[string, GeneratedType]> = [
    ["/circle.cctp.v1.MsgDepositForBurn", MsgDepositForBurn],
];

function createDefaultRegistry(): Registry {
    return new Registry(cctpTypes)
};

interface DepositForBurnArgs {
  rpcEndpoint: string;
  senderPrivateKey: string; // 0x-prefixed hex
  amount: string; // micro USDC (e.g. 1 USDC = 1000000)
  destinationDomain: number; // CCTP domain – 0 = Ethereum mainnet / Sepolia
  destinationAddress: string; // 0x-prefixed EVM address the mint should be sent to
  burnToken?: string; // Noble denom (defaults to uusdc)
}

export async function depositForBurn(args: DepositForBurnArgs): Promise<{ txHash: string }> {
  const {
    rpcEndpoint,
    senderPrivateKey,
    amount,
    destinationDomain,
    destinationAddress,
    burnToken = 'uusdc',
  } = args;

  // --------------------
  // Parameter validation
  // --------------------

  // destinationAddress must be a 0x-prefixed, 20-byte (40 hex chars) EVM address
  const isValidHex = (val: string) => /^0x[0-9a-fA-F]+$/.test(val);
  if (!isValidHex(destinationAddress) || destinationAddress.length !== 42) {
    throw new Error(
      `Invalid destinationAddress: expected a 0x-prefixed 40-character hex string, got "${destinationAddress}"`,
    );
  }

  // Private key sanity check (should be 32-byte hex string)
  if (!isValidHex(senderPrivateKey) || senderPrivateKey.length !== 66) {
    throw new Error('senderPrivateKey must be a 32-byte 0x-prefixed hex string');
  }

  // Convert private key to raw bytes and instantiate wallet
  const pkBytes = Uint8Array.from(Buffer.from(senderPrivateKey.replace(/^0x/, ''), 'hex'));
  const wallet = await DirectSecp256k1Wallet.fromKey(pkBytes, 'noble');
  const [account] = await wallet.getAccounts();

  const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, wallet, {
    registry: createDefaultRegistry(),
  });

  // Destination EVM address must be left-padded to 32 bytes (bytes32)
  const cleaned = destinationAddress.replace(/^0x/, '');
  const padded = cleaned.padStart(64, '0');
  const mintRecipient = Uint8Array.from(Buffer.from(padded, 'hex'));

  const msg = {
    typeUrl: '/circle.cctp.v1.MsgDepositForBurn',
    value: {
      from: account.address,
      amount,
      destinationDomain,
      mintRecipient,
      burnToken,
    },
  };

  const fee = {
    amount: [
      {
        denom: burnToken,
        amount: '0',
      },
    ],
    gas: '200000',
  };

  const result = await client.signAndBroadcast(account.address, [msg], fee, '');
  if (result.code !== 0) {
    throw new Error(`Broadcast failed with code ${result.code}: ${result.rawLog}`);
  }

  return { txHash: result.transactionHash };
} 