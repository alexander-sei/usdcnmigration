"use client";

import React, { useState, useEffect } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useSignMessage } from "wagmi";
import { ethers } from "ethers";
import type { Hex } from "viem";
import { Buffer } from "buffer";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { ibcTransfer } from "../lib/ibcTransfer";
import { StargateClient } from "@cosmjs/stargate";
import {
  createPublicClient,
  http,
  erc20Abi,
  parseAbi,
  type Address,
} from "viem";
import { TOKEN_MESSENGER_V2 } from "../lib/constants";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getContract, encodePacked } from "viem";
import { signPermit } from "../lib/permit";
import { hexToBigInt } from "viem";

import {
  createBundlerClient,
  toSimple7702SmartAccount,
} from "viem/account-abstraction";

// Removed ERC-20 paymaster helpers – replaced by direct Pimlico sponsorship

export default function Home() {
  // Grab the connected EVM address so we can auto-fill the CCTP mint recipient
  const { isConnected, address } = useAccount();
  const { signMessageAsync, isPending } = useSignMessage();

  // Debug account connection
  console.log("Account state:", { isConnected, address });

  const [signature, setSignature] = useState<string | undefined>();
  const [privateKey, setPrivateKey] = useState<string | undefined>();
  const [nobleAddress, setNobleAddress] = useState<string | undefined>();
  const [txHash, setTxHash] = useState<string | undefined>();
  const [evmAddress, setEvmAddress] = useState<string | undefined>();
  const [cctpHash, setCctpHash] = useState<string | undefined>();
  // Separate amounts for the two transfer flows
  const [ibcAmount, setIbcAmount] = useState<string>("");
  const [cctpAmount, setCctpAmount] = useState<string>("");
  const [nobleBalance, setNobleBalance] = useState<string | undefined>();
  const [showConfirmation, setShowConfirmation] = useState<boolean>(false);
  const [polygonBalance, setPolygonBalance] = useState<string | undefined>();
  // --- New: Sei EVM balances ---
  const [seiNobleBalance, setSeiNobleBalance] = useState<string | undefined>();
  const [seiNativeBalance, setSeiNativeBalance] = useState<
    string | undefined
  >();
  // --- Step 5 (CCTP v2 Polygon → Sei) state ---
  const [seiAmount, setSeiAmount] = useState<string>("");
  const [seiTxHash, setSeiTxHash] = useState<string | undefined>();

  const USDC: Address = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address; // Native USDC on Polygon
  const PAYMASTER: Address =
    "0x0578cFB241215b77442a541325d6A4E6dFE700Ec" as Address;
  // Ensure strongly-typed address for TokenMessengerV2
  const TOKEN_MESSENGER: Address = TOKEN_MESSENGER_V2 as Address;

  const deriveWallet = async () => {
    try {
      const sig = await signMessageAsync({
        message: "Signing this message to create a temporary Noble wallet",
      });
      setSignature(sig);
      // Use keccak256(signature) as entropy for a 32-byte private key (not cryptographically endorsed for production!)
      const key = ethers.keccak256(ethers.getBytes(sig));
      setPrivateKey(key);

      // Use the Cosmos SDK helper to derive the Noble address from the private key
      const pkBytes = Uint8Array.from(Buffer.from(key.slice(2), "hex"));
      const wallet = await DirectSecp256k1Wallet.fromKey(pkBytes, "noble");
      const [account] = await wallet.getAccounts();
      setNobleAddress(account.address);

      // Derive the corresponding ERC-4337 smart account on Polygon
      try {
        const client = createPublicClient({
          chain: polygon,
          transport: http(),
        });
        const owner = privateKeyToAccount(key as `0x${string}`);
        const account = await toSimple7702SmartAccount({ client, owner });

        const addr = account.address;
        setEvmAddress(addr);
      } catch (err) {
        console.error("Failed to derive 0x address:", err);
      }
    } catch (err) {
      console.error(err);
      alert("Signature rejected or failed.");
    }
  };

  const sendIBC = async () => {
    if (!nobleAddress || !ibcAmount) return;
    try {
      // Create signer from wallet provider (assumes user is on Sei network)
      if (!(window as any).ethereum) throw new Error("Wallet not detected");
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();

      const { txHash } = await ibcTransfer({
        signer,
        toAddress: nobleAddress,
        amount: ibcAmount,
      });

      setTxHash(txHash);
    } catch (err) {
      console.error(err);
      alert("IBC transfer failed — see console for details.");
    }
  };

  // CCTP burn on Noble → Ethereum (original flow)
  const sendCCTP = async () => {
    if (!privateKey || !evmAddress || !cctpAmount) return;
    try {
      // Dynamically load our local helper that handles the Noble CCTP message
      const { depositForBurn } = await import("../lib/depositForBurn");

      // Convert the user-provided amount (whole USDC units) to micro units (6 decimals)
      const microAmount = ethers.parseUnits(cctpAmount, 6).toString();

      const result = await depositForBurn({
        rpcEndpoint: "https://noble-rpc.polkachu.com/", // Noble public  RPC
        senderPrivateKey: privateKey,
        amount: microAmount,
        destinationDomain: 7, // Polygon
        destinationAddress: evmAddress,
      });

      setCctpHash(result.txHash);
      setShowConfirmation(true);
    } catch (err) {
      console.error(err);
      alert("CCTP transaction failed — see console for details.");
    }
  };

  // NEW Paymaster-approval version of CCTP-v2 flow (Polygon → Sei)
  async function sendCCTPV2() {
    if (!privateKey) return;

    const client = createPublicClient({ chain: polygon, transport: http() });
    const owner = privateKeyToAccount(privateKey as `0x${string}`);
    const account = await toSimple7702SmartAccount({ client, owner });
    const usdc = getContract({
      client,
      address: USDC as Address,
      abi: erc20Abi,
    });

    // --- CCTP v2 burn parameters ---
    if (!seiAmount || !address) {
      alert("Specify amount and ensure Sei wallet connected");
      return;
    }
    const burnAmount = ethers.parseUnits(seiAmount, 6);
    const SEI_DOMAIN_ID = 16;
    const mintRecipient = ethers.zeroPadValue(
      address as unknown as Address,
      32
    );
    const ZERO_BYTES32 =
      "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

    // Viem requires a parsed ABI (objects with name/type) – not raw strings
    const tokenMessengerAbi = parseAbi([
      "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
    ]);

    const paymaster = {
      async getPaymasterData(parameters: any) {
        const permitAmount = 500000n;
        const permitSignature = await signPermit({
          tokenAddress: USDC,
          account,
          client,
          spenderAddress: PAYMASTER,
          permitAmount: permitAmount,
        });

        const paymasterData = encodePacked(
          ["uint8", "address", "uint256", "bytes"],
          [0, USDC, permitAmount, permitSignature]
        );

        return {
          paymaster: PAYMASTER,
          paymasterData,
          paymasterVerificationGasLimit: 200000n,
          paymasterPostOpGasLimit: 15000n,
          isFinal: true,
        };
      },
    };

    const bundlerClient = createBundlerClient({
      account,
      client,
      paymaster: paymaster as any,
      userOperation: {
        estimateFeesPerGas: async ({
          account,
          bundlerClient,
          userOperation,
        }) => {
          const { standard: fees } = (await bundlerClient.request({
            method: "pimlico_getUserOperationGasPrice" as any,
          })) as any;
          const maxFeePerGas = hexToBigInt(fees.maxFeePerGas);
          const maxPriorityFeePerGas = hexToBigInt(fees.maxPriorityFeePerGas);
          return { maxFeePerGas, maxPriorityFeePerGas };
        },
      },
      transport: http(`https://public.pimlico.io/v2/${client.chain.id}/rpc`),
    });

    // Sign authorization for 7702 account
    const authorization = await owner.signAuthorization({
      chainId: 137,
      nonce: await client.getTransactionCount({ address: owner.address }),
      contractAddress: account.authorization.address,
    });

    const hash = await bundlerClient.sendUserOperation({
      account,
      calls: [
        // 1) Approve the Polygon TokenMessengerV2 to spend native USDC
        {
          to: usdc.address,
          abi: usdc.abi,
          functionName: "approve",
          args: [TOKEN_MESSENGER, burnAmount],
        },
        // 2) Burn USDC and create the CCTP v2 message to mint on Sei
        {
          to: TOKEN_MESSENGER,
          abi: tokenMessengerAbi,
          functionName: "depositForBurn",
          args: [
            burnAmount,
            SEI_DOMAIN_ID,
            mintRecipient as `0x${string}`,
            USDC,
            ZERO_BYTES32,
            burnAmount / 500n,
            1,
          ],
        },
      ],
      authorization: authorization,
    });
    console.log("UserOperation hash", hash);
  }

  useEffect(() => {
    if (!nobleAddress) return;

    const fetchBalance = async () => {
      try {
        const client = await StargateClient.connect(
          "https://noble-rpc.polkachu.com/"
        );
        const { amount: rawAmount } = await client.getBalance(
          nobleAddress,
          "uusdc"
        );
        const formatted = ethers.formatUnits(rawAmount || "0", 6);
        setNobleBalance(formatted);
      } catch (err) {
        console.error("Failed to fetch Noble balance:", err);
      }
    };

    // Initial fetch
    fetchBalance();
    // Refresh every 2 seconds
    const intervalId = setInterval(fetchBalance, 2000);

    // Cleanup on unmount or when dependencies change
    return () => clearInterval(intervalId);
  }, [nobleAddress, txHash, cctpHash]);

  // Fetch Polygon native USDC balance for the derived smart-account address
  useEffect(() => {
    if (!evmAddress) return;

    const provider = new ethers.JsonRpcProvider("https://polygon.drpc.org");
    const usdcAddress = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // Native USDC on Polygon
    const usdcContract = new ethers.Contract(usdcAddress, erc20Abi, provider);

    const fetchBalance = async () => {
      try {
        const [rawBalance, decimals] = await Promise.all([
          usdcContract.balanceOf(evmAddress),
          usdcContract.decimals(),
        ]);
        const formatted = ethers.formatUnits(rawBalance, decimals);
        setPolygonBalance(formatted);
      } catch (err) {
        console.error("Failed to fetch Polygon USDC balance:", err);
      }
    };

    fetchBalance();
    const intervalId = setInterval(fetchBalance, 2000);

    return () => clearInterval(intervalId);
  }, [evmAddress]);

  // Fetch Sei balances (Noble pointer token + native USDC) whenever connected address is available
  useEffect(() => {
    if (!address) return;

    const provider = new ethers.JsonRpcProvider("https://evm-rpc.sei-apis.com");
    // Addresses from Sei docs (pacific-1 mainnet)
    const NOBLE_USDC_ADDRESS = "0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1";
    const NATIVE_USDC_ADDRESS = "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392";

    const nobleUsdcContract = new ethers.Contract(
      NOBLE_USDC_ADDRESS,
      erc20Abi,
      provider
    );
    const nativeUsdcContract = new ethers.Contract(
      NATIVE_USDC_ADDRESS,
      erc20Abi,
      provider
    );

    const fetchBalances = async () => {
      try {
        const [nobleRaw, nobleDecimals, nativeRaw, nativeDecimals] =
          await Promise.all([
            nobleUsdcContract.balanceOf(address),
            nobleUsdcContract.decimals(),
            nativeUsdcContract.balanceOf(address),
            nativeUsdcContract.decimals(),
          ]);

        setSeiNobleBalance(ethers.formatUnits(nobleRaw, nobleDecimals));
        setSeiNativeBalance(ethers.formatUnits(nativeRaw, nativeDecimals));
      } catch (err) {
        console.error("Failed to fetch Sei USDC balances:", err);
      }
    };

    fetchBalances();
    const intervalId = setInterval(fetchBalances, 2000);
    return () => clearInterval(intervalId);
  }, [address]);

  return (
    <main className="flex flex-col items-center justify-start min-h-screen space-y-6 p-4 text-center pt-8">
      <h1 className="text-4xl font-bold">Noble USDC Migration Helper</h1>
      {/* Wallet connect */}
      <ConnectButton />

      {/* Step 1: Explain & sign */}
      {isConnected && !signature && (
        <>
          <p className="text-lg max-w-xl mt-4">
            After connecting, we need a short signature to deterministically
            derive a temporary Noble wallet. No funds move yet — it simply lets
            us prove ownership on a Cosmos chain.
          </p>
          <button
            onClick={deriveWallet}
            disabled={isPending}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg disabled:opacity-60"
          >
            {isPending ? "Waiting for wallet…" : "Sign & generate Noble wallet"}
          </button>
        </>
      )}
      {/* Display private key */}
      {privateKey && (
        <div className="space-y-3 max-w-xl break-all">
          <p className="font-semibold">
            Your derived temporary Noble private key:
          </p>
          <code className="block p-2 bg-red-100 rounded-md text-sm">
            {privateKey}
          </code>
          <p className="text-sm text-red-600">
            Warning: Anyone with this key can control your Noble funds. Store it
            securely and do not share it.
          </p>
        </div>
      )}

      {/* Step 2: Show derived address */}
      {nobleAddress && (
        <div className="space-y-3 max-w-xl break-all">
          <p className="font-semibold">Your temporary Noble address:</p>
          <a
            href={`https://mintscan.io/noble/address/${nobleAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block underline"
          >
            <code className="p-2 bg-gray-100 rounded-md text-sm break-all">
              {nobleAddress}
            </code>
          </a>
          {evmAddress && (
            <>
              <p className="font-semibold pt-4">
                Your derived 0x smart account (Polygon):
              </p>
              <a
                href={`https://polygonscan.com/address/${evmAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block underline"
              >
                <code className="p-2 bg-gray-100 rounded-md text-sm break-all">
                  {evmAddress}
                </code>
              </a>
            </>
          )}
          <p className="text-sm text-gray-500">
            Keep this address handy — we will bridge your Noble USDC to this
            here. Your private key never leaves the browser and can always be
            recreated from the same signature from your wallet.
          </p>
          {/* Display Sei balances */}
          {seiNobleBalance !== undefined && (
            <p className="text-sm">
              Sei Noble USDC balance: <code>{seiNobleBalance} USDC.n</code>
            </p>
          )}
          {seiNativeBalance !== undefined && (
            <p className="text-sm">
              Sei native USDC balance: <code>{seiNativeBalance} USDC</code>
            </p>
          )}
          {nobleBalance !== undefined && (
            <p className="text-lg">
              Current Noble USDC balance: <code>{nobleBalance} USDC</code>
            </p>
          )}
        </div>
      )}

      {/* Step 3: IBC transfer from Sei → Noble */}
      {nobleAddress && isConnected && (
        <div className="flex flex-col items-center space-y-4 max-w-sm w-full">
          <input
            type="number"
            placeholder="Amount of USDC to send"
            value={ibcAmount}
            onChange={(e) => setIbcAmount(e.target.value)}
            className="w-full border rounded-md p-2 text-center"
            min="0"
          />
          <button
            onClick={sendIBC}
            disabled={!ibcAmount}
            className="bg-green-600 hover:bg-green-700 text-white px-6 py-3 rounded-lg disabled:opacity-60"
          >
            Send USDC from Sei → Noble (IBC)
          </button>
          {txHash && (
            <p className="text-sm break-all">
              Sent! Tx hash: <span className="font-mono">{txHash}</span>
            </p>
          )}
        </div>
      )}

      {/* Step 4: Burn USDC on Noble → Mint on Ethereum (CCTP) */}
      {privateKey && evmAddress && (
        <div className="flex flex-col items-center space-y-4 mt-6 max-w-sm w-full">
          <input
            type="number"
            placeholder="Amount of USDC to burn"
            value={cctpAmount}
            onChange={(e) => setCctpAmount(e.target.value)}
            className="w-full border rounded-md p-2 text-center"
            min="0"
          />
          <button
            onClick={sendCCTP}
            disabled={!cctpAmount}
            className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg disabled:opacity-60"
          >
            Burn &amp; Mint to Polygon (CCTP → 0x account)
          </button>
        </div>
      )}

      {/* Step 5: Burn USDC on Polygon → Mint on Sei (CCTP v2) */}
      {address && (
        <div className="flex flex-col items-center space-y-4 mt-6 max-w-sm w-full">
          {polygonBalance !== undefined && (
            <p className="text-lg">
              Current Polygon USDC balance (smart-account):{" "}
              <code>{polygonBalance} USDC</code>
            </p>
          )}
          <input
            type="number"
            placeholder="Amount of USDC to send to Sei"
            value={seiAmount}
            onChange={(e) => setSeiAmount(e.target.value)}
            className="w-full border rounded-md p-2 text-center"
            min="0"
          />
          <button
            onClick={sendCCTPV2}
            disabled={!seiAmount}
            className="bg-yellow-600 hover:bg-yellow-700 text-white px-6 py-3 rounded-lg disabled:opacity-60"
          >
            Burn &amp; Mint to Sei (CCTP V2 with Paymaster)
          </button>
          {seiTxHash && (
            <p className="text-sm break-all">
              Submitted! Tx hash: <span className="font-mono">{seiTxHash}</span>
            </p>
          )}
        </div>
      )}

      {/* Confirmation modal */}
      {showConfirmation && (
        <div className="flex items-center justify-center p-4 z-50 border-6">
          <div className="bg-white dark:bg-gray-900 rounded-lg p-6 space-y-4 max-w-md w-full text-center">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
              Transfer Submitted
            </h2>
            <p>
              Your USDC burn has been submitted on Noble. Once Circle finalizes
              attestation, the tokens will be minted on Polygon.
            </p>
            {cctpHash && (
              <p className="break-all">
                Tx hash:{" "}
                <a
                  href={`https://www.mintscan.io/noble/tx/${cctpHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-mono"
                >
                  {cctpHash}
                </a>
              </p>
            )}
            {polygonBalance !== undefined && (
              <p>
                Current Polygon USDC balance (smart-account):{" "}
                <code>{polygonBalance} USDC</code>
              </p>
            )}
            <button
              onClick={() => setShowConfirmation(false)}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded w-full"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
