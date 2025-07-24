// @ts-nocheck
import { ethers, Signer } from 'ethers';
import { SEI_MESSAGE_TRANSMITTER } from './constants';

// Minimal ABI for MessageTransmitterV2.receiveMessage(bytes,bytes)
const MESSAGE_TRANSMITTER_ABI = [
  'function receiveMessage(bytes message, bytes attestation) external returns (bool)'
];

interface MintArgs {
  /** RPC endpoint for Sei EVM (defaults to public pacific-1) */
  rpcUrl?: string;
  /** Ethers signer connected to Sei EVM (preferred) */
  signer?: Signer;
  /** Private key alternative if signer not supplied */
  privateKey?: string;
  /** Raw 0x-prefixed message bytes from Circle */
  message: `0x${string}`;
  /** Raw 0x-prefixed attestation bytes from Circle */
  attestation: `0x${string}`;
}

/**
 * Submit the attested CCTP v2 message to Sei's MessageTransmitter contract to
 * mint native USDC on Sei. Returns the tx hash once confirmed.
 */
export async function mintOnSei({
  rpcUrl = 'https://evm-rpc.sei-apis.com',
  signer,
  privateKey,
  message,
  attestation,
}: MintArgs): Promise<{ txHash: string }> {
  let signerToUse: Signer;
  if (signer) {
    signerToUse = signer;
  } else if (privateKey) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    signerToUse = new ethers.Wallet(privateKey, provider);
  } else {
    throw new Error('mintOnSei: Provide either signer or privateKey');
  }

  const transmitter = new ethers.Contract(
    SEI_MESSAGE_TRANSMITTER,
    MESSAGE_TRANSMITTER_ABI,
    signerToUse,
  );

  const tx = await transmitter.receiveMessage(message, attestation);
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    throw new Error('Sei mint transaction failed');
  }
  return { txHash: receipt.transactionHash };
} 