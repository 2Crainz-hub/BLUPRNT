import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';

// Stripe (secret key lives only here, server-side).
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

// Stripe needs the raw request body to verify the signature — disable body parsing.
export const config = { api: { bodyParser: false } };

// Map the purchased Stripe PRODUCT -> our internal tier.
// (Display names are Pro/Elite; internal keys stay basic/advanced.)
const PRODUCT_TIER: Record<string, 'basic' | 'advanced'> = {
  prod_V1Lt2WJCaVjCX9: 'basic',    // BLUPRNT Pro   ($29)
  prod_V1LuFPJacooOax: 'advanced', // BLUPRNT Elite ($79)
};

async function rawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

// Update the profiles row (service key bypasses RLS — server only).
async function patchProfile(filter: string, body: Record<string, unknown>) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY as string,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY as string}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error('profile patch failed', res.status, await res.text());
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  let event: Stripe.Event;
  try {
    const sig = req.headers['stripe-signature'] as string;
    const buf = await rawBody(req);
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET as string);
  } catch (err: any) {
    res.status(400).send(`Signature verification failed: ${err.message}`);
    return;
  }

  try {
    // Someone paid -> upgrade them.
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object as Stripe.Checkout.Session;
      const userId = s.client_reference_id; // our Supabase user id, passed on the payment link
      const email = s.customer_details?.email || undefined; // fallback identifier
      const customer = typeof s.customer === 'string' ? s.customer : s.customer?.id;
      const items = await stripe.checkout.sessions.listLineItems(s.id, { limit: 1 });
      const product = items.data[0]?.price?.product as string | undefined;
      const tier = product ? PRODUCT_TIER[product] : undefined;
      if (tier) {
        if (userId) {
          await patchProfile(`id=eq.${userId}`, { tier, stripe_customer: customer });
        } else if (email) {
          // no user id on the link -> match by the email used at checkout
          await patchProfile(`email=eq.${encodeURIComponent(email)}`, { tier, stripe_customer: customer });
        }
      }
    }

    // Subscription cancelled/ended -> back to free.
    else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription;
      const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      await patchProfile(`stripe_customer=eq.${customer}`, { tier: 'free' });
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error('handler error', err);
    res.status(500).send(`Handler error: ${err.message}`);
  }
}
