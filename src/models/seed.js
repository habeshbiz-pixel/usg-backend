require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, query } = require('./db');

// ── Helpers ──────────────────────────────────────────────────────────────────

const hash = (pw) => bcrypt.hash(pw, 10);

const insertUser = async (email, phone, password, role) => {
  const h = await hash(password);
  const { rows: [user] } = await query(
    `INSERT INTO users (email, phone, password_hash, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, role`,
    [email, phone, h, role]
  );
  return user;
};

// ── Seed ─────────────────────────────────────────────────────────────────────

const seed = async () => {
  console.log('Seeding database...');

  // ── Admin ─────────────────────────────────────────────────────────────────
  const admin = await insertUser('admin@usg.com', null, 'Admin1234!', 'admin');
  console.log(`  admin:    ${admin.id}  (admin@usg.com / Admin1234!)`);

  // ── Customers ─────────────────────────────────────────────────────────────
  const cust1 = await insertUser('marcus@example.com', '+12125550101', 'Test1234!', 'customer');
  await query(
    `INSERT INTO customers (user_id, first_name, last_name, subscription_tier, subscription_status)
     VALUES ($1, 'Marcus', 'Davis', 'plus', 'active')
     ON CONFLICT (user_id) DO NOTHING`,
    [cust1.id]
  );

  const { rows: [addr1] } = await query(
    `INSERT INTO addresses (user_id, label, line1, city, state, zip, lat, lng, is_default)
     VALUES ($1, 'Home', '245 W 10th St', 'New York', 'NY', '10014',
             40.7338, -74.0027, TRUE)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [cust1.id]
  );

  console.log(`  customer: ${cust1.id}  (marcus@example.com / Test1234!)`);

  const cust2 = await insertUser('sandra@example.com', '+14045550102', 'Test1234!', 'customer');
  await query(
    `INSERT INTO customers (user_id, first_name, last_name, subscription_tier, subscription_status)
     VALUES ($1, 'Sandra', 'Kim', 'basic', 'active')
     ON CONFLICT (user_id) DO NOTHING`,
    [cust2.id]
  );

  const { rows: [addr2] } = await query(
    `INSERT INTO addresses (user_id, label, line1, city, state, zip, lat, lng, is_default)
     VALUES ($1, 'Home', '800 Peachtree St NE', 'Atlanta', 'GA', '30308',
             33.7749, -84.3878, TRUE)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [cust2.id]
  );

  console.log(`  customer: ${cust2.id}  (sandra@example.com / Test1234!)`);

  // ── Vendors ───────────────────────────────────────────────────────────────
  const vend1 = await insertUser('james.plumbing@example.com', '+12125550201', 'Vendor1234!', 'vendor');
  await query(
    `INSERT INTO vendors
       (user_id, business_name, first_name, last_name, trades, service_zip_codes,
        is_available, is_approved, reliability_score)
     VALUES ($1, 'James Pipe & HVAC', 'James', 'Carter',
             ARRAY['Plumbing','HVAC'],
             ARRAY['10001','10002','10003','10011','10014'],
             TRUE, TRUE, 92.50)
     ON CONFLICT (user_id) DO NOTHING`,
    [vend1.id]
  );
  console.log(`  vendor:   ${vend1.id}  (james.plumbing@example.com / Vendor1234!)  NYC - Plumbing/HVAC`);

  const vend2 = await insertUser('lisa.electric@example.com', '+12125550202', 'Vendor1234!', 'vendor');
  await query(
    `INSERT INTO vendors
       (user_id, business_name, first_name, last_name, trades, service_zip_codes,
        is_available, is_approved, reliability_score)
     VALUES ($1, 'Lisa Spark Electric', 'Lisa', 'Monroe',
             ARRAY['Electrical','Appliance'],
             ARRAY['10001','10002','10003','10004','10005'],
             TRUE, TRUE, 88.00)
     ON CONFLICT (user_id) DO NOTHING`,
    [vend2.id]
  );
  console.log(`  vendor:   ${vend2.id}  (lisa.electric@example.com / Vendor1234!)  NYC - Electrical/Appliance`);

  const vend3 = await insertUser('darius.fix@example.com', '+14045550203', 'Vendor1234!', 'vendor');
  await query(
    `INSERT INTO vendors
       (user_id, business_name, first_name, last_name, trades, service_zip_codes,
        is_available, is_approved, reliability_score)
     VALUES ($1, 'Darius Fix-All Services', 'Darius', 'Webb',
             ARRAY['Plumbing','Electrical','Carpentry'],
             ARRAY['30301','30302','30303','30308','30309'],
             TRUE, TRUE, 85.00)
     ON CONFLICT (user_id) DO NOTHING`,
    [vend3.id]
  );
  console.log(`  vendor:   ${vend3.id}  (darius.fix@example.com / Vendor1234!)  ATL - Multi-trade`);

  // ── Sample pending jobs ───────────────────────────────────────────────────
  if (addr1) {
    const { rows: [job1] } = await query(
      `INSERT INTO jobs
         (customer_id, address_id, trade, urgency, description,
          estimated_price_cents, service_fee_cents, hourly_rate_cents, urgency_fee_cents, status)
       VALUES ($1, $2, 'Plumbing', 'emergency',
               'Burst pipe under the kitchen sink — water is pooling fast.',
               24700, 8900, 6500, 2900, 'pending')
       RETURNING id`,
      [cust1.id, addr1.id]
    );
    console.log(`  job (pending/emergency): ${job1.id}  — Plumbing NYC`);
  }

  if (addr1) {
    await query(
      `INSERT INTO jobs
         (customer_id, address_id, trade, urgency, description,
          estimated_price_cents, service_fee_cents, hourly_rate_cents, urgency_fee_cents, status)
       VALUES ($1, $2, 'HVAC', 'priority',
               'AC unit runs but blows warm air. Possibly low refrigerant.',
               16200, 8900, 6500, 999, 'pending')`,
      [cust1.id, addr1.id]
    );
  }

  if (addr2) {
    await query(
      `INSERT INTO jobs
         (customer_id, address_id, trade, urgency, description,
          estimated_price_cents, service_fee_cents, hourly_rate_cents, urgency_fee_cents, status)
       VALUES ($1, $2, 'Electrical', 'standard',
               'Install 2 smart light switches and an outdoor GFCI outlet. Permit on file.',
               19500, 8900, 6500, 0, 'pending')`,
      [cust2.id, addr2.id]
    );
  }

  console.log('\nSeed complete.');
};

seed()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  })
  .finally(() => pool.end());
