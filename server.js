/**
 * SF Game Zone — Twilio call backend
 * Places a real outbound phone call to confirm a booked riddle session,
 * and (optionally) answers inbound calls as a simple voice booking agent.
 *
 * Outbound calls use inline TwiML, so /api/call needs NO public webhook.
 * Inbound (/voice) requires a public URL set as your Twilio number's Voice webhook.
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const path = require('path');
const fs = require('fs');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  PORT = 3000,
  // OmniDimension voice-AI platform (preferred if set — better voice + LLM agent)
  OMNIDIM_API_KEY,
  OMNIDIM_AGENT_ID = '193150',
  OMNIDIM_BASE_URL = 'https://backend.omnidim.io',
} = process.env;

const app = express();
// CORS + Chrome Private Network Access. A file:// or https booking-agent page
// calling this http://localhost backend triggers a preflight that Chrome blocks
// unless we echo the origin and return Allow-Private-Network on the OPTIONS.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(cors());                       // belt-and-suspenders for non-preflight cases
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
  console.warn('⚠️  Missing Twilio env vars. Copy .env.example to .env and fill it in.');
}
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const xmlEsc = (s) => String(s || '').replace(/[<>&'"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/* ---------- OmniDimension dispatch (preferred AI voice agent) ---------- */
async function dispatchViaOmnidim({ name, phone, slot }) {
  const url = `${OMNIDIM_BASE_URL.replace(/\/$/, '')}/api/v1/calls/dispatch`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OMNIDIM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: Number(OMNIDIM_AGENT_ID),
      to_number: phone,
      call_context: { customer_name: name, slot },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || `OmniDimension dispatch failed (${r.status})`);
  return data;
}

/* ---------- Outbound confirmation call ---------- */
app.post('/api/call', async (req, res) => {
  try {
    const { name = 'there', phone, slot = 'Monday, 4:30 to 5:00 PM' } = req.body || {};
    if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });

    // Preferred path: OmniDimension AI voice agent (set OMNIDIM_API_KEY in .env)
    if (OMNIDIM_API_KEY) {
      const out = await dispatchViaOmnidim({ name, phone, slot });
      console.log(`📞 OmniDimension call dispatched → ${phone}`);
      return res.json({ ok: true, via: 'omnidimension', ...out });
    }
    // Fallback path: direct Twilio call with inline TwiML

    const line1 = `Hello ${xmlEsc(name)}. This is the S F Game Zone booking assistant.`;
    const line2 = `Your team riddle session is confirmed for ${xmlEsc(slot)}.`;
    const line3 = `If this time works, press 1. If you need to reschedule, press 2. We look forward to playing with your team!`;

    // Inline TwiML — spoken with a natural voice. <Gather> is optional and only
    // works if you also expose /voice/confirm publicly (see README).
    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response>` +
        `<Say voice="Polly.Joanna">${line1}</Say>` +
        `<Pause length="1"/>` +
        `<Say voice="Polly.Joanna">${line2}</Say>` +
        `<Say voice="Polly.Joanna">${line3}</Say>` +
        `<Pause length="1"/>` +
        `<Say voice="Polly.Joanna">Thank you, and goodbye.</Say>` +
      `</Response>`;

    const call = await client.calls.create({ to: phone, from: TWILIO_FROM_NUMBER, twiml });
    console.log(`📞 Outbound call queued → ${phone} (sid ${call.sid})`);
    res.json({ ok: true, sid: call.sid, status: call.status });
  } catch (e) {
    console.error('call error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- OPTIONAL: inbound voice agent ----------
 * Set your Twilio number's "A call comes in" webhook to:  https://<your-public-url>/voice
 * Requires a public URL (deploy, or use `ngrok http 3000`).                                */
app.post('/voice', (req, res) => {
  const VR = twilio.twiml.VoiceResponse;
  const vr = new VR();
  const g = vr.gather({ input: 'speech dtmf', numDigits: 1, action: '/voice/confirm', method: 'POST', speechTimeout: 'auto' });
  g.say({ voice: 'Polly.Joanna' },
    "Hi, thanks for calling S F Game Zone. We run team riddle sessions on Mondays, from 4 30 to 5 P M. " +
    "To book that session, press 1 or say yes. To leave a message for our team, press 2.");
  vr.redirect('/voice'); // loop if no response
  res.type('text/xml').send(vr.toString());
});

app.post('/voice/confirm', (req, res) => {
  const VR = twilio.twiml.VoiceResponse;
  const vr = new VR();
  const said = (req.body.SpeechResult || '').toLowerCase();
  const digit = req.body.Digits;
  if (digit === '1' || /\b(yes|book|sure|confirm|okay|ok)\b/.test(said)) {
    vr.say({ voice: 'Polly.Joanna' },
      "Great, you're booked for Monday, 4 30 to 5 P M. You'll get a confirmation shortly. Goodbye!");
    // TODO: persist the booking here — req.body.From is the caller's number.
  } else {
    vr.say({ voice: 'Polly.Joanna' }, "No problem. Please say your name and reason after the tone, and our team will follow up.");
    vr.record({ maxLength: 60, action: '/voice/done', playBeep: true });
  }
  res.type('text/xml').send(vr.toString());
});

app.post('/voice/done', (req, res) => {
  const VR = twilio.twiml.VoiceResponse;
  const vr = new VR();
  vr.say({ voice: 'Polly.Joanna' }, "Thank you. Our team will be in touch. Goodbye!");
  res.type('text/xml').send(vr.toString());
});

// Serve the booking agent from this same server, so the page and the /api/call
// endpoint share one origin — no CORS, no Private-Network blocking, ever.
const AGENT_HTML = path.join(__dirname, '..', 'sfgz-booking-agent.html');
app.get('/', (_req, res) => {
  if (fs.existsSync(AGENT_HTML)) return res.sendFile(AGENT_HTML);
  res.send('SF Game Zone call backend is running. POST /api/call to place a call.');
});
app.get('/health', (_req, res) => res.send('ok'));
app.listen(PORT, () => console.log(`📞 SF Game Zone call backend listening on http://localhost:${PORT}`));
