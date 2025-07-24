import { ethers } from 'ethers';

interface DepositForBurnPolygonParams {
  signer: ethers.Signer;
  // Amount in the smallest USDC unit (6 decimals)
  amount: string;
  // CCTP destination domain for Sei – confirm official value once published
  destinationDomain: number;
  // Recipient EVM address on Sei
  destinationAddress: string;
  // Optional override for the USDC token contract on Polygon
  burnToken?: string;
  // Optional override for the TokenMessenger contract on Polygon
  tokenMessenger?: string;
  // (NEW) Optional address on the destination chain allowed to redeem the message
  destinationCaller?: string;
  // (NEW) Maximum fee the user is willing to pay (uint256)
  maxFee?: string;
  // (NEW) Minimum finality threshold accepted on destination (uint32)
  minFinalityThreshold?: number;
}

/**
 * Burns native USDC on Polygon and creates a CCTP v2 transfer message to mint on Sei.
 *
 * IMPORTANT: Default addresses are placeholders – verify against Circle docs.
 */
export async function depositForBurnPolygon({
  signer,
  amount,
  destinationDomain,
  destinationAddress,
  burnToken = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // Native USDC on Polygon
  tokenMessenger = '0x0000000000000000000000000000000000000000', // Polygon TokenMessengerV2 – update when available
  destinationCaller,
  maxFee = '0',
  minFinalityThreshold = 0,
}: DepositForBurnPolygonParams): Promise<{ txHash: string }> {
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

  // Destination caller bytes32 (zero hash when omitted)
  const callerRecipient = destinationCaller
    ? ethers.zeroPadValue(destinationCaller, 32)
    : ethers.ZeroHash;

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