const jwt = require('jsonwebtoken');
const { query } = require('../models/db');

let io;

const initSocket = (socketIo) => {
  io = socketIo;

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('No token'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      socket.role = decoded.role;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    console.log(`Socket connected: ${socket.userId} (${socket.role})`);

    // Each user joins their personal room
    socket.join(`user:${socket.userId}`);

    // Vendor joins trade rooms for job broadcasting
    if (socket.role === 'vendor') {
      const { rows: [vendor] } = await query(
        `SELECT trades FROM vendors WHERE user_id=$1`, [socket.userId]
      );
      if (vendor?.trades) {
        vendor.trades.forEach(trade => socket.join(`trade:${trade}`));
      }
    }

    // Join a specific job room (called from client when navigating to job)
    socket.on('join:job', (jobId) => {
      socket.join(`job:${jobId}`);
    });

    socket.on('leave:job', (jobId) => {
      socket.leave(`job:${jobId}`);
    });

    // Vendor location update (throttled client-side to 3s)
    socket.on('location:update', async ({ lat, lng, jobId }) => {
      if (socket.role !== 'vendor') return;
      await query(
        `INSERT INTO vendor_locations (vendor_id, lat, lng)
         VALUES ($1,$2,$3)
         ON CONFLICT (vendor_id) DO UPDATE SET lat=$2, lng=$3, updated_at=NOW()`,
        [socket.userId, lat, lng]
      );
      if (jobId) {
        io.to(`job:${jobId}`).emit('location:update', { vendorId: socket.userId, lat, lng });
      }
    });

    // Typing indicator
    socket.on('chat:typing', ({ jobId }) => {
      socket.to(`job:${jobId}`).emit('chat:typing', { userId: socket.userId });
    });

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.userId}`);
    });
  });
};

const getIo = () => {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
};

module.exports = { initSocket, getIo };
