const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  registerCustomer, registerVendor, login, refresh,
  sendOtp, verifyOtp, updateFcmToken
} = require('../controllers/auth.controller');

router.post('/register/customer', registerCustomer);
router.post('/register/vendor',   registerVendor);
router.post('/login',             login);
router.post('/refresh',           refresh);
router.post('/send-otp',          sendOtp);
router.post('/verify-otp',        verifyOtp);
router.put('/fcm-token',          authenticate, updateFcmToken);

module.exports = router;
