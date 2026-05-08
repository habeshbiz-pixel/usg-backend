const express = require('express');
const router = express.Router();
const { handleWebhook } = require('../services/stripe.service');

router.post('/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    await handleWebhook(req.body, sig);
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
