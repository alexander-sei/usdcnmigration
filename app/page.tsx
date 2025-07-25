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
import { retrieveAttestation } from "../lib/attestation";
import { mintOnSei } from "../lib/mintOnSei";

// -------------------- UI Helper Component --------------------
type StepProps = {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
};

const Step: React.FC<StepProps> = ({ title, description, children }) => (
  <div className="w-full max-w-2xl bg-gradient-to-r from-purple-600 via-fuchsia-600 to-indigo-600 p-[2px] rounded-2xl shadow-lg">
    <section className="rounded-[calc(1rem-2px)] bg-black/80 backdrop-blur-lg p-6 space-y-4">
      <h2 className="text-2xl font-bold mb-2 text-purple-200">{title}</h2>
      {description && (
        <p className="text-base text-gray-300 leading-relaxed">{description}</p>
      )}
      {children}
    </section>
  </div>
);


export default function Home() {
  // Grab the connected EVM address so we can auto-fill the CCTP mint recipient
  const { isConnected, address } = useAccount();
  const { signMessageAsync, isPending } = useSignMessage();

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
  // Track detailed progress of the CCTP v2 flow
  const [cctpV2Stage, setCctpV2Stage] = useState<
    | 'idle'
    | 'burning'
    | 'waitingAttestation'
    | 'minting'
    | 'complete'
  >('idle');

  // Polygon burn tx hash – handy for users & recovery helper
  const [polygonBurnTxHash, setPolygonBurnTxHash] = useState<string | undefined>();
  // Fallback: user-provided Polygon burn tx hash for manual Sei mint
  const [polygonTxHashInput, setPolygonTxHashInput] = useState<string>("");
  // --- Automation stage tracking ---
  type Stage = 'idle' | 'nobleBurning' | 'waitingPolygonMint' | 'polygonBurning' | 'complete';
  const [autoStage, setAutoStage] = useState<Stage>('idle');

  const USDC: Address = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address; // Native USDC on Polygon
  const PAYMASTER: Address =
    "0x0578cFB241215b77442a541325d6A4E6dFE700Ec" as Address;
  // Ensure strongly-typed address for TokenMessengerV2
  const TOKEN_MESSENGER: Address = TOKEN_MESSENGER_V2 as Address;

  const [ibcLoading, setIbcLoading] = useState(false);
  const [cctpLoading, setCctpLoading] = useState(false);
  const [cctpV2Loading, setCctpV2Loading] = useState(false);

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
      setIbcLoading(true);
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
      alert(`IBC transfer failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIbcLoading(false);
    }
  };

  // CCTP burn on Noble → Ethereum (original flow)
  const sendCCTP = async (amountOverride?: string) => {
    const amountToUse = amountOverride ?? cctpAmount;
    if (!privateKey || !evmAddress || !amountToUse) return;
    try {
      setCctpLoading(true);
      // Dynamically load our local helper that handles the Noble CCTP message
      const { depositForBurn } = await import("../lib/depositForBurn");

      // Convert the user-provided amount (whole USDC units) to micro units (6 decimals)
      const microAmount = ethers.parseUnits(amountToUse, 6).toString();

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
      alert(`CCTP transaction failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCctpLoading(false);
    }
  };

  async function recoverFromPolygon(manualPolygonTxHash: string) {
      try {
        // ------------------ Retrieve attestation from provided Polygon tx ------------------
        const attestation = await retrieveAttestation({
          sourceDomain: 7, // Polygon mainnet domain
          transactionHash: manualPolygonTxHash.trim(),
        });
        console.log('Attestation retrieved (manual hash)', attestation);

        // ------------------ Mint on Sei ------------------
        let signer;
        if ((window as any).ethereum) {
          const provider = new ethers.BrowserProvider((window as any).ethereum);
          const { chainId } = await provider.getNetwork();
          if (chainId !== 1329n) {
            try {
              await (window as any).ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: '0x531' }], // 1329 in hex
              });
            } catch (switchErr: any) {
              // If the chain hasn't been added to MetaMask
              if (switchErr.code === 4902) {
                await (window as any).ethereum.request({
                  method: 'wallet_addEthereumChain',
                  params: [
                    {
                      chainId: '0x531',
                      chainName: 'Sei Mainnet',
                      rpcUrls: ['https://evm-rpc.sei-apis.com'],
                      nativeCurrency: { name: 'SEI', symbol: 'SEI', decimals: 18 },
                      blockExplorerUrls: ['https://seitrace.com/?chain=pacific-1'],
                    },
                  ],
                });
              } else throw switchErr;
            }
          }
          signer = await provider.getSigner();
        } else {
          alert('MetaMask (or compatible) wallet not detected');
          return;
        }

        const { txHash: seiMintTx } = await mintOnSei({
          signer,
          message: attestation.message,
          attestation: attestation.attestation,
        });
        console.log('Sei mint tx', seiMintTx);
        setSeiTxHash(seiMintTx);
        setAutoStage('complete');
      } catch (err) {
        console.error('Failed to mint on Sei from manual Polygon tx hash', err);
        alert('Minting on Sei failed — see console for details.');
      }
    
  }

  // NEW Paymaster-approval version of CCTP-v2 flow (Polygon → Sei)
  async function sendCCTPV2(amountOverride?: string) {
    // -------- Manual fallback flow --------
    if (!privateKey) return;
    setCctpV2Loading(true);
    setCctpV2Stage('burning');
    try {
      const client = createPublicClient({ chain: polygon, transport: http() });
      const owner = privateKeyToAccount(privateKey as `0x${string}`);
      const account = await toSimple7702SmartAccount({ client, owner });
      const usdc = getContract({
        client,
        address: USDC as Address,
        abi: erc20Abi,
      });

      // --- CCTP v2 burn parameters ---
      const effectiveAmount = amountOverride ?? seiAmount;
      if (!effectiveAmount || !address) {
        alert("Specify amount and ensure Sei wallet connected");
        return;
      }
      const burnAmount = ethers.parseUnits(effectiveAmount, 6);
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

      // ------------------ Step 3: Retrieve attestation ------------------
      try {
        // Wait until the user operation is executed on Polygon and we have a tx hash
        const opReceipt = await (bundlerClient as any).waitForUserOperationReceipt?.({ hash });
        const polygonTxHash = opReceipt?.receipt?.transactionHash ?? opReceipt?.transactionHash;
        if (!polygonTxHash) {
          console.warn('Could not resolve Polygon tx hash from user operation – please check manually');
          return;
        } else {
          setPolygonBurnTxHash(polygonTxHash);
          setCctpV2Stage('waitingAttestation');
        }

        // Circle uses 7 for Polygon mainnet as the source domain
        const attestation = await retrieveAttestation({
          sourceDomain: 7,
          transactionHash: polygonTxHash as `0x${string}`,
        });
        console.log('Attestation retrieved', attestation);

        setCctpV2Stage('minting');

        // ------------------ Step 4: Mint on Sei ------------------
        // Ensure MetaMask is connected to Sei (chainId 1329). Prompt switch if needed.
        let signer;
        if ((window as any).ethereum) {
          const provider = new ethers.BrowserProvider((window as any).ethereum);
          const { chainId } = await provider.getNetwork();
          if (chainId !== 1329n) {
            try {
              await (window as any).ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: '0x531' }], // 1329 in hex
              });
            } catch (switchErr: any) {
              // If the chain hasn't been added to MetaMask
              if (switchErr.code === 4902) {
                await (window as any).ethereum.request({
                  method: 'wallet_addEthereumChain',
                  params: [
                    {
                      chainId: '0x531',
                      chainName: 'Sei Mainnet',
                      rpcUrls: ['https://evm-rpc.sei-apis.com'],
                      nativeCurrency: { name: 'SEI', symbol: 'SEI', decimals: 18 },
                      blockExplorerUrls: ['https://seitrace.com/?chain=pacific-1'],
                    },
                  ],
                });
              } else throw switchErr;
            }
          }
          signer = await provider.getSigner();
        } else {
          alert('MetaMask (or compatible) wallet not detected');
          return;
        }

        const { txHash: seiMintTx } = await mintOnSei({
          signer,
          message: attestation.message,
          attestation: attestation.attestation,
        });
        console.log('Sei mint tx', seiMintTx);
        setSeiTxHash(seiMintTx);
        setCctpV2Stage('complete');
      } catch (err) {
        console.error('Failed to retrieve attestation / mint on Sei', err);
      }
    } catch (err) {
      console.error(err);
      alert(`CCTP v2 transaction failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCctpV2Loading(false);
    }
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

  /* -------------------- Automation watchers ------------------- */

  // 1) Detect Noble USDC and auto-burn to Polygon
  useEffect(() => {
    if (
      nobleBalance !== undefined &&
      parseFloat(nobleBalance) > 0 &&
      autoStage === 'idle'
    ) {
      (async () => {
        try {
          console.log('Auto-detected Noble balance, initiating CCTP burn');
          await sendCCTP(nobleBalance);
          setAutoStage('waitingPolygonMint');
        } catch (err) {
          console.error('Automated CCTP burn failed:', err);
        }
      })();
    }
  }, [nobleBalance, autoStage]);

  // 2) Detect Polygon USDC mint and auto-burn to Sei
  useEffect(() => {
    if (
      polygonBalance !== undefined &&
      parseFloat(polygonBalance) > 0 &&
      autoStage === 'waitingPolygonMint'
    ) {
      (async () => {
        try {
          console.log('Polygon USDC detected, initiating CCTP v2 burn to Sei');
          await sendCCTPV2(polygonBalance);
          setAutoStage('polygonBurning');
        } catch (err) {
          console.error('Automated Polygon → Sei burn failed:', err);
        }
      })();
    }
  }, [polygonBalance, autoStage]);

  return (
    <>
      <main className="flex flex-col items-center justify-start min-h-screen space-y-6 p-4 text-center pt-8">
      <h1 className="text-4xl font-bold">Noble USDC Migration Helper</h1>
      {/* Wallet connect */}
      <ConnectButton />

      {/* Overview card – always visible */}
      <Step title="Flow Overview" description="We’ll move your USDC in three hops. Each hop happens on-chain and can be monitored with the provided links.">
        <ul className="list-disc list-inside text-left space-y-1 text-sm text-gray-400">
          <li>
            <span className="font-medium text-white">IBC:</span> Sei → Noble
          </li>
          <li>
            <span className="font-medium text-white">CCTP:</span> Noble → Polygon
          </li>
          <li>
            <span className="font-medium text-white">CCTP v2:</span> Polygon → Sei
          </li>
        </ul>
      </Step>

      {/* Prepare step: Signature */}
      {isConnected && !signature && (
        <Step
          title="Prepare – Generate Noble wallet"
          description="A short, gas-free signature lets us deterministically derive a disposable Noble wallet tied only to you. No funds move yet."
        >
          <p className="text-lg">
            After connecting, we need a short signature to deterministically
            derive a temporary Noble wallet. No funds move yet — it simply lets
            us prove ownership on a Cosmos chain.
          </p>
          <button onClick={deriveWallet} disabled={isPending} className="inline-flex items-center justify-center px-6 py-3 font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 rounded-full shadow-lg transition-transform duration-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed">
            {isPending ? "Waiting for wallet…" : "Sign & generate Noble wallet"}
          </button>
        </Step>
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
        </div>
      )}

      {/* Step 1: IBC Sei → Noble */}
      {nobleAddress && isConnected && (
        <Step
          title="1. IBC — Sei → Noble"
          description="Send USDC from your connected Sei wallet into the freshly-created Noble wallet using Cosmos IBC. This keeps the token in its Cosmos form."
        >
          {/* --- Relevant balances before transfer --- */}
          {seiNobleBalance !== undefined && (
            <p className="text-lg">
              Noble-pointer USDC on Sei: <code>{seiNobleBalance} USDC.n</code>
            </p>
          )}
          <div className="flex flex-col items-center space-y-4 pt-2">
            <input
              type="number"
              placeholder="Amount of USDC to send"
              value={ibcAmount}
              onChange={(e) => setIbcAmount(e.target.value)}
              className="w-full input-field text-center"
              min="0"
            />
            <button
              onClick={sendIBC}
              disabled={!ibcAmount || ibcLoading}
              className="inline-flex items-center justify-center px-6 py-3 font-semibold text-white bg-gradient-to-r from-emerald-500 to-lime-500 hover:from-emerald-600 hover:to-lime-600 rounded-full shadow-lg transition-transform duration-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ibcLoading ? (
                <>
                  <svg className="animate-spin h-5 w-5 mr-2 text-white" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                  </svg>
                  Processing…
                </>
              ) : (
                'Send USDC from Sei → Noble (IBC)'
              )}
            </button>
            {txHash && (
              <p className="text-sm break-all">
                Sent! Tx hash: <span className="font-mono">{txHash}</span>
              </p>
            )}
          </div>
        </Step>
      )}

      {/* Step 2: CCTP Noble → Polygon */}
      {privateKey && evmAddress && (
        <Step
          title="2. CCTP — Noble → Polygon"
          description="Burn the Noble-denominated USDC on Noble; Circle will attest and mint native USDC on Polygon straight into your derived smart account."
        >
          {nobleBalance !== undefined && (
            <p className="text-lg">
              Current Noble USDC balance ready to burn: <code>{nobleBalance} USDC</code>
            </p>
          )}
          <div className="flex flex-col items-center space-y-4 pt-2">
            <input
              type="number"
              placeholder="Amount of USDC to burn"
              value={cctpAmount}
              onChange={(e) => setCctpAmount(e.target.value)}
              className="w-full input-field text-center"
              min="0"
            />
            <button
              onClick={() => {
                void sendCCTP();
              }}
              disabled={!cctpAmount || cctpLoading}
              className="inline-flex items-center justify-center px-6 py-3 font-semibold text-white bg-gradient-to-r from-fuchsia-500 to-purple-600 hover:from-fuchsia-600 hover:to-purple-700 rounded-full shadow-lg transition-transform duration-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cctpLoading ? (
                <>
                  <svg className="animate-spin h-5 w-5 mr-2 text-white" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                  </svg>
                  Burning…
                </>
              ) : (
                'Burn & Mint to Polygon (CCTP → 0x account)'
              )}
            </button>
          </div>
        </Step>
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
              className="inline-flex items-center justify-center w-full px-6 py-3 font-semibold text-white bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 rounded-full shadow-lg transition-transform duration-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Step 3: CCTP V2 Polygon → Sei */}
      {address && nobleAddress && (
        <Step
          title="3. CCTP v2 — Polygon → Sei"
          description="Finally, burn the Polygon USDC. Circle’s v2 flow will mint native USDC on Sei back to your connected wallet—gasless, thanks to the Circle USDC paymaster."
        >
          {polygonBalance !== undefined && (
            <p className="text-lg">
              Current Polygon USDC balance (smart-account): <code>{polygonBalance} USDC</code>
            </p>
          )}
          {seiNativeBalance !== undefined && (
            <p className="text-sm text-gray-400">
              Native USDC already on Sei: <code>{seiNativeBalance} USDC</code>
            </p>
          )}
          {/* Specify amount to burn on Polygon for CCTP V2 */}
          <div className="flex flex-col items-center space-y-4 pt-2">
            <input
              type="number"
              placeholder="Amount of USDC to send to Sei"
              value={seiAmount}
              onChange={(e) => setSeiAmount(e.target.value)}
              className="w-full border rounded-md p-2 text-center"
              min="0"
            />
            <button
              onClick={() => {
                void sendCCTPV2();
              }}
              disabled={!seiAmount || cctpV2Loading}
              className="inline-flex items-center justify-center px-6 py-3 font-semibold text-white bg-gradient-to-r from-yellow-400 to-amber-500 hover:from-yellow-500 hover:to-amber-600 rounded-full shadow-lg transition-transform duration-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cctpV2Loading ? (
                <>
                  <svg className="animate-spin h-5 w-5 mr-2 text-white" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                  </svg>
                  {cctpV2Stage === 'burning' && 'Burning…'}
                  {cctpV2Stage === 'waitingAttestation' && 'Awaiting attestation…'}
                  {cctpV2Stage === 'minting' && 'Minting on Sei…'}
                </>
              ) : (
                'Burn & Mint to Sei (CCTP V2)'
              )}
            </button>
            {/* Detailed status messages */}
            {cctpV2Stage === 'waitingAttestation' && (
              <p className="text-sm text-gray-400">Burn confirmed on Polygon. Waiting for Circle attestation — this usually takes 30s.</p>
            )}
            {cctpV2Stage === 'minting' && (
              <p className="text-sm text-gray-400">Attestation received! Finalizing mint on Sei…</p>
            )}
            {polygonBurnTxHash && (
              <p className="text-xs break-all text-gray-500">
                Polygon burn tx: <a href={`https://polygonscan.com/tx/${polygonBurnTxHash}`} target="_blank" rel="noopener noreferrer" className="underline font-mono">{polygonBurnTxHash}</a>
              </p>
            )}
            {seiTxHash && (
              <p className="text-sm break-all">
                Submitted! Sei tx:{' '}
                <a
                  href={`https://seitrace.com/tx/${seiTxHash}?chain=pacific-1`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-mono"
                >
                  {seiTxHash}
                </a>
              </p>
            )}
          </div>
        </Step>
      )}


      {/* Step 4: Recovery */}
      <Step
        title="Need a hand? Recovery"
        description={
          <>
            <p className="mb-2">
              If your automatic mint on Sei ever stalls, you can always retry manually. Paste the Polygon burn transaction hash into the field above and hit
              <span className="font-semibold"> “Mint on Sei using Polygon Tx Hash”</span>. The helper will fetch the Circle attestation and complete the mint on-chain for you.
            </p>
            <div className="space-y-2 w-full">
              <input
                type="text"
                placeholder="Polygon burn tx hash (fallback)"
                value={polygonTxHashInput}
                onChange={(e) => setPolygonTxHashInput(e.target.value)}
                className="w-full border rounded-md p-2 text-center"
              />
              <button
                onClick={() => {
                  void recoverFromPolygon(polygonTxHashInput);
                }}
                disabled={!polygonTxHashInput}
                className="inline-flex items-center justify-center w-full px-6 py-3 font-semibold text-white bg-gradient-to-r from-emerald-500 to-lime-500 hover:from-emerald-600 hover:to-lime-600 rounded-full shadow-lg transition-transform duration-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Mint on Sei using Polygon Tx Hash (manual)
              </button>
            </div>
          </>
        }
      />
    </main>
    </>
  );
}
