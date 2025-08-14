import express from 'express';
import bodyParser from 'body-parser';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// CORS configuratie - sta alle origins toe (voor development)
app.use(cors({
  origin: true,
  credentials: true
}));

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;
async function initDB() {
  db = await open({ filename: './bookings.db', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      start_time DATETIME NOT NULL,
      end_time DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      google_event_id TEXT
    );
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      dob DATE,
      address TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (booking_id) REFERENCES bookings (id)
    );
    CREATE TABLE IF NOT EXISTS admin_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_time DATETIME NOT NULL,
      end_time DATETIME NOT NULL,
      capacity INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('Database initialized');
}

// Email transporter (optioneel)
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    service: process.env.SMTP_SERVICE || 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
  console.log('Email transporter configured');
} else {
  console.log('Email not configured - set EMAIL_USER and EMAIL_PASS environment variables');
}
// Google Calendar (optioneel)
let calendar = null;
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URL || 'https://developers.google.com/oauthCode Playground'
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    console.log('Google Calendar configured');
  } catch (error) {
    console.log('Google Calendar setup failed:', error.message);
  }
} else {
  console.log('Google Calendar not configured');
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    email: !!transporter,
    calendar: !!calendar
  });
});

// Publieke slots ophalen
app.get('/api/slots', async (req, res) => {
  try {
    const nowISO = new Date().toISOString();
    const rows = await db.all(
      `SELECT s.id, s.start_time as start, s.end_time as end, s.capacity,
              (SELECT COUNT(1) FROM bookings b WHERE b.start_time = s.start_time AND b.end_time = s.end_time) as booked
       FROM admin_slots s
       WHERE s.end_time > ?
       ORDER BY s.start_time ASC`,
      [nowISO]
    );
    const available = rows.filter(r => (r.booked || 0) < (r.capacity || 1))
                          .map(r => ({ id: r.id, start: r.start, end: r.end }));
    res.json(available);
  } catch (e) {
    console.error('Error fetching slots:', e);
    res.status(500).json({ error: 'Kon slots niet ophalen' });
  }
});

// Admin slots ophalen (zelfde data, andere endpoint voor duidelijkheid)
app.get('/api/slots/admin', async (req, res) => {
  try {
    const nowISO = new Date().toISOString();
    const rows = await db.all(
      `SELECT s.id, s.start_time as start, s.end_time as end, s.capacity,
              (SELECT COUNT(1) FROM bookings b WHERE b.start_time = s.start_time AND b.end_time = s.end_time) as booked
       FROM admin_slots s
       WHERE s.end_time > ?
       ORDER BY s.start_time ASC`,
      [nowISO]
    );
    const available = rows.filter(r => (r.booked || 0) < (r.capacity || 1))
                          .map(r => ({ id: r.id, start: r.start, end: r.end }));
    res.json(available);
  } catch (e) {
    console.error('Error fetching admin slots:', e);
    res.status(500).json({ error: 'Kon admin-slots niet ophalen' });
  }
});

// Admin: slot aanmaken
app.post('/api/admin/slots', async (req, res) => {
  const { start, end, capacity = 1 } = req.body;
  if (!start || !end) return res.status(400).json({ error: 'start en end zijn vereist' });
  
  try {
    // Check of slot al bestaat
    const existing = await db.get(
      'SELECT id FROM admin_slots WHERE start_time = ? AND end_time = ?',
      [start, end]
    );
    if (existing) return res.status(409).json({ error: 'Slot bestaat al' });
    
    const result = await db.run(
      'INSERT INTO admin_slots (start_time, end_time, capacity) VALUES (?, ?, ?)',
      [start, end, capacity]
    );
    
    console.log(`Admin slot created: ${start} - ${end}`);
    res.status(201).json({ id: result.lastID, message: 'Slot aangemaakt' });
  } catch (e) { 
    console.error('Error creating slot:', e);
    res.status(500).json({ error: e.message }); 
  }
});

// Admin: slot verwijderen
app.delete('/api/admin/slots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.run('DELETE FROM admin_slots WHERE id = ?', [id]);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Slot niet gevonden' });
    }
    
    console.log(`Admin slot deleted: ${id}`);
    res.json({ message: 'Slot verwijderd' });
  } catch (e) { 
    console.error('Error deleting slot:', e);
    res.status(500).json({ error: e.message }); 
  }
});

// Boeking maken
app.post('/api/bookings', async (req, res) => {
  const { name, email, phone, start, end } = req.body;
  if (!name || !email || !start || !end) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken' });
  }
  
  try {
    // Check dat slot bestaat en nog plaats heeft
    const slot = await db.get(
      `SELECT s.*, (SELECT COUNT(1) FROM bookings b WHERE b.start_time = s.start_time AND b.end_time = s.end_time) as booked
       FROM admin_slots s WHERE s.start_time = ? AND s.end_time = ?`,
      [start, end]
    );
    
    if (!slot) {
      return res.status(400).json({ error: 'Slot niet (meer) beschikbaar' });
    }
    
    if ((slot.booked || 0) >= (slot.capacity || 1)) {
      return res.status(409).json({ error: 'Slot volzet' });
    }

    // Boeking opslaan
    const result = await db.run(
      'INSERT INTO bookings (name, email, phone, start_time, end_time) VALUES (?, ?, ?, ?, ?)',
      [name, email, phone || null, start, end]
    );
    const bookingId = result.lastID;

    console.log(`Booking created: ${name} (${email}) for ${start}`);

    // Optioneel: sync naar Google Calendar
    if (calendar && process.env.SYNC_TO_GOOGLE === 'true') {
      try {
        const event = {
          summary: `Consultatie: ${name}`,
          description: `Email: ${email}\nTelefoon: ${phone || 'n.v.t.'}`,
          start: { dateTime: start, timeZone: 'Europe/Brussels' },
          end: { dateTime: end, timeZone: 'Europe/Brussels' },
          attendees: [{ email }]
        };
        const resp = await calendar.events.insert({ 
          calendarId: 'primary', 
          resource: event 
        });
        await db.run(
          'UPDATE bookings SET google_event_id = ? WHERE id = ?', 
          [resp.data.id, bookingId]
        );
        console.log('Event synced to Google Calendar');
      } catch (e) {
        console.log('Google Calendar sync failed:', e.message);
      }
    }

    // E-mails versturen
    if (transporter) {
      try {
        // Admin notificatie
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
          to: process.env.ADMIN_EMAIL || process.env.EMAIL_USER,
          subject: 'Nieuwe consultatie geboekt',
          html: `
            <h3>Nieuwe consultatie geboekt</h3>
            <p><strong>Naam:</strong> ${name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Telefoon:</strong> ${phone || 'Niet opgegeven'}</p>
            <p><strong>Datum/tijd:</strong> ${new Date(start).toLocaleString('nl-BE')} - ${new Date(end).toLocaleTimeString('nl-BE')}</p>
          `
        });
        
        // Klant bevestiging
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
          to: email,
          subject: 'Bevestiging consultatie',
          html: `
            <h3>Bevestiging consultatie</h3>
            <p>Beste ${name},</p>
            <p>Je consultatie staat gepland op <strong>${new Date(start).toLocaleString('nl-BE')}</strong>.</p>
            <p>We kijken ernaar uit je te ontmoeten!</p>
            <p>Met vriendelijke groet,<br>Advocaat Bart Bleyaert</p>
          `
        });
        
        console.log('Confirmation emails sent');
      } catch (e) {
        console.log('Mail sending failed:', e.message);
      }
    }

    res.status(201).json({ id: bookingId, message: 'Boeking aangemaakt' });
  } catch (e) {
    console.error('Error creating booking:', e);
    res.status(500).json({ error: 'Er ging iets mis bij het boeken' });
  }
});

// Overzicht boekingen (admin)
app.get('/api/admin/bookings', async (req, res) => {
  try {
    const rows = await db.all(
      'SELECT * FROM bookings ORDER BY start_time DESC LIMIT 50'
    );
    res.json(rows);
  } catch (e) { 
    console.error('Error fetching bookings:', e);
    res.status(500).json({ error: e.message }); 
  }
});

// 404 handler voor API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint niet gevonden' });
});

// Fallback voor andere routes
app.get('*', (req, res) => {
  res.json({ 
    message: 'Consultatie Booking API', 
    endpoints: [
      'GET /health',
      'GET /api/slots',
      'POST /api/bookings',
      'GET /api/admin/bookings',
      'POST /api/admin/slots',
      'DELETE /api/admin/slots/:id'
    ]
  });
});

// Database initialiseren en server starten
initDB().then(() => {
  const port = process.env.PORT || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server draait op poort ${port}`);
    console.log(`📊 Health check: http://localhost:${port}/health`);
  });
}).catch(error => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});
