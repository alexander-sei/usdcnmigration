// @ts-nocheck
import axios from 'axios';

export interface AttestationData {
  /** Raw message bytes as 0x-prefixed hex string */
  message: `0x${string}`;
  /** Raw attestation signature bytes as 0x-prefixed hex string */
  attestation: `0x${string}`;
}

interface RetrieveArgs {
  /** CCTP source domain ID (e.g. 7 for Polygon mainnet) */
  sourceDomain: number;
  /** Transaction hash of the depositForBurn on the source chain */
  transactionHash: string;
  /** Polling interval in milliseconds – defaults to 5s */
  intervalMs?: number;
  /** Set to true to query the Circle sandbox (testnets). */
  isTestnet?: boolean;
  /** Maximum number of polling attempts before giving up (default: 3). */
  maxAttempts?: number;
}

/**
 * Poll Circle's attestation service (CCTP v2) until the burn message for the
 * given transaction hash is fully signed. Returns the signed message &
 * attestation, both 0x-prefixed hex strings ready for `receiveMessage`.
 */
export async function retrieveAttestation({
  sourceDomain,
  transactionHash,
  intervalMs = 5000,
  isTestnet = false,
  maxAttempts = 100,
}: RetrieveArgs): Promise<AttestationData> {
  const baseUrl = isTestnet
    ? 'https://iris-api-sandbox.circle.com'
    : 'https://iris-api.circle.com';
  const url = `${baseUrl}/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`;

  let attempt = 0;

  for (;;) {
    if (attempt >= maxAttempts) {
      throw new Error(
        `retrieveAttestation: exceeded maximum attempts (${maxAttempts}) without obtaining a completed attestation`,
      );
    }
    try {
      const { data } = await axios.get(url);
      attempt += 1;
      const messageObj = data?.messages?.[0];
      if (!messageObj) {
        // No message yet – wait and retry (doesn't count against maxAttempts as we didn't receive a message)
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
      if (messageObj.status === 'complete') {
        return {
          message: messageObj.message as `0x${string}`,
          attestation: messageObj.attestation as `0x${string}`,
        };
      }
    } catch (err) {
      // Network error or 404 – silently retry
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
} 