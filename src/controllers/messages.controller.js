const { query } = require('../models/db');
const { getIo } = require('../socket');

// GET /api/v1/customer/chat/:jobId
const getMessages = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    // Verify user is part of this job
    const { rows: [job] } = await query(
      `SELECT id FROM jobs WHERE id=$1 AND (customer_id=$2 OR vendor_id=$2)`,
      [jobId, req.user.id]
    );
    if (!job) return res.status(403).json({ error: 'Access denied' });

    const { rows } = await query(
      `SELECT m.*, u.role as sender_role FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.job_id = $1 ORDER BY m.sent_at ASC`,
      [jobId]
    );
    // Mark unread as read
    await query(
      `UPDATE messages SET read_at=NOW()
       WHERE job_id=$1 AND sender_id != $2 AND read_at IS NULL`,
      [jobId, req.user.id]
    );
    res.json({ messages: rows });
  } catch (err) { next(err); }
};

// POST /api/v1/customer/chat/:jobId
const sendMessage = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { content, mediaUrl, msgType } = req.body;

    const { rows: [job] } = await query(
      `SELECT * FROM jobs WHERE id=$1 AND (customer_id=$2 OR vendor_id=$2)`,
      [jobId, req.user.id]
    );
    if (!job) return res.status(403).json({ error: 'Access denied' });

    const { rows: [msg] } = await query(
      `INSERT INTO messages (job_id, sender_id, content, media_url, msg_type)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [jobId, req.user.id, content, mediaUrl, msgType || 'text']
    );

    // Emit via socket to job room
    const io = getIo();
    io.to(`job:${jobId}`).emit('chat:message', msg);

    res.status(201).json({ message: msg });
  } catch (err) { next(err); }
};

module.exports = { getMessages, sendMessage };
