import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type PaymentOrder } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import {
  buildRequestPayload,
  decrypt,
  encrypt,
  generateReference,
  isConfigured,
  mapOrderStatus,
  parseResponsePayload,
  transactionUrl,
} from '../lib/ccavenue.js';

/**
 * Payment business logic, shared by the JSON API under `/api/v1/payments/*`
 * and the checkout routes served at the root of the API domain.
 *
 * Keeping it here rather than in a route handler is what lets both surfaces be
 * served without duplicating the crypto, the validation or the audit trail —
 * two doors into one implementation.
 */

export interface CreateOrderInput {
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  amount: string;
  currency: string;
  description: string;
  notes?: string | null;
  billingAddress?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingZip?: string | null;
  billingCountry?: string | null;
  expiresAt?: Date | null;
}

export interface CreateOrderMeta {
  ip?: string;
  /** Who raised it, for the audit trail. */
  raisedBy: string;
  createdById?: number | null;
}

export async function createPaymentOrder(
  input: CreateOrderInput,
  meta: CreateOrderMeta,
): Promise<PaymentOrder> {
  return prisma.paymentOrder.create({
    data: {
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone ?? null,
      // Decimal, never Float — a paisa of drift is a reconciliation failure.
      amount: new Prisma.Decimal(input.amount),
      currency: input.currency,
      description: input.description,
      notes: input.notes ?? null,
      billingAddress: input.billingAddress ?? null,
      billingCity: input.billingCity ?? null,
      billingState: input.billingState ?? null,
      billingZip: input.billingZip ?? null,
      billingCountry: input.billingCountry ?? 'India',
      expiresAt: input.expiresAt ?? null,
      createdById: meta.createdById ?? null,
      reference: generateReference(),
      events: {
        create: {
          type: 'created',
          status: 'PENDING',
          message: meta.raisedBy,
          ip: meta.ip ?? null,
        },
      },
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * Encrypts the order and returns a page that posts itself to CCAvenue.
 *
 * Every value that decides where the money goes — merchant id, return URLs —
 * is set here, server-side. Only the opaque ciphertext reaches the browser.
 */
export async function renderGatewayForm(
  order: PaymentOrder,
  meta: { ip?: string },
): Promise<string> {
  const payload = buildRequestPayload({
    orderId: order.reference,
    // Read from the database, never from the request.
    amount: order.amount.toFixed(2),
    currency: order.currency,
    // The gateway returns to the checkout path published by this domain, which
    // is what any CCAvenue-side configuration expects.
    redirectUrl: `${env.PUBLIC_BASE_URL}/ccavResponseHandler`,
    cancelUrl: `${env.PUBLIC_BASE_URL}/ccavResponseHandler`,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: order.customerPhone,
    billingAddress: order.billingAddress,
    billingCity: order.billingCity,
    billingState: order.billingState,
    billingZip: order.billingZip,
    billingCountry: order.billingCountry,
  });

  const encRequest = encrypt(payload, env.CCAVENUE_WORKING_KEY!);

  await prisma.$transaction([
    prisma.paymentOrder.update({
      where: { id: order.id },
      data: { status: order.status === 'PENDING' ? 'INITIATED' : order.status },
    }),
    prisma.paymentEvent.create({
      data: {
        orderId: order.id,
        type: 'initiated',
        status: 'INITIATED',
        message: `Redirected to CCAvenue (${env.CCAVENUE_ENV})`,
        ip: meta.ip ?? null,
      },
    }),
  ]);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Redirecting to secure payment…</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f7f7f5;
color:#57574f;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.s{width:26px;height:26px;border:3px solid #e2e2dd;border-top-color:#b85f28;border-radius:50%;
margin:0 auto 14px;animation:r .8s linear infinite}@keyframes r{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.s{animation:none}}</style></head>
<body><div style="text-align:center"><div class="s"></div>
<p style="font-size:.9rem">Taking you to the secure payment page…</p>
<noscript><p>JavaScript is required. <button form="ccav" type="submit">Continue</button></p></noscript></div>
<form id="ccav" method="post" action="${transactionUrl()}">
<input type="hidden" name="encRequest" value="${encRequest}">
<input type="hidden" name="access_code" value="${escapeHtml(env.CCAVENUE_ACCESS_CODE ?? '')}">
</form>
<script>document.getElementById('ccav').submit();</script></body></html>`;
}

export interface CallbackResult {
  /** Where to send the customer's browser next. */
  redirectUrl: string;
}

/**
 * Processes CCAvenue's encrypted reply.
 *
 * Deliberate behaviours, each learned from a way payment integrations go wrong:
 *  - an unknown status is FAILED, never SUCCESS
 *  - a repeat callback cannot downgrade an already-settled order
 *  - if the gateway's amount disagrees with the invoice, it is NOT marked paid
 *  - every callback is archived verbatim, including ones we ignore
 */
export async function processCallback(
  encResp: string | undefined,
  meta: { ip?: string; log: FastifyBaseLogger },
): Promise<CallbackResult> {
  const errorTo = (reason: string): CallbackResult => {
    meta.log.error({ reason }, 'Payment callback could not be processed');
    return {
      redirectUrl: `${env.SITE_BASE_URL}/payment/result?status=error&reason=${encodeURIComponent(reason)}`,
    };
  };

  if (!encResp) return errorTo('missing-response');
  if (!isConfigured()) return errorTo('not-configured');

  let fields: Record<string, string>;
  try {
    fields = parseResponsePayload(decrypt(encResp, env.CCAVENUE_WORKING_KEY!));
  } catch {
    // Nearly always a working-key mismatch between request and response.
    return errorTo('decrypt-failed');
  }

  const reference = fields.order_id;
  if (!reference) return errorTo('missing-order-id');

  const order = await prisma.paymentOrder.findUnique({ where: { reference } });
  if (!order) return errorTo('unknown-order');

  const status = mapOrderStatus(fields.order_status);
  const done = { redirectUrl: `${env.SITE_BASE_URL}/payment/result?ref=${reference}` };

  // Gateways retry. A late contradicting callback must not unsettle a paid order.
  if (order.status === 'SUCCESS' && status !== 'SUCCESS') {
    await prisma.paymentEvent.create({
      data: {
        orderId: order.id,
        type: 'callback',
        status,
        message: `Ignored: order already SUCCESS, callback reported ${fields.order_status}`,
        payload: fields as Prisma.InputJsonValue,
        ip: meta.ip ?? null,
      },
    });
    return done;
  }

  const paidAmount = Number(fields.amount ?? '0');
  const expected = Number(order.amount.toFixed(2));
  const amountMismatch = status === 'SUCCESS' && Math.abs(paidAmount - expected) > 0.009;

  await prisma.$transaction([
    prisma.paymentOrder.update({
      where: { id: order.id },
      data: {
        status: amountMismatch ? 'FAILED' : status,
        trackingId: fields.tracking_id ?? null,
        bankRefNo: fields.bank_ref_no ?? null,
        paymentMode: fields.payment_mode ?? null,
        cardName: fields.card_name ?? null,
        statusMessage: fields.status_message ?? null,
        failureMessage: amountMismatch
          ? `Amount mismatch: expected ${expected}, gateway reported ${paidAmount}`
          : fields.failure_message || null,
        paidAt: status === 'SUCCESS' && !amountMismatch ? new Date() : null,
      },
    }),
    prisma.paymentEvent.create({
      data: {
        orderId: order.id,
        type: 'callback',
        status: amountMismatch ? 'FAILED' : status,
        message: amountMismatch
          ? `AMOUNT MISMATCH — expected ${expected} ${order.currency}, gateway reported ${paidAmount}`
          : fields.status_message || fields.order_status || 'Gateway callback',
        payload: fields as Prisma.InputJsonValue,
        ip: meta.ip ?? null,
      },
    }),
  ]);

  meta.log.info(
    { reference, status, trackingId: fields.tracking_id, amountMismatch },
    'Payment callback processed',
  );

  return done;
}
