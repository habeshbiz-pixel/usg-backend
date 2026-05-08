const { query } = require('../models/db');
const { getIo } = require('../socket');
const { notifyUser } = require('../services/notification.service');
const { calculateJobPrice } = require('../services/pricing.service');

// POST /api/v1/customer/jobs
const createJob = async (req, res, next) => {
  try {
    const { trade, urgency, description, photos, addressId, scheduledStart, aiTradeDetected, aiConfidence } = req.body;
    if (!trade) return res.status(400).json({ error: 'Trade is required' });

    const urgencyFees = { standard: 0, priority: 999, emergency: 2900 };
    const urgencyFee = urgencyFees[urgency] || 0;
    const estimated = calculateJobPrice({ urgency, urgencyFee });

    const { rows: [job] } = await query(
      `INSERT INTO jobs
         (customer_id, address_id, trade, urgency, description, photos, estimated_price_cents,
          urgency_fee_cents, ai_trade_detected, ai_confidence, scheduled_start)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [req.user.id, addressId, trade, urgency || 'standard', description,
       JSON.stringify(photos || []), estimated, urgencyFee,
       aiTradeDetected, aiConfidence, scheduledStart]
    );

    // Broadcast to nearby vendors via socket
    const io = getIo();
    io.to(`trade:${trade}`).emit('job:new', {
      jobId: job.id, trade, urgency, description,
      estimatedPayout: Math.floor(estimated * 0.7),
      distance: null // filled client-side from GPS
    });

    res.status(201).json({ job });
  } catch (err) { next(err); }
};

// GET /api/v1/customer/jobs
const getCustomerJobs = async (req, res, next) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    let q = `SELECT j.*, v.business_name, v.first_name as vendor_first, v.last_name as vendor_last,
               vl.lat as vendor_lat, vl.lng as vendor_lng
             FROM jobs j
             LEFT JOIN vendors v ON j.vendor_id = v.user_id
             LEFT JOIN vendor_locations vl ON j.vendor_id = vl.vendor_id
             WHERE j.customer_id = $1`;
    const params = [req.user.id];
    if (status) { q += ` AND j.status = $${params.length + 1}`; params.push(status); }
    q += ` ORDER BY j.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);
    const { rows } = await query(q, params);
    res.json({ jobs: rows });
  } catch (err) { next(err); }
};

// GET /api/v1/customer/jobs/:id
const getJobById = async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT j.*, v.business_name, v.first_name as vendor_first, v.last_name as vendor_last,
               v.reliability_score, vl.lat as vendor_lat, vl.lng as vendor_lng,
               a.line1, a.city, a.state, a.zip,
               a.lat as address_lat, a.lng as address_lng
       FROM jobs j
       LEFT JOIN vendors v ON j.vendor_id = v.user_id
       LEFT JOIN vendor_locations vl ON j.vendor_id = vl.vendor_id
       LEFT JOIN addresses a ON j.address_id = a.id
       WHERE j.id = $1 AND (j.customer_id = $2 OR j.vendor_id = $2)`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    res.json({ job: rows[0] });
  } catch (err) { next(err); }
};

// PUT /api/v1/customer/jobs/:id/cancel
const cancelJob = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const { rows } = await query(
      `UPDATE jobs SET status='cancelled', cancelled_at=NOW(), cancel_reason=$1
       WHERE id=$2 AND customer_id=$3 AND status IN ('pending','matched','accepted')
       RETURNING *`,
      [reason, req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Job not found or cannot be cancelled' });
    const job = rows[0];
    const io = getIo();
    if (job.vendor_id) {
      io.to(`user:${job.vendor_id}`).emit('job:cancelled_by_customer', { jobId: job.id });
      await notifyUser(job.vendor_id, 'Job Cancelled', 'The customer has cancelled the job.');
    }
    res.json({ job });
  } catch (err) { next(err); }
};

// POST /api/v1/customer/jobs/:id/rate
const rateJob = async (req, res, next) => {
  try {
    const { score, comment, tipCents } = req.body;
    if (!score || score < 1 || score > 5) return res.status(400).json({ error: 'Score must be 1-5' });

    const { rows: [job] } = await query(
      `SELECT * FROM jobs WHERE id=$1 AND customer_id=$2 AND status='completed'`,
      [req.params.id, req.user.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found or not completed' });
    if (job.customer_rated) return res.status(409).json({ error: 'Already rated' });

    await query(
      `INSERT INTO ratings (job_id, rater_id, ratee_id, score, comment) VALUES ($1,$2,$3,$4,$5)`,
      [job.id, req.user.id, job.vendor_id, score, comment]
    );
    await query(
      `UPDATE jobs SET customer_rated=TRUE, tip_cents=COALESCE($1,tip_cents) WHERE id=$2`,
      [tipCents, job.id]
    );
    // Update vendor reliability score (rolling average)
    await query(
      `UPDATE vendors SET reliability_score = (
         SELECT ROUND(AVG(score::numeric) * 20, 2) FROM ratings WHERE ratee_id = $1
       ) WHERE user_id = $1`,
      [job.vendor_id]
    );
    res.json({ rated: true });
  } catch (err) { next(err); }
};

// GET /api/v1/vendor/jobs/available
const getAvailableJobs = async (req, res, next) => {
  try {
    const { rows: [vendor] } = await query(
      `SELECT service_zip_codes, trades FROM vendors WHERE user_id=$1`, [req.user.id]
    );
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const { rows } = await query(
      `SELECT j.*, a.line1, a.city, a.state, a.zip, a.lat, a.lng,
               c.first_name as customer_first
       FROM jobs j
       LEFT JOIN addresses a ON j.address_id = a.id
       LEFT JOIN customers c ON j.customer_id = c.user_id
       WHERE j.status = 'pending'
         AND j.vendor_id IS NULL
         AND j.trade = ANY($1::text[])
         AND a.zip = ANY($2::text[])
       ORDER BY j.created_at DESC
       LIMIT 50`,
      [vendor.trades, vendor.service_zip_codes]
    );
    res.json({ jobs: rows });
  } catch (err) { next(err); }
};

// POST /api/v1/vendor/jobs/:id/accept
const acceptJob = async (req, res, next) => {
  try {
    const { rows: [job] } = await query(
      `UPDATE jobs SET vendor_id=$1, status='accepted', accepted_at=NOW()
       WHERE id=$2 AND status='pending' AND vendor_id IS NULL
       RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!job) return res.status(409).json({ error: 'Job already taken or not found' });

    const io = getIo();
    // Join vendor to this job's room
    io.to(`user:${req.user.id}`).socketsJoin(`job:${job.id}`);
    // Notify customer
    io.to(`user:${job.customer_id}`).emit('job:matched', {
      jobId: job.id, vendorId: req.user.id
    });
    await notifyUser(job.customer_id, 'Pro Found!', 'A pro has accepted your service request and is on their way.');
    res.json({ job });
  } catch (err) { next(err); }
};

// PUT /api/v1/vendor/jobs/:id/start
const startJob = async (req, res, next) => {
  try {
    const { rows: [job] } = await query(
      `UPDATE jobs SET status='in_progress', started_at=NOW()
       WHERE id=$1 AND vendor_id=$2 AND status='accepted'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const io = getIo();
    io.to(`user:${job.customer_id}`).emit('job:started', { jobId: job.id });
    res.json({ job });
  } catch (err) { next(err); }
};

// POST /api/v1/vendor/jobs/:id/complete
const completeJob = async (req, res, next) => {
  try {
    const { laborMinutes, partsCostCents } = req.body;
    const { rows: [job] } = await query(
      `SELECT * FROM jobs WHERE id=$1 AND vendor_id=$2 AND status='in_progress'`, [req.params.id, req.user.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found or not in progress' });

    const laborCost = Math.round((laborMinutes / 60) * job.hourly_rate_cents);
    const total = job.service_fee_cents + laborCost + (partsCostCents || 0) + job.urgency_fee_cents;

    await query(
      `UPDATE jobs SET status='completed', completed_at=NOW(), labor_minutes=$1,
         parts_cost_cents=$2, final_price_cents=$3
       WHERE id=$4`,
      [laborMinutes, partsCostCents || 0, total, job.id]
    );

    const io = getIo();
    io.to(`user:${job.customer_id}`).emit('job:price_change', {
      jobId: job.id, totalCents: total, requiresApproval: total > (job.estimated_price_cents * 1.2)
    });
    await notifyUser(job.customer_id, 'Job Complete', `Your service is complete. Total: $${(total/100).toFixed(2)}`);
    res.json({ finalPriceCents: total });
  } catch (err) { next(err); }
};

module.exports = {
  createJob, getCustomerJobs, getJobById, cancelJob, rateJob,
  getAvailableJobs, acceptJob, startJob, completeJob
};
