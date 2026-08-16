import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * CCAvenue integration.
 *
 * CCAvenue is a HOSTED redirect gateway: the customer enters their card on
 * CCAvenue's own page, never ours. That is what keeps this application out of
 * PCI-DSS scope — no card number, CVV or expiry may ever be accepted, logged or
 * stored here, and nothing in this file does.
 *
 * The crypto is CCAvenue's own scheme, and it is not negotiable:
 *   key = raw MD5 digest of the 32-character working key (16 bytes)
 *   iv  = the fixed byte sequence 0x00..0x0f
 *   AES-128-CBC, payload hex-encoded
 *
 * A fixed IV is weak by modern standards, but it is what the gateway expects;
 * deviating means the gateway cannot read our request and we cannot read its
 * reply. That is exactly the bug in the old Express service, which encrypted
 * with one working key and decrypted with a different one.
 */

const IV = Buffer.from([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
]);

function keyFromWorkingKey(workingKey: string): Buffer {
  return createHash('md5').update(workingKey).digest();
}

export function encrypt(plainText: string, workingKey: string): string {
  const cipher = createCipheriv('aes-128-cbc', keyFromWorkingKey(workingKey), IV);
  return cipher.update(plainText, 'utf8', 'hex') + cipher.final('hex');
}

export function decrypt(encHex: string, workingKey: string): string {
  const decipher = createDecipheriv('aes-128-cbc', keyFromWorkingKey(workingKey), IV);
  return decipher.update(encHex, 'hex', 'utf8') + decipher.final('utf8');
}

/** Gateway endpoint. Test and live are different hosts, not a flag. */
export function transactionUrl(): string {
  const host = env.CCAVENUE_ENV === 'live' ? 'secure.ccavenue.com' : 'test.ccavenue.com';
  return `https://${host}/transaction/transaction.do?command=initiateTransaction`;
}

/**
 * Human-friendly, non-guessable order reference.
 *
 * Sequential ids must never be the public handle: they leak how many orders you
 * take and let anyone walk other customers' payment pages. Ambiguous characters
 * (0/O, 1/I) are excluded so a reference can be read aloud over the phone.
 */
export function generateReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const year = new Date().getUTCFullYear();
  let body = '';
  const bytes = randomBytes(8);
  for (let i = 0; i < 8; i += 1) body += alphabet[bytes[i]! % alphabet.length];
  return `DK-${year}-${body}`;
}

export interface OrderRequestInput {
  orderId: string;
  amount: string;
  currency: string;
  redirectUrl: string;
  cancelUrl: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  billingAddress?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingZip?: string | null;
  billingCountry?: string | null;
}

/**
 * Builds the `key=value&...` payload CCAvenue expects.
 *
 * Values are NOT url-encoded — CCAvenue parses this as plain delimited text
 * after decryption, so encoding would corrupt names containing spaces. `&` and
 * `=` are stripped from values instead, since either would break the framing.
 */
export function buildRequestPayload(input: OrderRequestInput): string {
  const clean = (v: unknown): string =>
    String(v ?? '').replace(/[&=]/g, ' ').replace(/\s+/g, ' ').trim();

  const fields: Record<string, string> = {
    merchant_id: env.CCAVENUE_MERCHANT_ID ?? '',
    order_id: input.orderId,
    amount: input.amount,
    currency: input.currency,
    redirect_url: input.redirectUrl,
    cancel_url: input.cancelUrl,
    language: 'EN',
    billing_name: clean(input.customerName),
    billing_email: clean(input.customerEmail),
    billing_tel: clean(input.customerPhone),
    billing_address: clean(input.billingAddress),
    billing_city: clean(input.billingCity),
    billing_state: clean(input.billingState),
    billing_zip: clean(input.billingZip),
    billing_country: clean(input.billingCountry) || 'India',
  };

  return Object.entries(fields)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** Parses the decrypted `key=value&...` reply into an object. */
export function parseResponsePayload(decrypted: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of decrypted.split('&')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Maps CCAvenue's `order_status` onto our own enum.
 *
 * Anything unrecognised becomes FAILED rather than silently succeeding — an
 * unknown status must never be treated as money received.
 */
export function mapOrderStatus(
  ccavStatus: string | undefined,
): 'SUCCESS' | 'FAILED' | 'ABORTED' {
  switch ((ccavStatus ?? '').trim().toLowerCase()) {
    case 'success':
      return 'SUCCESS';
    case 'aborted':
      return 'ABORTED';
    default:
      return 'FAILED';
  }
}

/** True only when every credential the gateway needs is configured. */
export function isConfigured(): boolean {
  return Boolean(
    env.CCAVENUE_MERCHANT_ID && env.CCAVENUE_ACCESS_CODE && env.CCAVENUE_WORKING_KEY,
  );
}
