const URGENCY_FEES = {
  standard:  0,
  priority:  999,   // $9.99
  emergency: 2900,  // $29.00
};

const SERVICE_FEE = 8900;   // $89.00
const HOURLY_RATE = 6500;   // $65.00/hr
const AVG_HOURS   = 1.5;

const calculateJobPrice = ({ urgency = 'standard' }) => {
  const urgencyFee = URGENCY_FEES[urgency] || 0;
  const laborEstimate = Math.round(HOURLY_RATE * AVG_HOURS);
  const partsEstimate = 2500; // $25 midpoint estimate
  return SERVICE_FEE + laborEstimate + partsEstimate + urgencyFee;
};

const calculateVendorPayout = (totalCents) => {
  const instant = Math.round(totalCents * 0.7);
  const held    = totalCents - instant;
  return { instant, held, total: totalCents };
};

const getSubscriptionPricing = () => ({
  customer: {
    basic:   { monthly: 1999, annual: 19999 },
    plus:    { monthly: 4999, annual: 49999 },
    premium: { monthly: 9999, annual: 99999 },
  },
  vendor: {
    essential:  { monthly: 4999, annual: 49999 },
    pro:        { monthly: 9999, annual: 99999 },
    enterprise: { monthly: 19999, annual: 199999 },
  },
});

module.exports = { calculateJobPrice, calculateVendorPayout, getSubscriptionPricing, URGENCY_FEES, SERVICE_FEE, HOURLY_RATE };
