const twilio = require('twilio');

let client;
const getClient = () => {
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
};

// Send SMS OTP
const sendSmsOtp = async (phone, code) => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[SMS OTP] To ${phone}: ${code}`);
    return;
  }
  await getClient().messages.create({
    body: `Your USG verification code is: ${code}. Expires in 10 minutes.`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phone,
  });
};

// Create masked phone number proxy for vendor-customer calls
const createMaskedCall = async (customerPhone, vendorPhone) => {
  const proxyService = await getClient().proxy.v1.services(process.env.TWILIO_PROXY_SERVICE_SID)
    .sessions.create({ uniqueName: `session_${Date.now()}` });

  await proxyService.participants().create({ identifier: customerPhone });
  await proxyService.participants().create({ identifier: vendorPhone });

  return proxyService.sid;
};

module.exports = { sendSmsOtp, createMaskedCall };
