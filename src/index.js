require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes     = require('./routes/auth');
const customerRoutes = require('./routes/customer');
const vendorRoutes   = require('./routes/vendor');
const adminRoutes    = require('./routes/admin');
const webhookRoutes  = require('./routes/webhooks');
const uploadRoutes   = require('./routes/uploads');
const { initSocket } = require('./socket');
const { errorHandler, notFound } = require('./middleware/errorHandler');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(helmet());
const corsOrigin = process.env.ALLOWED_ORIGINS === '*' || !process.env.ALLOWED_ORIGINS
  ? '*'
  : process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(morgan('dev'));

// Stripe webhooks need raw body — must come before express.json()
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({ windowMs: 60000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

// Routes
app.use('/api/v1/auth',     authRoutes);
app.use('/api/v1/customer', customerRoutes);
app.use('/api/v1/vendor',   vendorRoutes);
app.use('/api/v1/admin',    adminRoutes);
app.use('/api/v1/uploads',  uploadRoutes);

app.get('/health', async (_, res) => {
  try {
    const { query } = require('./models/db');
    await query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date(), db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', message: err.message });
  }
});
app.use(notFound);
app.use(errorHandler);

initSocket(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 USG API on port ${PORT}`));

module.exports = { app, server };
