import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Prisma, type PaymentStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { badRequest, conflict, notFound, serviceUnavailable } from '../lib/errors.js';
import { env } from '../config/env.js';
import { generateReference, isConfigured, transactionUrl } from '../lib/ccavenue.js';
import { processCallback, renderGatewayForm } from './payments.service.js';

/**
 * Payments.
 *
 * Flow, and why it is shaped this way:
 *
 *   1. Staff raise a request in the admin with the quoted amount. The customer
 *      never types the amount — that is the single biggest source of payment
 *      disputes, and it also stops anyone paying ₹1 for a ₹50,000 trip.
 *   2. The customer opens /pay/<reference>, reviews it, and clicks pay.
 *   3. We build and encrypt the order and hand back a self-submitting form.
 *      The working key never leaves this server.
 *   4. CCAvenue takes the card on ITS page — no card data reaches us — and
 *      POSTs the encrypted result back to /payments/callback.
 *   5. We decrypt, record an immutable event, update the order, and bounce the
 *      customer to a friendly result page.
 *
 * The amount sent to the gateway is always read from the DATABASE, never from
 * the request body. A client-supplied amount is a client-controlled invoice.
 */

const referenceParam = z.object({ reference: z.string().trim().min(6).max(40) });
const idParam = z.object({ id: z.coerce.number().int().positive() });

const createSchema = z.object({
  customerName: z.string().trim().min(1).max(120),
  customerEmail: z.string().trim().email().max(200),
  customerPhone: z.string().trim().max(40).nullish(),
  // Money as a string: JSON numbers are IEEE-754 doubles and 0.1 + 0.2 is not
  // 0.3. It is parsed into Decimal below.
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Amount must be a number with up to 2 decimal places')
    .refine((v) => Number(v) > 0, 'Amount must be greater than zero'),
  currency: z.enum(['INR', 'USD', 'GBP', 'EUR', 'AED', 'SGD']).default('INR'),
  description: z.string().trim().min(1).max(2000),
  notes: z.string().trim().max(2000).nullish(),
  billingAddress: z.string().trim().max(300).nullish(),
  billingCity: z.string().trim().max(100).nullish(),
  billingState: z.string().trim().max(100).nullish(),
  billingZip: z.string().trim().max(20).nullish(),
  billingCountry: z.string().trim().max(100).nullish(),
  expiresAt: z.coerce.date().nullish(),
});

/**
 * What a CUSTOMER may set. Deliberately narrower than the admin schema: no
 * internal notes, no expiry, and nothing that touches the gateway wiring.
 */
export const publicCreateSchema = z.object({
  customerName: z.string().trim().min(2, 'Please enter your name').max(120),
  customerEmail: z.string().trim().email('Please enter a valid email').max(200),
  customerPhone: z.string().trim().min(6).max(40).nullish(),
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter an amount, up to 2 decimal places')
    // Bounds are a sanity check, not a price check: they stop a typo of 0 or a
    // stray keypress creating a ten-crore order.
    .refine((v) => Number(v) >= 1, 'Amount must be at least 1')
    .refine((v) => Number(v) <= 2_000_000, 'For amounts above 20,00,000 please contact us'),
  currency: z.enum(['INR', 'USD', 'GBP', 'EUR', 'AED', 'SGD']).default('INR'),
  description: z.string().trim().min(3, 'Tell us what this payment is for').max(500),
  billingCity: z.string().trim().max(100).nullish(),
  billingState: z.string().trim().max(100).nullish(),
  billingCountry: z.string().trim().max(100).nullish(),
});

const listQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(25),
  q: z.string().trim().min(1).optional(),
  status: z
    .enum(['PENDING', 'INITIATED', 'SUCCESS', 'FAILED', 'ABORTED', 'CANCELLED', 'REFUNDED'])
    .optional(),
});

/** Only these fields are ever exposed on the PUBLIC pay page. */
function toPublic(order: {
  reference: string;
  customerName: string;
  amount: Prisma.Decimal;
  currency: string;
  description: string;
  status: PaymentStatus;
  expiresAt: Date | null;
}) {
  return {
    reference: order.reference,
    customerName: order.customerName,
    amount: order.amount.toFixed(2),
    currency: order.currency,
    description: order.description,
    status: order.status,
    expiresAt: order.expiresAt,
  };
}

/** Decimal does not survive JSON.stringify usefully; render it as a string. */
function serialise(order: Record<string, unknown>): Record<string, unknown> {
  const amount = order.amount;
  return {
    ...order,
    amount: amount instanceof Prisma.Decimal ? amount.toFixed(2) : amount,
  };
}

export function registerPaymentRoutes(app: FastifyInstance): void {
  const auth = { onRequest: [app.authenticate] };

  /**
   * PUBLIC: the customer raises their own payment.
   *
   * The amount is entered by the customer, by design — the agency quotes over
   * WhatsApp and verifies the figure before confirming the trip. What is NOT
   * accepted from the browser is anything that steers the money: merchant id,
   * return URLs and the working key are all server-side, so a tampered page can
   * change what someone pays but never where the confirmation goes.
   *
   * The order is written here BEFORE the redirect, so every attempt appears in
   * the admin log even if the customer abandons it — and the callback amount
   * can be compared against what was actually submitted.
   */
  app.post(
    '/payments',
    {
      // Tight: this endpoint is unauthenticated and creates rows.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['payments'],
        summary: 'Customer raises a payment for an agreed amount',
        body: publicCreateSchema,
      },
    },
    async (request, reply) => {
      const input = request.body as z.infer<typeof publicCreateSchema>;

      const order = await prisma.paymentOrder.create({
        data: {
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone ?? null,
          amount: new Prisma.Decimal(input.amount),
          currency: input.currency,
          description: input.description,
          billingCity: input.billingCity ?? null,
          billingState: input.billingState ?? null,
          billingCountry: input.billingCountry ?? 'India',
          reference: generateReference(),
          events: {
            create: {
              type: 'created',
              status: 'PENDING',
              message: 'Raised by the customer on the website',
              ip: request.ip,
            },
          },
        },
      });

      request.log.info(
        { reference: order.reference, amount: input.amount, currency: input.currency },
        'Customer-raised payment created',
      );

      // Only the reference goes back; the pay page fetches the rest by it.
      return reply.code(201).send({ reference: order.reference });
    },
  );

  // ------------------------------------------------------------- public read
  app.get(
    '/payments/:reference',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['payments'],
        summary: 'Look up a payment request by its reference',
        params: referenceParam,
      },
    },
    async (request) => {
      const { reference } = request.params as z.infer<typeof referenceParam>;
      const order = await prisma.paymentOrder.findUnique({ where: { reference } });
      if (!order) throw notFound('Payment request');
      return toPublic(order);
    },
  );

  // -------------------------------------------------------------- initiate
  app.post(
    '/payments/:reference/initiate',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['payments'],
        summary: 'Begin payment — returns a self-submitting form for the gateway',
        params: referenceParam,
      },
    },
    async (request, reply) => {
      // Order state is checked BEFORE configuration: "this link was cancelled"
      // is a far more useful answer than "the gateway is not set up", and it is
      // true regardless of how the server happens to be configured.
      const { reference } = request.params as z.infer<typeof referenceParam>;
      const order = await prisma.paymentOrder.findUnique({ where: { reference } });
      if (!order) throw notFound('Payment request');

      // Paying twice for the same request is almost always a double-submit, and
      // refunding is far more painful than refusing.
      if (order.status === 'SUCCESS') {
        throw conflict('This payment has already been completed.');
      }
      if (order.status === 'CANCELLED') {
        throw conflict('This payment request was cancelled. Please ask for a new link.');
      }
      if (order.expiresAt && order.expiresAt.getTime() < Date.now()) {
        throw conflict('This payment link has expired. Please ask for a new one.');
      }

      if (!isConfigured()) {
        throw serviceUnavailable(
          'Payments are not configured. Set CCAVENUE_MERCHANT_ID, CCAVENUE_ACCESS_CODE and CCAVENUE_WORKING_KEY.',
        );
      }

      const html = await renderGatewayForm(order, { ip: request.ip });

      return reply.type('text/html').send(html);
    },
  );

  // -------------------------------------------------------------- callback
  app.post(
    '/payments/callback',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: { tags: ['payments'], summary: 'CCAvenue posts the encrypted result here' },
    },
    async (request, reply) => {
      const body = request.body as Record<string, unknown> | undefined;
      const encResp = typeof body?.encResp === 'string' ? body.encResp : undefined;
      const { redirectUrl } = await processCallback(encResp, {
        ip: request.ip,
        log: request.log,
      });
      return reply.redirect(redirectUrl, 302);
    },
  );

  // ------------------------------------------------------------------ admin
  app.post(
    '/admin/payments',
    {
      ...auth,
      schema: {
        tags: ['admin:payments'],
        summary: 'Raise a payment request and get a shareable link',
        body: createSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const input = request.body as z.infer<typeof createSchema>;

      const order = await prisma.paymentOrder.create({
        data: {
          ...input,
          reference: generateReference(),
          amount: new Prisma.Decimal(input.amount),
          createdById: request.user.sub,
          events: {
            create: {
              type: 'created',
              status: 'PENDING',
              message: `Raised by ${request.user.email}`,
              ip: request.ip,
            },
          },
        },
      });

      return reply.code(201).send({
        ...serialise(order as unknown as Record<string, unknown>),
        payUrl: `${env.SITE_BASE_URL}/pay/${order.reference}`,
      });
    },
  );

  app.get(
    '/admin/payments',
    {
      ...auth,
      schema: {
        tags: ['admin:payments'],
        summary: 'Payment log',
        querystring: listQuery,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { page, perPage, q, status } = request.query as z.infer<typeof listQuery>;

      const where: Prisma.PaymentOrderWhereInput = {
        ...(status ? { status } : {}),
        ...(q
          ? {
              OR: [
                { reference: { contains: q, mode: 'insensitive' } },
                { customerName: { contains: q, mode: 'insensitive' } },
                { customerEmail: { contains: q, mode: 'insensitive' } },
                { trackingId: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };

      const [rows, total, settled] = await Promise.all([
        prisma.paymentOrder.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * perPage,
          take: perPage,
        }),
        prisma.paymentOrder.count({ where }),
        // Totals are computed in the database, not by summing a page of rows.
        prisma.paymentOrder.aggregate({
          where: { status: 'SUCCESS' },
          _sum: { amount: true },
          _count: true,
        }),
      ]);

      return {
        items: rows.map((r) => serialise(r as unknown as Record<string, unknown>)),
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage) || 1,
        summary: {
          collected: (settled._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
          successfulCount: settled._count,
        },
      };
    },
  );

  app.get(
    '/admin/payments/:id',
    {
      ...auth,
      schema: {
        tags: ['admin:payments'],
        summary: 'One payment with its full audit trail',
        params: idParam,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idParam>;
      const order = await prisma.paymentOrder.findUnique({
        where: { id },
        include: {
          events: { orderBy: { createdAt: 'desc' } },
          createdBy: { select: { id: true, name: true, email: true } },
        },
      });
      if (!order) throw notFound('Payment');

      return {
        ...serialise(order as unknown as Record<string, unknown>),
        payUrl: `${env.SITE_BASE_URL}/pay/${order.reference}`,
      };
    },
  );

  /**
   * Cancel an unpaid request. Deliberately NOT a delete: a payment record is
   * financial history and must remain auditable even when abandoned.
   */
  app.post(
    '/admin/payments/:id/cancel',
    {
      ...auth,
      schema: {
        tags: ['admin:payments'],
        summary: 'Cancel an unpaid payment request',
        params: idParam,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idParam>;
      const order = await prisma.paymentOrder.findUnique({ where: { id } });
      if (!order) throw notFound('Payment');
      if (order.status === 'SUCCESS') {
        throw badRequest('A completed payment cannot be cancelled. Refund it instead.');
      }

      const [updated] = await prisma.$transaction([
        prisma.paymentOrder.update({ where: { id }, data: { status: 'CANCELLED' } }),
        prisma.paymentEvent.create({
          data: {
            orderId: id,
            type: 'status_change',
            status: 'CANCELLED',
            message: `Cancelled by ${request.user.email}`,
            ip: request.ip,
          },
        }),
      ]);

      return serialise(updated as unknown as Record<string, unknown>);
    },
  );

  /** Configuration probe for the admin, so staff see WHY payments are off. */
  app.get(
    '/admin/payments-config',
    {
      ...auth,
      schema: {
        tags: ['admin:payments'],
        summary: 'Whether payments are configured, and against which gateway',
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({
      configured: isConfigured(),
      environment: env.CCAVENUE_ENV,
      gateway: transactionUrl().split('/transaction')[0],
      missing: [
        !env.CCAVENUE_MERCHANT_ID && 'CCAVENUE_MERCHANT_ID',
        !env.CCAVENUE_ACCESS_CODE && 'CCAVENUE_ACCESS_CODE',
        !env.CCAVENUE_WORKING_KEY && 'CCAVENUE_WORKING_KEY',
      ].filter(Boolean),
    }),
  );
}
