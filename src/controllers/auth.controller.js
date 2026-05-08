const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../models/db');

const generateTokens = (userId, role) => {
  const access = jwt.sign({ userId, role }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const refresh = jwt.sign({ userId, role }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });
  return { access, refresh };
};

// POST /api/v1/auth/register/customer
const registerCustomer = async (req, res, next) => {
  try {
    const { email, phone, password, firstName, lastName } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const hash = await bcrypt.hash(password, 12);
    const { rows: [user] } = await query(
      `INSERT INTO users (email, phone, password_hash, role) VALUES ($1,$2,$3,'customer') RETURNING id, role`,
      [email.toLowerCase(), phone, hash]
    );
    await query(
      `INSERT INTO customers (user_id, first_name, last_name) VALUES ($1,$2,$3)`,
      [user.id, firstName, lastName]
    );

    const tokens = generateTokens(user.id, user.role);
    res.status(201).json({ user: { id: user.id, role: user.role }, ...tokens });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email or phone already in use' });
    next(err);
  }
};

// POST /api/v1/auth/register/vendor
const registerVendor = async (req, res, next) => {
  try {
    const { email, phone, password, businessName, firstName, lastName, trades, serviceZipCodes } = req.body;
    if (!email || !password || !businessName) {
      return res.status(400).json({ error: 'Email, password and business name required' });
    }
    const hash = await bcrypt.hash(password, 12);
    const { rows: [user] } = await query(
      `INSERT INTO users (email, phone, password_hash, role) VALUES ($1,$2,$3,'vendor') RETURNING id, role`,
      [email.toLowerCase(), phone, hash]
    );
    await query(
      `INSERT INTO vendors (user_id, business_name, first_name, last_name, trades, service_zip_codes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [user.id, businessName, firstName, lastName, trades || [], serviceZipCodes || []]
    );
    const tokens = generateTokens(user.id, user.role);
    res.status(201).json({ user: { id: user.id, role: user.role }, ...tokens });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email or phone already in use' });
    next(err);
  }
};

// POST /api/v1/auth/login
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { rows } = await query(
      `SELECT id, role, password_hash, is_active FROM users WHERE email = $1`,
      [email?.toLowerCase()]
    );
    const user = rows[0];
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.is_active) return res.status(403).json({ error: 'Account suspended' });

    const tokens = generateTokens(user.id, user.role);
    res.json({ user: { id: user.id, role: user.role }, ...tokens });
  } catch (err) { next(err); }
};

// POST /api/v1/auth/refresh
const refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const tokens = generateTokens(decoded.userId, decoded.role);
    res.json(tokens);
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
};

// POST /api/v1/auth/send-otp
const sendOtp = async (req, res, next) => {
  try {
    const { identifier } = req.body; // phone or email
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    await query(
      `INSERT INTO otp_codes (identifier, code, expires_at) VALUES ($1,$2,$3)`,
      [identifier, code, expiresAt]
    );
    const { sendSmsOtp } = require('../services/twilio.service');
    if (identifier.includes('@')) { /* send email */ } else { await sendSmsOtp(identifier, code); }
    console.log(`OTP for ${identifier}: ${code}`);
    res.json({ message: 'OTP sent', expiresIn: 600 });
  } catch (err) { next(err); }
};

// POST /api/v1/auth/verify-otp
const verifyOtp = async (req, res, next) => {
  try {
    const { identifier, code } = req.body;
    const { rows } = await query(
      `SELECT id FROM otp_codes
       WHERE identifier=$1 AND code=$2 AND used=FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [identifier, code]
    );
    if (!rows.length) return res.status(400).json({ error: 'Invalid or expired OTP' });
    await query(`UPDATE otp_codes SET used=TRUE WHERE id=$1`, [rows[0].id]);
    res.json({ verified: true });
  } catch (err) { next(err); }
};

// PUT /api/v1/auth/fcm-token
const updateFcmToken = async (req, res, next) => {
  try {
    const { fcmToken } = req.body;
    await query(`UPDATE users SET fcm_token=$1 WHERE id=$2`, [fcmToken, req.user.id]);
    res.json({ updated: true });
  } catch (err) { next(err); }
};

module.exports = { registerCustomer, registerVendor, login, refresh, sendOtp, verifyOtp, updateFcmToken };
