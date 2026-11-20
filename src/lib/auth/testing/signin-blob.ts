import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { convertStringToHex, deriveAddress, encode, encodeForSigning } from "xrpl";
import { XAMAN_SIGNIN_MEMO_TYPE } from "../wallet-proof";

/**
 * Test helper: builds Xaman-style SignIn blobs signed with throwaway Ed25519 keys, in the
 * same shape Xaman returns (Account, SigningPubKey, TxnSignature, one `xaman-signin` memo).
 * Never use outside tests.
 */

export type TestKey = { publicKeyHex: string; address: string; privateKey: KeyObject };

export function newTestKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const publicKeyHex = `ED${raw.toString("hex").toUpperCase()}`;
  return { publicKeyHex, address: deriveAddress(publicKeyHex), privateKey };
}

export function makeSignInBlob(options: {
  signRequestId: string;
  key: TestKey;
  /** Defaults to the key's own address (master key). Set to simulate a regular key. */
  account?: string;
  memoType?: string;
  extraMemos?: number;
  /** Extra top-level fields, e.g. { TransactionType: "AccountSet" } for a submittable tx. */
  extraFields?: Record<string, unknown>;
}): string {
  const memo = (type: string, data: string) => ({
    Memo: { MemoType: convertStringToHex(type), MemoData: convertStringToHex(data) },
  });
  const memos = [memo(options.memoType ?? XAMAN_SIGNIN_MEMO_TYPE, options.signRequestId)];
  for (let i = 0; i < (options.extraMemos ?? 0); i++) memos.push(memo("note", `extra-${i}`));

  const tx = {
    ...(options.extraFields ?? {}),
    Account: options.account ?? options.key.address,
    SigningPubKey: options.key.publicKeyHex,
    Memos: memos,
  };
  // A SignIn deliberately has no TransactionType, so it is not an xrpl.js `Transaction`.
  type ForSigning = Parameters<typeof encodeForSigning>[0];
  type Encodable = Parameters<typeof encode>[0];
  const signature = sign(null, Buffer.from(encodeForSigning(tx as unknown as ForSigning), "hex"), options.key.privateKey);
  return encode({ ...tx, TxnSignature: signature.toString("hex").toUpperCase() } as unknown as Encodable);
}
