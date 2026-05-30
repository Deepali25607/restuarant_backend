const crypto = require('crypto')

let RazorpaySDK
try {
  RazorpaySDK = require('razorpay')
} catch {
  RazorpaySDK = null
}

const KEY_ID = process.env.RAZORPAY_KEY_ID
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET

const configured = Boolean(RazorpaySDK && KEY_ID && KEY_SECRET)

let client = null
if (configured) {
  client = new RazorpaySDK({ key_id: KEY_ID, key_secret: KEY_SECRET })
}

function status() {
  return {
    configured,
    keyId: configured ? KEY_ID : null,
    mode: configured && KEY_ID.startsWith('rzp_live') ? 'live' : 'test',
  }
}

async function createOrder({ amount, receipt, notes }) {
  if (!configured) throw new Error('Razorpay not configured on this server')
  return client.orders.create({
    amount: Math.round(amount * 100), // rupees → paise
    currency: 'INR',
    receipt,
    notes: notes || {},
  })
}

function verifySignature({ orderId, paymentId, signature }) {
  if (!configured) return false
  const expected = crypto
    .createHmac('sha256', KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex')
  return expected === signature
}

module.exports = { status, createOrder, verifySignature, configured }
