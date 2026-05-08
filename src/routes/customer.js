const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { createJob, getCustomerJobs, getJobById, cancelJob, rateJob } = require('../controllers/jobs.controller');
const { getMessages, sendMessage } = require('../controllers/messages.controller');
const { query } = require('../models/db');
const { getSubscriptionPricing } = require('../services/pricing.service');
const { createStripeCustomer, createSubscription } = require('../services/stripe.service');

router.use(authenticate, requireRole('customer'));

// ── Profile ──────────────────────────────────────────────
router.get('/profile', async (req, res, next) => {
  try {
    const { rows: [customer] } = await query(
      `SELECT c.*, u.email, u.phone FROM customers c
       JOIN users u ON c.user_id = u.id WHERE c.user_id=$1`, [req.user.id]
    );
    res.json({ customer });
  } catch (err) { next(err); }
});

router.put('/profile', async (req, res, next) => {
  try {
    const { firstName, lastName, homeAddress, notificationPreferences } = req.body;
    await query(
      `UPDATE customers SET first_name=$1, last_name=$2, home_address=$3,
        notification_preferences=COALESCE($4::jsonb, notification_preferences)
       WHERE user_id=$5`,
      [firstName, lastName, homeAddress ? JSON.stringify(homeAddress) : null,
       notificationPreferences ? JSON.stringify(notificationPreferences) : null,
       req.user.id]
    );
    res.json({ updated: true });
  } catch (err) { next(err); }
});

// ── Addresses ────────────────────────────────────────────
router.get('/addresses', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM addresses WHERE user_id=$1 ORDER BY is_default DESC`, [req.user.id]);
    res.json({ addresses: rows });
  } catch (err) { next(err); }
});

router.post('/addresses', async (req, res, next) => {
  try {
    const { label, line1, line2, city, state, zip, lat, lng, isDefault } = req.body;
    if (isDefault) await query(`UPDATE addresses SET is_default=FALSE WHERE user_id=$1`, [req.user.id]);
    const { rows: [addr] } = await query(
      `INSERT INTO addresses (user_id,label,line1,line2,city,state,zip,lat,lng,is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.id, label, line1, line2, city, state, zip, lat, lng, !!isDefault]
    );
    res.status(201).json({ address: addr });
  } catch (err) { next(err); }
});

// ── Jobs ─────────────────────────────────────────────────
router.post('/jobs',              createJob);
router.get('/jobs',               getCustomerJobs);
router.get('/jobs/:id',           getJobById);
router.put('/jobs/:id/cancel',    cancelJob);
router.post('/jobs/:id/rate',     rateJob);

// ── Chat ─────────────────────────────────────────────────
router.get('/chat/:jobId',        getMessages);
router.post('/chat/:jobId',       sendMessage);

// ── Subscription ─────────────────────────────────────────
router.get('/subscription', async (req, res, next) => {
  try {
    const { rows: [c] } = await query(
      `SELECT subscription_tier, subscription_status, subscription_end, stripe_customer_id
       FROM customers WHERE user_id=$1`, [req.user.id]
    );
    res.json({ subscription: c, pricing: getSubscriptionPricing().customer });
  } catch (err) { next(err); }
});

router.put('/subscription/change', async (req, res, next) => {
  try {
    const { tier } = req.body;
    if (!['basic','plus','premium'].includes(tier)) return res.status(400).json({ error: 'Invalid tier' });
    await query(`UPDATE customers SET subscription_tier=$1 WHERE user_id=$2`, [tier, req.user.id]);
    res.json({ tier });
  } catch (err) { next(err); }
});

router.post('/subscription/create', async (req, res, next) => {
  try {
    const { tier = 'basic' } = req.body;
    if (!['basic','plus','premium'].includes(tier)) return res.status(400).json({ error: 'Invalid tier' });

    const { rows: [customer] } = await query(
      `SELECT stripe_customer_id FROM customers WHERE user_id=$1`, [req.user.id]
    );
    const { rows: [user] } = await query(`SELECT email FROM users WHERE id=$1`, [req.user.id]);

    let stripeCustomerId = customer?.stripe_customer_id;
    if (!stripeCustomerId) {
      const stripeCustomer = await createStripeCustomer(user.email, req.user.id);
      stripeCustomerId = stripeCustomer.id;
      await query(`UPDATE customers SET stripe_customer_id=$1 WHERE user_id=$2`, [stripeCustomerId, req.user.id]);
    }

    const subscription = await createSubscription(req.user.id, stripeCustomerId, tier);
    await query(
      `UPDATE customers SET subscription_tier=$1, subscription_status='active' WHERE user_id=$2`,
      [tier, req.user.id]
    );
    res.json({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice?.payment_intent?.client_secret,
      tier,
    });
  } catch (err) { next(err); }
});

router.delete('/subscription/cancel', async (req, res, next) => {
  try {
    const { rows: [customer] } = await query(
      `SELECT stripe_customer_id FROM customers WHERE user_id=$1`, [req.user.id]
    );
    if (customer?.stripe_customer_id) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const subs = await stripe.subscriptions.list({ customer: customer.stripe_customer_id, status: 'active', limit: 1 });
      if (subs.data.length > 0) {
        await stripe.subscriptions.cancel(subs.data[0].id);
      }
    }
    await query(
      `UPDATE customers SET subscription_status='cancelled', subscription_tier='basic' WHERE user_id=$1`,
      [req.user.id]
    );
    res.json({ cancelled: true });
  } catch (err) { next(err); }
});

// ── Price approval ────────────────────────────────────────
// Called by the customer when they approve the final price after a job
// completes. Triggers the Stripe charge + vendor payout.
router.post('/jobs/:id/approve-price', async (req, res, next) => {
  try {
    const { rows: [job] } = await query(
      `SELECT * FROM jobs WHERE id=$1 AND customer_id=$2 AND status='completed'`,
      [req.params.id, req.user.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found or not completed' });
    if (job.payment_status === 'paid') return res.json({ alreadyPaid: true });
    if (!job.vendor_id) return res.status(400).json({ error: 'No vendor assigned to this job' });

    const { chargeAndPayout } = require('../services/stripe.service');
    const result = await chargeAndPayout(
      job.id, req.user.id, job.vendor_id, job.final_price_cents
    );

    await query(
      `UPDATE jobs SET payment_status='paid' WHERE id=$1`,
      [job.id]
    );

    res.json({ paid: true, paymentIntentId: result.mock ? null : result.paymentIntent.id });
  } catch (err) { next(err); }
});

// ── Maintenance checklist ─────────────────────────────────
router.get('/maintenance-score', async (req, res, next) => {
  try {
    const { rows: [c] } = await query(`SELECT maintenance_score FROM customers WHERE user_id=$1`, [req.user.id]);
    res.json({ score: c?.maintenance_score || 0 });
  } catch (err) { next(err); }
});

router.get('/checklist', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT task_id FROM customer_checklist WHERE user_id=$1`, [req.user.id]);
    res.json({ completedIds: rows.map(r => r.task_id) });
  } catch (err) { next(err); }
});

router.post('/checklist/complete', async (req, res, next) => {
  try {
    const { taskId, points = 5 } = req.body;
    if (!taskId) return res.status(400).json({ error: 'taskId required' });
    await query(
      `INSERT INTO customer_checklist (user_id, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.id, taskId]
    );
    await query(
      `UPDATE customers SET maintenance_score=LEAST(100, maintenance_score+$1) WHERE user_id=$2`,
      [points, req.user.id]
    );
    const { rows: [c] } = await query(`SELECT maintenance_score FROM customers WHERE user_id=$1`, [req.user.id]);
    res.json({ updated: true, score: c?.maintenance_score || 0 });
  } catch (err) { next(err); }
});

module.exports = router;
