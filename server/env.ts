import type { Db } from "./db.ts";

export type Env = {
  DB: Db;
  SESSION_SECRET: string;
  ONECLICK_API_KEY?: string;
  NEAR_RPC_URL: string;
  ONECLICK_BASE_URL: string;
  /** Origin used in emailed payment links (https://frenzypay.app); falls back to the request origin. */
  PUBLIC_BASE_URL?: string;
  // Outgoing invoice email (server/email.ts). Sending is off unless SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM are set.
  SMTP_HOST?: string;
  /** Default 587. */
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  /** starttls (default) | tls | none */
  SMTP_SECURE?: string;
  /** "FrenzyPay <invoice@example.com>" or a bare address. */
  MAIL_FROM?: string;
  MAIL_REPLY_TO?: string;
  // On-chain public records (server/chain.ts). Writes are off unless CHAIN_WRITES_ENABLED is "true" and the
  // contract and relayer variables are all set. Pay-link reads fall back to the contract when CONTRACT_ID is set.
  /** mainnet (default) | testnet: picks the explorer; RPC is NEAR_RPC_URL. */
  NEAR_NETWORK?: string;
  /** The FrenzyPay contract account, e.g. frenzypay.maxkumbang.near. */
  CONTRACT_ID?: string;
  /** Account the relayer key belongs to; the contract's whitelisted relayer. */
  RELAYER_ACCOUNT_ID?: string;
  /** ed25519:<base58> public key of RELAYER_PRIVATE_KEY. */
  RELAYER_PUBLIC_KEY?: string;
  /** Secret. Function-call access key limited to CONTRACT_ID and its write methods. */
  RELAYER_PRIVATE_KEY?: string;
  CHAIN_WRITES_ENABLED?: string;
};
