const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { query } = require('../models/db');

// Create Stripe customer for new customer account
const createStripeCustomer = async (userId, email) => {
  const customer = await stripe.customers.create({ email, metadata: { userId } });
  await query(`UPDATE customers SET stripe_customer_id=$1 WHERE user_id=$2`, [customer.id, userId]);
  return customer;
};

// Create Stripe Connect Express account for vendor
const createVendorAccount = async (userId, email) => {
  const account = await stripe.accounts.create({
    type: 'express',
    email,
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    metadata: { userId }
  });
  await query(`UPDATE vendors SET stripe_account_id=$1 WHERE user_id=$2`, [account.id, userId]);
  return account;
};

// Onboarding link for vendor to complete KYC
const getVendorOnboardingLink = async (accountId, returnUrl, refreshUrl) => {
  return stripe.accountLinks.create({
    account: accountId,
    return_url: returnUrl,
    refresh_url: refreshUrl,
    type: 'account_onboarding',
  });
};

// Create subscription for customer
const createSubscription = async (customerId, stripeCustomerId, tier) => {
  const priceIds = {
    basic:   process.env.STRIPE_PRICE_BASIC,
    plus:    process.env.STRIPE_PRICE_PLUS,
    premium: process.env.STRIPE_PRICE_PREMIUM,
  };
  const subscription = await stripe.subscriptions.create({
    customer: stripeCustomerId,
    items: [{ price: priceIds[tier] }],
    payment_behavior: 'default_incomplete',
    expand: ['latest_invoice.payment_intent'],
  });
  return subscription;
};

// Charge customer and split payout to vendor
const chargeAndPayout = async (jobId, customerId, vendorId, amountCents) => {
  const { rows: [cust] } = await query(
    `SELECT stripe_customer_id FROM customers WHERE user_id=$1`, [customerId]
  );
  const { rows: [vend] } = await query(
    `SELECT stripe_account_id FROM vendors WHERE user_id=$1`, [vendorId]
  );

  if (process.env.NODE_ENV === 'development' && !process.env.STRIPE_SECRET_KEY?.startsWith('sk_')) {
    await query(`UPDATE jobs SET payment_status = 'paid' WHERE id = $1`, [jobId]);
    return { mock: true, amount: amountCents };
  }

  if (!cust?.stripe_customer_id || !vend?.stripe_account_id) {
    if (process.env.NODE_ENV === 'development') {
      await query(`UPDATE jobs SET payment_status = 'paid' WHERE id = $1`, [jobId]);
      return { mock: true, amount: amountCents };
    }
    throw new Error('Stripe accounts not configured');
  }

  const vendorAmount = Math.round(amountCents * 0.7);

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    customer: cust.stripe_customer_id,
    confirm: true,
    transfer_data: {
      amount: vendorAmount,
      destination: vend.stripe_account_id,
    },
    metadata: { jobId },
  });

  return { paymentIntent, vendorAmount, platformAmount: amountCents - vendorAmount };
};

// Handle Stripe webhooks
const handleWebhook = async (rawBody, signature) => {
  const event = stripe.webhooks.constructEvent(
    rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET
  );
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      if (pi.metadata?.jobId) {
        await query(
          `UPDATE jobs SET payment_status='paid' WHERE id=$1`,
          [pi.metadata.jobId]
        );
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      if (pi.metadata?.jobId) {
        await query(
          `UPDATE jobs SET payment_status='failed' WHERE id=$1`,
          [pi.metadata.jobId]
        );
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await query(
        `UPDATE customers SET subscription_status='cancelled' WHERE stripe_customer_id=$1`,
        [sub.customer]
      );
      break;
    }
  }
  return event;
};

module.exports = {
  createStripeCustomer, createVendorAccount, getVendorOnboardingLink,
  createSubscription, chargeAndPayout, handleWebhook
};
