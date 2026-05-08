const { query } = require('../models/db');

let admin;
const getAdmin = () => {
  if (!admin && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    }
  }
  return admin;
};

const notifyUser = async (userId, title, body, data = {}) => {
  try {
    const { rows: [user] } = await query(`SELECT fcm_token FROM users WHERE id=$1`, [userId]);
    if (!user?.fcm_token) return;
    const fb = getAdmin();
    if (!fb) { console.log(`[PUSH] ${userId}: ${title} — ${body}`); return; }
    await fb.messaging().send({
      token: user.fcm_token,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { sound: 'default' } },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    });
  } catch (err) {
    if (err.code !== 'messaging/registration-token-not-registered') console.error('Push error:', err.message);
  }
};

const notifyMultiple = async (userIds, title, body, data = {}) =>
  Promise.allSettled(userIds.map(id => notifyUser(id, title, body, data)));

const notifyTopic = async (topic, title, body, data = {}) => {
  try {
    const fb = getAdmin();
    if (!fb) { console.log(`[PUSH TOPIC] ${topic}: ${title}`); return; }
    await fb.messaging().send({ topic, notification: { title, body }, data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])) });
  } catch (err) { console.error('Topic push error:', err.message); }
};

module.exports = { notifyUser, notifyMultiple, notifyTopic };
