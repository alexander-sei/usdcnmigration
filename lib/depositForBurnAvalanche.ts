import { ethers } from 'ethers';

interface DepositForBurnAvalancheParams {
  signer: ethers.Signer;
  // Amount in the smallest USDC unit (6 decimals)
  amount: string;
  // CCTP domain ID for Sei – update with the official value once published
  destinationDomain: number;
  // Recipient EVM address on Sei
  destinationAddress: string;
  // Optional override for the USDC token contract on Avalanche
  burnToken?: string;
  // Optional override for the TokenMessenger contract on Avalanche
  tokenMessenger?: string;
  // (NEW) Optional address on the destination chain allowed to redeem the message
  destinationCaller?: string;
  // (NEW) Maximum fees willing to pay for the message (uint256)
  maxFee?: string;
  // (NEW) Minimum finality threshold accepted on destination (uint32)
  minFinalityThreshold?: number;
}

/**
 * Burns native USDC on Avalanche and creates a CCTP v2 transfer message to mint on Sei.
 *
 * IMPORTANT: The default contract addresses and domain IDs are placeholders.  
 * Verify and update them against Circle's official docs once Sei support is live on mainnet.
 */
export async function depositForBurnAvalanche({
  signer,
  amount,
  destinationDomain,
  destinationAddress,
  burnToken = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // Native USDC on Avalanche
  // Circle CCTP *TokenMessengerV2* on Avalanche mainnet
  // Source: https://developers.circle.com/stablecoins/evm-smart-contracts#tokenmessengerv2-mainnet
  tokenMessenger = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  destinationCaller,
  maxFee = '0',
  minFinalityThreshold = 0,
}: DepositForBurnAvalancheParams): Promise<{ txHash: string }> {
  if (!ethers.isAddress(destinationAddress)) {
    throw new Error('Invalid destinationAddress');
  }

  if (tokenMessenger === ethers.ZeroAddress) {
    throw new Error('TokenMessenger address is required (received zero address)');
  }

  // Approve the TokenMessenger to spend the specified amount of USDC
  const erc20Abi = ['function approve(address spender, uint256 value) returns (bool)'];
  const usdc = new ethers.Contract(burnToken, erc20Abi, signer);
  const approveTx = await usdc.approve(tokenMessenger, amount);
  await approveTx.wait();

  // Recipient must be bytes32 – pad the 20-byte EVM address with leading zeros
  const mintRecipient = ethers.zeroPadValue(destinationAddress, 32);

  // Destination caller bytes32 (0x00..00 if omitted)
  const callerRecipient = destinationCaller
    ? ethers.zeroPadValue(destinationCaller, 32)
    : ethers.ZeroHash;

  // Minimal ABI for the TokenMessenger we need – updated for CCTP v2
  const messengerAbi = [
    'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external',
  ];
  const messenger = new ethers.Contract(tokenMessenger, messengerAbi, signer);
  const burnTx = await messenger.depositForBurn(
    amount,
    destinationDomain,
    mintRecipient,
    burnToken,
    callerRecipient,
    maxFee,
    minFinalityThreshold,
  );
  const receipt = await burnTx.wait();

  return { txHash: receipt.hash };
} 