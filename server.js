require('dotenv').config();
const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const upload = multer({ dest: 'uploads/' });

// CORS headers for Cloudflare tunnel and cross-origin requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Serve frontend files

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error(err));

// Schema
const orderSchema = new mongoose.Schema({
  otp: { type: String, unique: true },
  files: [String], // Paths to files
  options: Object, // {copies, pageSelection, colorMode, orientation, pagesPerSheet}
  price: Number,
  status: { type: String, default: 'pending' } // 'pending' or 'paid'
});
const Order = mongoose.model('Order', orderSchema);

// Generate unique 6-digit OTP
async function generateOTP() {
  let otp;
  do {
    otp = Math.floor(100000 + Math.random() * 900000).toString();
  } while (await Order.findOne({ otp }));
  return otp;
}

// Route for uploading and processing (Pay Now or Pay Later)
app.post('/process', upload.array('documents'), async (req, res) => {
  try {
    const { payMethod, options, price } = req.body;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const parsedOptions = JSON.parse(options);
    let orderId;
    let isTemp = false;

    if (payMethod === 'payLater') {
      orderId = await generateOTP();
    } else {
      orderId = 'cf_' + Date.now() + Math.random().toString(36).substring(7);
      isTemp = true;
    }

    const uploadDir = path.join(__dirname, 'uploads', orderId);
    fs.mkdirSync(uploadDir, { recursive: true });

    const filePaths = req.files.map(file => {
      const newPath = path.join(uploadDir, file.originalname);
      fs.renameSync(file.path, newPath);
      return newPath;
    });

    // Save to DB
    const newOrder = new Order({
      otp: orderId, // Use temp ID for Pay Now, OTP for Pay Later
      files: filePaths,
      options: parsedOptions,
      price: parseFloat(price),
      status: 'pending'
    });
    await newOrder.save();

    if (payMethod === 'payLater') {
      return res.json({ otp: orderId });
    } else if (payMethod === 'payNow') {
      try {
        const response = await axios.post('https://api.cashfree.com/pg/orders', {
          order_id: orderId,
          order_amount: parseFloat(price),
          order_currency: 'INR',
          customer_details: {
            customer_id: orderId,
            customer_name: 'Guest',
            customer_email: 'guest@example.com',
            customer_phone: '8421007625'
          },
          order_note: 'Print order'
        }, {
          headers: {
            'x-client-id': process.env.CASHFREE_APP_ID,
            'x-client-secret': process.env.CASHFREE_SECRET,
            'x-api-version': '2023-08-01'
          }
        });

        console.log('Cashfree Response:', JSON.stringify(response.data, null, 2));

        const sessionId = response.data.payment_session_id;
        if (!sessionId) {
          console.error('Missing session ID in response:', response.data);
          throw new Error('No session ID returned from Cashfree');
        }

        res.json({ sessionId, orderId });
      } catch (paymentErr) {
        console.error('Cashfree Error:', paymentErr.response?.data || paymentErr.message);
        res.status(500).json({ error: 'Payment gateway error. Please use Pay Later instead.', code: 'GATEWAY_ERROR' });
      }
    }
  } catch (err) {
    console.error('Process error:', err.message);
    res.status(500).json({ error: 'Failed to process order' });
  }
});

// New endpoint to verify payment and generate OTP
app.get('/verify-payment/:orderId', async (req, res) => {
  const { orderId } = req.params;
  try {
    const order = await Order.findOne({ otp: orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'paid') return res.json({ otp: order.otp }); // Already verified

    // Verify with Cashfree
    const response = await axios.get(`https://api.cashfree.com/pg/orders/${orderId}`, {
      headers: {
        'x-client-id': process.env.CASHFREE_APP_ID,
        'x-client-secret': process.env.CASHFREE_SECRET,
        'x-api-version': '2023-08-01'
      }
    });

    if (response.data.order_status === 'PAID') {
      const otp = await generateOTP();
      const oldPath = path.join(__dirname, 'uploads', orderId);
      const newPath = path.join(__dirname, 'uploads', otp);

      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath);
      }

      const updatedFiles = order.files.map(f => f.replace(orderId, otp));

      await Order.updateOne({ otp: orderId }, {
        otp: otp,
        status: 'paid',
        files: updatedFiles
      });

      res.json({ success: true, otp });
    } else {
      res.status(400).json({ error: 'Payment not completed' });
    }
  } catch (err) {
    console.error('Verification error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Webhook for Cashfree (optional but good for backup)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];
  const rawBody = req.body.toString();

  // Verify signature (use Cashfree's verification method)
  const expectedSignature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET)
    .update(timestamp + rawBody)
    .digest('base64');

  if (signature !== expectedSignature) {
    return res.status(401).send('Invalid signature');
  }

  const payload = JSON.parse(rawBody);
  if (payload.data.order.order_id && payload.event === 'PAYMENT_SUCCESS') {
    await Order.updateOne({ otp: payload.data.order.order_id }, { status: 'paid' });
  }
  // Logic here could also trigger the OTP generation if not already done
  res.sendStatus(200);
});

// Admin route to view order by OTP
app.get('/admin', (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>Admin: Enter OTP</h1>
        <form method="POST" action="/admin">
          <input type="text" name="otp" placeholder="Enter OTP" required>
          <button type="submit">Check</button>
        </form>
      </body>
    </html>
  `);
});

app.post('/admin', async (req, res) => {
  const { otp } = req.body;
  const order = await Order.findOne({ otp });
  if (!order) {
    return res.send('<h2>Invalid OTP</h2>');
  }
  res.send(`
    <h1>Order Details for OTP: ${otp}</h1>
    <p>Status: ${order.status}</p>
    <p>Price: ₹${order.price}</p>
    <p>Options: ${JSON.stringify(order.options)}</p>
    <h2>Files:</h2>
    <ul>${order.files.map(file => `<li><a href="/download/${path.basename(file)}?otp=${otp}" download>${path.basename(file)}</a></li>`).join('')}</ul>
  `);
});

// Serve file downloads (secured by OTP in query)
app.get('/download/:filename', (req, res) => {
  const { otp } = req.query;
  const filePath = path.join(__dirname, 'uploads', otp, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(process.env.PORT, () => console.log(`Server running on port ${process.env.PORT}`));