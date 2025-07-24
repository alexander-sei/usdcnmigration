import { Contract, Signer, ethers } from 'ethers';

/**
 * Helper to initiate an IBC transfer of Noble USDC that lives on Sei EVM.
 *
 * 1. Approves the IBC precompile to spend the user's ERC-20 USDC.
 * 2. Executes `transferWithDefaultTimeout` on the precompile.
 *
 * Only the minimal ABI surface is included to keep bundle size small.
 */

export interface IbcTransferArgs {
  /** Connected signer that holds Noble USDC on Sei */
  signer: Signer;
  /** Noble bech32 recipient address (noble1...) */
  toAddress: string;
  /** Amount expressed in regular USDC units (e.g. "1.5" → 1.5 USDC) */
  amount: string;
  /** Optional memo */
  memo?: string;

  /**
   * Override defaults if you need: channel / denom. For production pacific-1
   * mainnet they should stay as below.
   */
  channel?: string; // defaults to "channel-45"
  denom?: string;   // defaults to Noble USDC pointer token denom
}

/* ---------------------------- constants --------------------------- */
const IBC_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000001009';
const TOKEN_ADDRESS = '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1';
// "erc20/<tokenAddress>" is the denom used by the precompile for pointer tokens
const DEFAULT_DENOM = `ibc/CA6FBFAF399474A06263E10D0CE5AEBBE15189D6D4B2DD9ADE61007E68EB9DB0`;
const DEFAULT_CHANNEL = 'channel-45'; // pacific-1 → noble-1


// transferWithDefaultTimeout(string toAddress,string port,string channel,string denom,uint256 amount,string memo)
const IBC_PRECOMPILE_ABI = [
  'function transferWithDefaultTimeout(string,string,string,string,uint256,string) external returns (bool)'
];
/* eslint-enable */

export async function ibcTransfer({
  signer,
  toAddress,
  amount,
  memo = '',
  channel = DEFAULT_CHANNEL,
  denom = DEFAULT_DENOM
}: IbcTransferArgs): Promise<{ txHash: string }> {
  // Sanity checks
  if (!toAddress.startsWith('noble')) {
    throw new Error('Expected a noble bech32 address for the recipient');
  }
  if (Number(amount) <= 0) {
    throw new Error('Amount must be greater than 0');
  }

  // Convert human amount → smallest units (USDC has 6 decimals)
  const amountMicro = ethers.parseUnits(amount, 6);

  // 1) Execute IBC transfer
  const ibc = new Contract(IBC_PRECOMPILE_ADDRESS, IBC_PRECOMPILE_ABI, signer);
  const tx = await ibc.transferWithDefaultTimeout(
    toAddress,
    'transfer',
    channel,
    denom,
    amountMicro,
    "tesdstdrtetr"
  );
  const receipt = await tx.wait();
  return { txHash: receipt.transactionHash };
} 