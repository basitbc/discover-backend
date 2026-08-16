import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { isConfigured } from '../lib/ccavenue.js';
import { createPaymentOrder, processCallback, renderGatewayForm } from './payments.service.js';

/**
 * Checkout routes served on the API domain (api.thediscoverkashmir.in).
 *
 * These are mounted at the ROOT of the API rather than under /api/v1, because
 * CCAvenue receives `redirect_url` inside the encrypted order payload. The
 * gateway therefore returns to exactly the path we send it, and these are the
 * paths this domain has always published — in links, in printed material, and
 * in whatever is recorded on the CCAvenue side.
 *
 *   GET  /payment                       customer entry point (the Navbar links here)
 *   POST /ccavRequestHandler            checkout form target
 *   POST /api/ccav/ccavRequestHandler   the same, under the /api/ccav mount
 *   POST /ccavResponseHandler           gateway return URL
 *   POST /api/ccav/ccavResponseHandler  the same, under the /api/ccav mount
 *
 * Both spellings of each are accepted so every published form of the URL keeps
 * resolving. Every request here creates a real PaymentOrder and appears in the
 * admin payment log.
 */

/** Field names used by the checkout form, which differ from the JSON API. */
const checkoutFormSchema = z.object({
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter a valid amount')
    .refine((v) => Number(v) >= 1, 'Amount must be at least 1')
    .refine((v) => Number(v) <= 2_000_000, 'For amounts above 20,00,000 please contact us'),
  currency: z.string().trim().max(6).optional(),
  billing_name: z.string().trim().min(2, 'Please enter your name').max(120),
  billing_email: z.string().trim().email('Please enter a valid email').max(200),
  billing_tel: z.string().trim().max(40).optional(),
  billing_address: z.string().trim().max(300).optional(),
  billing_city: z.string().trim().max(100).optional(),
  billing_state: z.string().trim().max(100).optional(),
  billing_zip: z.string().trim().max(20).optional(),
  billing_country: z.string().trim().max(100).optional(),
  /** The checkout form carries the purpose here. */
  merchant_param1: z.string().trim().max(500).optional(),
});

const ERROR_PAGE = (message: string) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Payment unavailable</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f7f7f5;
color:#26261f;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.c{max-width:420px;background:#fff;border:1px solid #e2e2dd;border-radius:10px;padding:32px;text-align:center}
h1{font-size:1.25rem;margin:0 0 8px}p{color:#57574f;font-size:.9rem;margin:0 0 20px}
a{display:inline-block;background:#b85f28;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600}
</style></head><body><div class="c"><h1>We could not start this payment</h1>
<p>${message.replace(/[<>&]/g, '')}</p>
<a href="${env.SITE_BASE_URL}/payment">Try again</a></div></body></html>`;

export function registerGatewayRoutes(app: FastifyInstance): void {
  /**
   * The Navbar and printed material point here. Rather than maintain a second
   * copy of the form, send the customer to the one on the website.
   */
  app.get(
    '/payment',
    {
      schema: {
        tags: ['checkout'],
        summary: 'Customer entry point — redirects to the payment form',
      },
    },
    async (_request, reply) => reply.redirect(`${env.SITE_BASE_URL}/payment`, 302),
  );

  /** The checkout form posts here; this creates the order and hands off to the gateway. */
  const handleCheckoutRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = checkoutFormSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return reply
        .code(400)
        .type('text/html')
        .send(ERROR_PAGE(first?.message ?? 'Please check the details you entered.'));
    }

    if (!isConfigured()) {
      request.log.error('Checkout request received but CCAvenue is not configured');
      return reply
        .code(503)
        .type('text/html')
        .send(ERROR_PAGE('Online payment is temporarily unavailable. Please contact us.'));
    }

    const f = parsed.data;

    const order = await createPaymentOrder(
      {
        customerName: f.billing_name,
        customerEmail: f.billing_email,
        customerPhone: f.billing_tel ?? null,
        amount: Number(f.amount).toFixed(2),
        currency: (f.currency || 'INR').toUpperCase(),
        description: f.merchant_param1 || 'Payment to Discover Kashmir',
        billingAddress: f.billing_address ?? null,
        billingCity: f.billing_city ?? null,
        billingState: f.billing_state ?? null,
        billingZip: f.billing_zip ?? null,
        billingCountry: f.billing_country ?? 'India',
      },
      { ip: request.ip, raisedBy: 'Raised by the customer (checkout form)' },
    );

    const html = await renderGatewayForm(order, { ip: request.ip });
    return reply.type('text/html').send(html);
  };

  for (const path of ['/ccavRequestHandler', '/api/ccav/ccavRequestHandler']) {
    app.post(
      path,
      {
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
        schema: { tags: ['checkout'], summary: `Start a payment (${path})` },
      },
      handleCheckoutRequest,
    );
  }

  /** Where CCAvenue returns the customer once the payment is decided. */
  const handleGatewayCallback = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const encResp = typeof body?.encResp === 'string' ? body.encResp : undefined;
    const { redirectUrl } = await processCallback(encResp, {
      ip: request.ip,
      log: request.log,
    });
    return reply.redirect(redirectUrl, 302);
  };

  for (const path of ['/ccavResponseHandler', '/api/ccav/ccavResponseHandler']) {
    app.post(
      path,
      {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: { tags: ['checkout'], summary: `Gateway callback (${path})` },
      },
      handleGatewayCallback,
    );
  }
}
