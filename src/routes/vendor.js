const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { getAvailableJobs, getJobById, acceptJob, startJob, completeJob } = require('../controllers/jobs.controller');
const { getMessages, sendMessage } = require('../controllers/messages.controller');
const { query } = require('../models/db');

router.use(authenticate, requireRole('vendor'));

// ── Profile ──────────────────────────────────────────────
router.get('/profile', async (req, res, next) => {
  try {
    const { rows: [vendor] } = await query(
      `SELECT v.*, u.email, u.phone FROM vendors v
       JOIN users u ON v.user_id = u.id WHERE v.user_id=$1`, [req.user.id]
    );
    res.json({ vendor });
  } catch (err) { next(err); }
});

router.put('/profile', async (req, res, next) => {
  try {
    const { businessName, firstName, lastName, trades, serviceZipCodes, workingHours, notificationPreferences } = req.body;
    await query(
      `UPDATE vendors SET business_name=$1, first_name=$2, last_name=$3,
         trades=$4, service_zip_codes=$5, working_hours=$6,
         notification_preferences=COALESCE($7::jsonb, notification_preferences)
       WHERE user_id=$8`,
      [businessName, firstName, lastName, trades, serviceZipCodes,
       workingHours ? JSON.stringify(workingHours) : null,
       notificationPreferences ? JSON.stringify(notificationPreferences) : null,
       req.user.id]
    );
    res.json({ updated: true });
  } catch (err) { next(err); }
});

// ── Availability ─────────────────────────────────────────
router.put('/availability', async (req, res, next) => {
  try {
    const { isAvailable } = req.body;
    await query(`UPDATE vendors SET is_available=$1 WHERE user_id=$2`, [isAvailable, req.user.id]);
    res.json({ isAvailable });
  } catch (err) { next(err); }
});

// ── Jobs ─────────────────────────────────────────────────
router.get('/jobs/available',       getAvailableJobs);
router.get('/jobs/:id',             getJobById);
router.post('/jobs/:id/accept',     acceptJob);
router.put('/jobs/:id/start',       startJob);
router.post('/jobs/:id/complete',   completeJob);

// Add parts to a job
router.post('/jobs/:id/parts', async (req, res, next) => {
  try {
    const { name, sku, quantity, unitPriceCents } = req.body;
    const { rows: [part] } = await query(
      `INSERT INTO job_parts (job_id, name, sku, quantity, unit_price_cents)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, name, sku, quantity || 1, unitPriceCents]
    );
    res.status(201).json({ part });
  } catch (err) { next(err); }
});

// ── Chat ─────────────────────────────────────────────────
router.get('/chat/:jobId',          getMessages);
router.post('/chat/:jobId',         sendMessage);

// ── Earnings ─────────────────────────────────────────────
router.get('/earnings', async (req, res, next) => {
  try {
    const { period = '7' } = req.query;
    const { rows } = await query(
      `SELECT
         COUNT(*) as job_count,
         SUM(final_price_cents) as gross_cents,
         ROUND(SUM(final_price_cents) * 0.7) as payout_cents,
         DATE(completed_at) as date
       FROM jobs
       WHERE vendor_id=$1 AND status='completed'
         AND completed_at >= NOW() - INTERVAL '${parseInt(period)} days'
       GROUP BY DATE(completed_at)
       ORDER BY date DESC`,
      [req.user.id]
    );
    const { rows: [totals] } = await query(
      `SELECT SUM(final_price_cents) as total_gross,
              ROUND(SUM(final_price_cents) * 0.7) as total_payout,
              COUNT(*) as total_jobs
       FROM jobs WHERE vendor_id=$1 AND status='completed'`,
      [req.user.id]
    );
    res.json({ daily: rows, totals });
  } catch (err) { next(err); }
});

// ── Performance ───────────────────────────────────────────
router.get('/performance', async (req, res, next) => {
  try {
    const { rows: [vendor] } = await query(
      `SELECT reliability_score FROM vendors WHERE user_id=$1`, [req.user.id]
    );
    const { rows: ratingBreakdown } = await query(
      `SELECT score, COUNT(*) as count FROM ratings WHERE ratee_id=$1 GROUP BY score ORDER BY score DESC`,
      [req.user.id]
    );
    const { rows: [jobStats] } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status='completed') as completed,
         COUNT(*) FILTER (WHERE status='cancelled') as cancelled,
         COUNT(*) as total
       FROM jobs WHERE vendor_id=$1`,
      [req.user.id]
    );
    res.json({ reliabilityScore: vendor?.reliability_score, ratingBreakdown, jobStats });
  } catch (err) { next(err); }
});

router.get('/stats', async (req, res, next) => {
  try {
    const { rows: [stats] } = await query(`
      SELECT
        COUNT(*)                                          AS total_jobs,
        COUNT(*) FILTER (WHERE status = 'completed')     AS completed_jobs,
        COUNT(*) FILTER (WHERE status = 'in_progress')   AS active_jobs,
        COUNT(*) FILTER (WHERE status = 'accepted')      AS accepted_jobs,
        COALESCE(SUM(final_price_cents)
          FILTER (WHERE status = 'completed'), 0)        AS total_earnings,
        COALESCE(ROUND(SUM(final_price_cents)
          FILTER (WHERE status = 'completed') * 0.7), 0) AS total_payout
      FROM jobs WHERE vendor_id = $1
    `, [req.user.id]);
    res.json({ stats });
  } catch (err) { next(err); }
});

module.exports = router;
