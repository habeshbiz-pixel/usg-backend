const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { query } = require('../models/db');

router.use(authenticate, requireRole('admin'));

router.get('/vendors', async (req, res, next) => {
  try {
    const { approved, limit = 50, offset = 0 } = req.query;
    let q = `SELECT v.*, u.email, u.phone FROM vendors v JOIN users u ON v.user_id=u.id`;
    const params = [];
    if (approved !== undefined) { q += ` WHERE v.is_approved=$1`; params.push(approved === 'true'); }
    q += ` ORDER BY v.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);
    const { rows } = await query(q, params);
    res.json({ vendors: rows });
  } catch (err) { next(err); }
});

router.put('/vendors/:id/approve', async (req, res, next) => {
  try {
    await query(`UPDATE vendors SET is_approved=TRUE WHERE user_id=$1`, [req.params.id]);
    res.json({ approved: true });
  } catch (err) { next(err); }
});

router.put('/vendors/:id/suspend', async (req, res, next) => {
  try {
    await query(`UPDATE users SET is_active=FALSE WHERE id=$1`, [req.params.id]);
    res.json({ suspended: true });
  } catch (err) { next(err); }
});

router.get('/disputes', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT d.*, j.trade, j.final_price_cents FROM disputes d
       JOIN jobs j ON d.job_id=j.id ORDER BY d.created_at DESC LIMIT 50`
    );
    res.json({ disputes: rows });
  } catch (err) { next(err); }
});

router.put('/disputes/:id/resolve', async (req, res, next) => {
  try {
    const { resolution } = req.body;
    await query(
      `UPDATE disputes SET status='resolved', resolution=$1, resolved_at=NOW() WHERE id=$2`,
      [resolution, req.params.id]
    );
    res.json({ resolved: true });
  } catch (err) { next(err); }
});

router.get('/stats', async (req, res, next) => {
  try {
    const { rows: [stats] } = await query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role='customer') as total_customers,
        (SELECT COUNT(*) FROM vendors WHERE is_approved=TRUE) as active_vendors,
        (SELECT COUNT(*) FROM jobs WHERE status='completed') as completed_jobs,
        (SELECT SUM(final_price_cents) FROM jobs WHERE status='completed') as gross_revenue_cents
    `);
    res.json({ stats });
  } catch (err) { next(err); }
});

module.exports = router;
