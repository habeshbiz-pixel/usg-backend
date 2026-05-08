const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getPresignedUploadUrl } = require('../services/s3.service');

// GET /api/v1/uploads/presign?type=image/jpeg
// Returns a presigned S3 URL for direct client upload
router.get('/presign', authenticate, async (req, res, next) => {
  try {
    const { type = 'image/jpeg' } = req.query;
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(type)) return res.status(400).json({ error: 'File type not allowed' });

    const result = await getPresignedUploadUrl(req.user.id, type);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/v1/uploads/confirm — confirm upload complete, return public URL
router.post('/confirm', authenticate, async (req, res, next) => {
  try {
    const { key } = req.body;
    if (key?.startsWith('mock-')) {
      return res.json({ url: null, key, mock: true });
    }
    if (!key || !key.startsWith(`uploads/${req.user.id}/`)) {
      return res.status(400).json({ error: 'Invalid key' });
    }
    res.json({ url: `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${key}`, key });
  } catch (err) { next(err); }
});

module.exports = router;
