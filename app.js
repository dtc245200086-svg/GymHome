const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
const session = require('express-session');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static('public'));

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'gymhome-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Set user context for views
app.use((req, res, next) => {
  res.locals.user = req.session.user;

  if (req.session.user) {
    switch (req.session.user.role) {
      case 'admin':
        res.locals.dashboardPath = '/admin/dashboard';
        break;
      case 'receptionist':
        res.locals.dashboardPath = '/receptionist/dashboard';
        break;
      case 'pt':
        res.locals.dashboardPath = '/pt/dashboard';
        break;
      default:
        res.locals.dashboardPath = '/member/dashboard';
        break;
    }
  } else {
    res.locals.dashboardPath = '/';
  }

  next();
});

// Database
const envDatabaseUrl = (process.env.DATABASE_URL || '').trim();
let usePg = false;
let sqliteDb;
let pgPool;

if (envDatabaseUrl) {
  try {
    new URL(envDatabaseUrl);
    usePg = true;
  } catch (err) {
    console.warn('DATABASE_URL is invalid, falling back to SQLite:', err.message);
    usePg = false;
  }
}

function replaceSqliteFunctions(sql) {
  if (!usePg) return sql;
  return sql
    .replace(/datetime\('now'\)/g, 'NOW()')
    .replace(/datetime\('now', '\-1 hour'\)/g, "NOW() - INTERVAL '1 hour'")
    .replace(/date\('now'\)/g, 'CURRENT_DATE')
    .replace(/date\('now', '\+30 days'\)/g, "CURRENT_DATE + INTERVAL '30 days'")
    .replace(/date\('now', '\-30 days'\)/g, "CURRENT_DATE - INTERVAL '30 days'");
}

function toPgPlaceholders(sql, params) {
  if (!params || params.length === 0) return { sql, params };
  let idx = 0;
  const text = sql.replace(/\?/g, () => `$${++idx}`);
  return { sql: text, params };
}

const db = {
  run(sql, params = [], callback) {
    if (usePg) {
      const normalized = replaceSqliteFunctions(sql);
      const { sql: queryText, params: queryParams } = toPgPlaceholders(normalized, params);
      return pgPool.query(queryText, queryParams)
        .then(res => {
          const resultObj = { lastID: res.rows[0]?.id, changes: res.rowCount, rows: res.rows };
          if (callback) callback.call(resultObj, null, resultObj);
        })
        .catch(err => {
          if (callback) callback.call(null, err);
        });
    }
    return sqliteDb.run(sql, params, function (err) {
      if (callback) callback.call(this, err, this);
    });
  },
  get(sql, params = [], callback) {
    if (usePg) {
      const normalized = replaceSqliteFunctions(sql);
      const { sql: queryText, params: queryParams } = toPgPlaceholders(normalized, params);
      return pgPool.query(queryText, queryParams)
        .then(res => callback && callback(null, res.rows[0]))
        .catch(err => callback && callback(err));
    }
    return sqliteDb.get(sql, params, callback);
  },
  all(sql, params = [], callback) {
    if (usePg) {
      const normalized = replaceSqliteFunctions(sql);
      const { sql: queryText, params: queryParams } = toPgPlaceholders(normalized, params);
      return pgPool.query(queryText, queryParams)
        .then(res => callback && callback(null, res.rows))
        .catch(err => callback && callback(err));
    }
    return sqliteDb.all(sql, params, callback);
  },
  serialize(cb) {
    if (usePg) return cb();
    return sqliteDb.serialize(cb);
  }
};

if (usePg) {
  pgPool = new Pool({
    connectionString: envDatabaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  pgPool.connect().then(client => {
    console.log('PostgreSQL connection OK');
    client.release();
  }).catch(err => {
    console.error('Lỗi khởi tạo PostgreSQL:', err);
    console.warn('Chuyển sang SQLite do PostgreSQL không sẵn sàng');
    usePg = false;
    sqliteDb = new sqlite3.Database('./gymhome.db');
  });
} else {
  sqliteDb = new sqlite3.Database('./gymhome.db');
}

// Init DB
function initSchema() {
  const idType = usePg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

  db.run(`CREATE TABLE IF NOT EXISTS members (
    id ${idType},
    name TEXT,
    phone TEXT,
    type TEXT,
    expiry DATE,
    pt_sessions INTEGER DEFAULT 0,
    profile_picture TEXT
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS access_logs (
    id ${idType},
    member_id INTEGER,
    floor INTEGER,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    id ${idType},
    floor INTEGER,
    ip TEXT
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS pts (
    id ${idType},
    user_id INTEGER,
    name TEXT,
    specialty TEXT,
    experience_years INTEGER,
    bio TEXT,
    profile_picture TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS pt_sessions (
    id ${idType},
    member_id INTEGER,
    pt_id INTEGER,
    date DATE,
    confirmed BOOLEAN DEFAULT FALSE,
    rejection_reason TEXT,
    FOREIGN KEY (pt_id) REFERENCES pts(id)
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS floor_capacity (
    floor INTEGER PRIMARY KEY,
    max_capacity INTEGER DEFAULT 50,
    current_count INTEGER DEFAULT 0,
    description TEXT
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id ${idType},
    username TEXT,
    password TEXT,
    role TEXT,
    member_id INTEGER,
    phone TEXT
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS qr_codes (
    id ${idType},
    member_id INTEGER,
    qr_data TEXT,
    token TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    used BOOLEAN DEFAULT FALSE
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id ${idType},
    member_id INTEGER,
    amount REAL,
    type TEXT,
    date DATE DEFAULT CURRENT_DATE,
    status TEXT DEFAULT 'completed'
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id ${idType},
    member_id INTEGER,
    receiver_user_id INTEGER,
    floor INTEGER,
    message TEXT,
    status TEXT,
    origin TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id ${idType},
    member_id INTEGER,
    date DATE,
    check_in_time TIME,
    check_out_time TIME
  )`, []);
}

initSchema();

// Migration: ensure member_id and phone exists on users table (for old DB versions)
if (!usePg) {
  db.all(`PRAGMA table_info(users)`, [], (err, columns) => {
    if (!err && columns && !columns.some(col => col.name === 'member_id')) {
      db.run(`ALTER TABLE users ADD COLUMN member_id INTEGER`, [], (alterErr) => {
        if (alterErr) {
          console.error('Lỗi khi thêm cột member_id vào users:', alterErr);
        } else {
          console.log('Đã thêm cột member_id vào users (nâng cấp schema)');
        }
      });
    }
    if (!err && columns && !columns.some(col => col.name === 'phone')) {
      db.run(`ALTER TABLE users ADD COLUMN phone TEXT`, [], (alterErr) => {
        if (alterErr) {
          console.error('Lỗi khi thêm cột phone vào users:', alterErr);
        } else {
          console.log('Đã thêm cột phone vào users (nâng cấp schema)');
          // Update existing users with phone from members
          db.run(`UPDATE users SET phone = (SELECT phone FROM members WHERE members.id = users.member_id) WHERE member_id IS NOT NULL AND phone IS NULL`, [], (updateErr) => {
            if (updateErr) {
              console.error('Lỗi khi update phone cho users existing:', updateErr);
            } else {
              console.log('Đã update phone cho users existing');
            }
          });
        }
      });
    }
  });
}

// Migration: ensure receiver_user_id exists on notifications table
if (!usePg) {
  db.all(`PRAGMA table_info(notifications)`, [], (err, columns) => {
    if (!err && columns && !columns.some(col => col.name === 'receiver_user_id')) {
      db.run(`ALTER TABLE notifications ADD COLUMN receiver_user_id INTEGER`, [], (alterErr) => {
        if (alterErr) {
          console.error('Lỗi khi thêm cột receiver_user_id vào notifications:', alterErr);
        } else {
          console.log('Đã thêm cột receiver_user_id vào notifications (nâng cấp schema)');
        }
      });
    }
  });

  db.all(`PRAGMA table_info(qr_codes)`, [], (err, columns) => {
    if (!err && columns && !columns.some(col => col.name === 'token')) {
      db.run(`ALTER TABLE qr_codes ADD COLUMN token TEXT`, [], (alterErr) => {
        if (alterErr) {
          console.error('Lỗi khi thêm cột token vào qr_codes:', alterErr);
        } else {
          console.log('Đã thêm cột token vào qr_codes (nâng cấp schema)');
        }
      });
    }
  });
}

if (!usePg) {
  db.serialize(() => {
    db.get(`SELECT COUNT(*) as count FROM members`, [], (err, row) => {
      if (row && row.count === 0) {
        db.run(`INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES ('Nguyen Van A', '0123456789', 'Regular', '2026-12-31', 10)`);
        db.run(`INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES ('Tran Thi B', '0987654321', 'VIP', '2026-12-31', 20)`);
      }
    });
    db.get(`SELECT COUNT(*) as count FROM devices`, [], (err, row) => {
      if (row && row.count === 0) {
        for (let i = 1; i <= 5; i++) {
          db.run(`INSERT INTO devices (floor, ip) VALUES (?, ?)`, [i, `192.168.1.${i}`]);
        }
      }
    });
    db.get(`SELECT COUNT(*) as count FROM floor_capacity`, [], (err, row) => {
      if (row && row.count === 0) {
        const descriptions = {
          1: 'Khu gửi đồ, lễ tân và phòng tập trải nghiệm',
          2: 'Dành cho hội viên thường',
          3: 'Dành cho hội viên thường',
          4: 'Dành cho hội viên VIP có massage và view cao cấp',
          5: 'Khu tập riêng tư, cao cấp dành cho hội viên VIP'
        };
        for (let i = 1; i <= 5; i++) {
          db.run(`INSERT INTO floor_capacity (floor, max_capacity, description) VALUES (?, 50, ?)`, [i, descriptions[i]]);
        }
      }
    });
    db.get(`SELECT COUNT(*) as count FROM pts`, [], (err, row) => {
      if (row && row.count === 0) {
        // Assuming pt user id is 3
        db.run(`INSERT INTO pts (user_id, name, specialty, experience_years, bio) VALUES (3, 'Nguyen PT', 'Fitness Training', 5, 'Chuyên gia fitness với 5 năm kinh nghiệm')`);
      }
    });
    db.get(`SELECT COUNT(*) as count FROM pt_sessions`, [], (err, row) => {
      if (row && row.count === 0) {
        db.run(`INSERT INTO pt_sessions (member_id, pt_id, date) VALUES (1, 1, '2026-03-29')`);
      }
    });
    db.get(`SELECT COUNT(*) as count FROM users`, [], (err, row) => {
      if (row && row.count === 0) {
        db.run(`INSERT INTO users (username, password, role) VALUES ('admin', 'admin', 'admin')`);
        db.run(`INSERT INTO users (username, password, role) VALUES ('letan', 'letan', 'receptionist')`);
        db.run(`INSERT INTO users (username, password, role) VALUES ('pt', 'pt', 'pt')`);
        db.run(`INSERT INTO users (username, password, role, member_id) VALUES ('member', 'member', 'member', 1)`);
      }
    });
  });
} else {
  // PostgreSQL default records in async block
  (async () => {
    try {
      const { rows } = await pgPool.query(`SELECT COUNT(*)::int as count FROM members`);
      if (rows[0].count === 0) {
        await pgPool.query(`INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES ('Nguyen Van A', '0123456789', 'Regular', '2026-12-31', 10)`);
        await pgPool.query(`INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES ('Tran Thi B', '0987654321', 'VIP', '2026-12-31', 20)`);
      }
      const devices = await pgPool.query(`SELECT COUNT(*)::int as count FROM devices`);
      if (devices.rows[0].count === 0) {
        for (let i = 1; i <= 5; i++) {
          await pgPool.query(`INSERT INTO devices (floor, ip) VALUES ($1, $2)`, [i, `192.168.1.${i}`]);
        }
      }
      const pts = await pgPool.query(`SELECT COUNT(*)::int as count FROM pt_sessions`);
      if (pts.rows[0].count === 0) {
        await pgPool.query(`INSERT INTO pt_sessions (member_id, pt_id, date) VALUES ($1, $2, $3)`, [1, 1, '2026-03-29']);
      }
      const users = await pgPool.query(`SELECT COUNT(*)::int as count FROM users`);
      if (users.rows[0].count === 0) {
        await pgPool.query(`INSERT INTO users (username, password, role) VALUES ($1, $2, $3)`, ['admin', 'admin', 'admin']);
        await pgPool.query(`INSERT INTO users (username, password, role) VALUES ($1, $2, $3)`, ['letan', 'letan', 'receptionist']);
        await pgPool.query(`INSERT INTO users (username, password, role) VALUES ($1, $2, $3)`, ['pt', 'pt', 'pt']);
        await pgPool.query(`INSERT INTO users (username, password, role, member_id) VALUES ($1, $2, $3, $4)`, ['member', 'member', 'member', 1]);
      }
    } catch (error) {
      console.error('Lỗi khởi tạo dữ liệu PostgreSQL:', error);
    }
  })();
}

// Clean expired QR codes periodically
setInterval(() => {
  const deleteQrSql = usePg
    ? `DELETE FROM qr_codes WHERE expires_at < NOW()`
    : `DELETE FROM qr_codes WHERE expires_at < datetime('now')`;

  db.run(deleteQrSql, [], (err) => {
    if (err) console.log('Error cleaning expired QR:', err);
  });
}, 60 * 1000); // Every minute

// Validations
function validatePhone(phone) {
  if (!phone || phone.length !== 10) return false;
  if (!/^0[0-9]{9}$/.test(phone)) return false;
  const networkPrefix = phone.substring(0, 3);
  const validPrefixes = ['010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '090', '091', '092', '093', '094', '095', '096', '097', '098', '099'];
  return validPrefixes.includes(networkPrefix);
}

function validateIP(ip) {
  const ipv4Pattern = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipv4Pattern.test(ip);
}

const PAYMENT_QR_TEXT = process.env.PAYMENT_QR_TEXT || 'TÀI KHOẢN: PHAM TIEN HA\nSỐ TÀI KHOẢN: 101882793579\nNGÂN HÀNG: VIETINBANK CN THAI NGUYEN\nNỘI DUNG: THANH TOÁN GÓI TẬP GYM HOME';
function getPaymentQr(callback) {
  qrcode.toDataURL(PAYMENT_QR_TEXT, { errorCorrectionLevel: 'H', width: 320 }, (err, url) => {
    if (err) {
      console.error('Lỗi tạo QR thanh toán:', err);
      return callback(null);
    }
    callback(url);
  });
}

// Check for PT schedule conflicts
function checkPTConflict(member_id, pt_id, date, callback) {
  db.get(`SELECT COUNT(*) as count FROM pt_sessions 
          WHERE pt_id = ? AND date = ? AND confirmed = 0`, 
          [pt_id, date], (err, row) => {
    callback(err, row?.count > 0);
  });
}

// Get today's attendance for a member
function getTodayAttendance(member_id, callback) {
  const today = new Date().toISOString().split('T')[0];
  db.get(`SELECT * FROM attendance WHERE member_id = ? AND date = ?`, 
         [member_id, today], callback);
}

// Calculate membership days remaining
function daysRemaining(expiryDate) {
  const today = new Date();
  const expiry = new Date(expiryDate);
  const diff = expiry - today;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function createNotification({ member_id = null, receiver_user_id = null, floor = null, message, status, origin }) {
  db.run(`INSERT INTO notifications (member_id, receiver_user_id, floor, message, status, origin) VALUES (?, ?, ?, ?, ?, ?)`,
    [member_id, receiver_user_id, floor, message, status, origin], (err) => {
      if (err) console.error('Lỗi lưu notification:', err);
    });
}

// Middleware check auth
function requireAuth(req, res, next) {
  if (req.session.user) {
    return next();
  } else {
    res.redirect('/login');
  }
}

function requireRole(roleOrRoles) {
  const roles = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }

    if (roles.includes(req.session.user.role)) {
      return next();
    }

    const redirectMap = {
      admin: '/admin/dashboard',
      receptionist: '/receptionist/dashboard',
      pt: '/pt/dashboard',
      member: '/member/dashboard'
    };

    return res.redirect(redirectMap[req.session.user.role] || '/');
  };
}

// Enforce role-based path-level access
app.use('/admin', requireRole('admin'));
app.use('/receptionist', requireRole('receptionist'));
app.use('/pt', requireRole(['pt', 'admin']));

// Routes
app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'admin') res.redirect('/admin/dashboard');
    else if (req.session.user.role === 'receptionist') res.redirect('/receptionist/dashboard');
    else if (req.session.user.role === 'pt') res.redirect('/pt/dashboard');
    else res.redirect('/member/dashboard');
  } else {
    res.render('index');
  }
});

app.get('/register', (req, res) => {
  res.render('register');
});

app.post('/register', (req, res) => {
  const { username, password, name, phone, type, expiry, pt_sessions } = req.body;

  if (!username || !password) return res.send('Vui lòng nhập tên tài khoản và mật khẩu');
  if (!validatePhone(phone)) {
    return res.send('Lỗi: Số điện thoại phải 10 chữ số và bắt đầu bằng số mạng hợp lệ (010-020, 090-099)');
  }

  // Kiểm tra trùng username / phone
  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, existingUser) => {
    if (err) return res.send('Lỗi hệ thống');
    if (existingUser) return res.send('Username đã tồn tại');

    db.get(`SELECT * FROM members WHERE phone = ?`, [phone], (err, existingMember) => {
      if (err) return res.send('Lỗi hệ thống');
      if (existingMember) return res.send('Số điện thoại đã được đăng ký');

      const insertMemberSql = usePg ? `INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES (?, ?, ?, ?, ?) RETURNING id` : `INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES (?, ?, ?, ?, ?)`;
  db.run(insertMemberSql, [name, phone, type, expiry, parseInt(pt_sessions) || 0], function(err) {
        if (err) return res.send('Lỗi đăng ký hội viên');

        const memberId = this.lastID;
        db.run(`INSERT INTO users (username, password, role, member_id, phone) VALUES (?, ?, 'member', ?, ?)`, [username, password, memberId, phone], function(err) {
          if (err) return res.send('Lỗi tạo tài khoản đăng nhập');

          // Cập nhật session tự động đăng nhập cho thành viên mới
          req.session.user = { id: this.lastID || memberId, username, role: 'member', member_id: memberId };
          res.redirect('/member/dashboard');
        });
      });
    });
  });
});

app.get('/members', (req, res) => {
  db.all(`SELECT * FROM members`, [], (err, rows) => {
    if (err) return res.send('Lỗi lấy danh sách hội viên');
    res.render('members', { members: rows });
  });
});

function createQrPayload(member, expiresAt, token) {
  return JSON.stringify({
    member_id: member.id,
    name: member.name,
    phone: member.phone,
    type: member.type,
    expiry: member.expiry,
    token,
    expires_at: expiresAt
  });
}

function parseQrPayload(rawQr) {
  if (!rawQr || typeof rawQr !== 'string') return null;
  try {
    const parsed = JSON.parse(rawQr);
    if (parsed && parsed.member_id && parsed.token) {
      return parsed;
    }
  } catch (_err) {
    // Not JSON payload, ignore
  }
  return null;
}

function generateCodeForMember(member, res) {
  const today = new Date().toISOString().split('T')[0];
  if (new Date(member.expiry) < new Date(today)) {
    return res.send('Thẻ đã hết hạn - Vui lòng gia hạn');
  }

  const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();
  const qrData = createQrPayload(member, expiresAt, token);

  db.run(`INSERT INTO qr_codes (member_id, qr_data, token, expires_at) VALUES (?, ?, ?, ?)`, [member.id, qrData, token, expiresAt], function(err) {
    if (err) return res.send('Lỗi tạo QR');

    qrcode.toDataURL(qrData, (err, url) => {
      if (err) return res.send('Lỗi tạo QR');
      res.render('qr', { qr: url, id: member.id, member });
    });
  });
}

app.get('/qr', requireAuth, (req, res) => {
  if (req.session.user.role !== 'member') return res.redirect('/login');

  const id = req.session.user.member_id;
  db.get(`SELECT * FROM members WHERE id = ?`, [id], (err, member) => {
    if (err || !member) return res.send('Hội viên không tồn tại');
    generateCodeForMember(member, res);
  });
});

// Hỗ trợ URL cũ /qr/:id
app.get('/qr/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.send('ID không hợp lệ');

  db.get(`SELECT * FROM members WHERE id = ?`, [id], (err, member) => {
    if (err || !member) return res.send('Hội viên không tồn tại');
    generateCodeForMember(member, res);
  });
});

app.post('/access', (req, res) => {
  const { qr_data, floor } = req.body;
  const floorNumber = parseInt(floor, 10);
  const qrString = (qr_data || '').trim();

  if (!qrString || !floorNumber) {
    const message = '❌ Vui lòng quét QR và chọn tầng';
    return res.json({ success: false, message, type: 'invalid' });
  }

  const expiryCondition = usePg ? 'expires_at > NOW()' : "expires_at > datetime('now')";
  const payload = parseQrPayload(qrString);
  const qrQuery = `SELECT * FROM qr_codes WHERE qr_data = ? AND used = 0 AND ${expiryCondition}`;
  const tokenQuery = payload && payload.token && payload.member_id
    ? `SELECT * FROM qr_codes WHERE token = ? AND member_id = ? AND used = 0 AND ${expiryCondition}`
    : null;

  function findQr(callback) {
    if (tokenQuery) {
      return db.get(tokenQuery, [payload.token, payload.member_id], (err, qr) => {
        if (err) return callback(err);
        if (qr) return callback(null, qr);
        db.get(qrQuery, [qrString], callback);
      });
    }
    db.get(qrQuery, [qrString], callback);
  }

  function processQr(qr) {
    const member_id = qr.member_id;
    db.get(`SELECT * FROM members WHERE id = ?`, [member_id], (err, member) => {
      if (err || !member) {
        const message = '❌ Hội viên không tồn tại. Kiểm tra lại mã QR hoặc liên hệ lễ tân để được hỗ trợ.';
        createNotification({ member_id, floor: floorNumber, message, status: 'fail', origin: 'scanner' });
        return res.json({ success: false, message, type: 'error' });
      }

      const today = new Date().toISOString().split('T')[0];
      if (new Date(member.expiry) < new Date(today)) {
        const message = '❌ Thẻ đã hết hạn. Vui lòng gia hạn hoặc xuống quầy lễ tân để được hỗ trợ.';
        createNotification({ member_id, floor: floorNumber, message, status: 'fail', origin: 'scanner' });
        return res.json({ success: false, message, type: 'expired', member });
      }

      const isRegularRestricted = member.type === 'Regular' && floorNumber > 3;
      if (isRegularRestricted) {
        const message = `❌ Thẻ ${member.type} chỉ được vào tầng 1-3. Vui lòng tạo lại mã QR hoặc xuống quầy lễ tân để được hỗ trợ.`;
        createNotification({ member_id, floor: floorNumber, message, status: 'fail', origin: 'scanner' });
        return res.json({ success: false, message, type: 'restricted', member });
      }

      db.get(`SELECT * FROM attendance WHERE member_id = ? AND date = ?`, [member_id, today], (err, attendance) => {
        if (err) {
          const message = '❌ Lỗi kiểm tra attendance. Vui lòng thử lại hoặc liên hệ lễ tân.';
          createNotification({ member_id, floor: floorNumber, message, status: 'fail', origin: 'scanner' });
          return res.json({ success: false, message, type: 'error' });
        }

        const alreadyCheckedIn = attendance && attendance.check_in_time;
        if (!alreadyCheckedIn && member.pt_sessions <= 0) {
          const message = '❌ Hội viên đã hết buổi tập. Vui lòng gia hạn hoặc xuống quầy lễ tân để được hỗ trợ.';
          createNotification({ member_id, floor: floorNumber, message, status: 'fail', origin: 'scanner' });
          return res.json({ success: false, message, type: 'error', member });
        }

        db.run(`UPDATE qr_codes SET used = 1 WHERE id = ?`, [qr.id], (err) => {
          if (err) {
            const message = '❌ Lỗi cập nhật QR';
            createNotification({ member_id, floor: floorNumber, message, status: 'fail', origin: 'scanner' });
            return res.json({ success: false, message, type: 'error' });
          }

          db.run(`INSERT INTO access_logs (member_id, floor) VALUES (?, ?)`, [member_id, floorNumber], (err) => {
            if (err) {
              const message = '❌ Lỗi ghi log truy cập';
              createNotification({ member_id, floor: floorNumber, message, status: 'fail', origin: 'scanner' });
              return res.json({ success: false, message, type: 'error' });
            }

            const processAttendance = () => {
              const responseMember = { ...member };
              if (!alreadyCheckedIn) {
                responseMember.pt_sessions = Math.max(0, member.pt_sessions - 1);
                db.run(`UPDATE members SET pt_sessions = pt_sessions - 1 WHERE id = ?`, [member_id], (err) => {
                  if (err) console.error('Lỗi cập nhật số buổi tập:', err);
                });
                db.run(`INSERT INTO attendance (member_id, date, check_in_time) VALUES (?, ?, ?)`, [member_id, today, new Date().toLocaleTimeString('vi-VN')], (err) => {
                  if (err) console.error('Lỗi tạo attendance:', err);
                });
              }

              db.run(`UPDATE floor_capacity SET current_count = current_count + 1 WHERE floor = ?`, [floorNumber], (err) => {
                if (err) console.log('Error updating floor capacity:', err);

                const message = alreadyCheckedIn
                  ? `✅ ${member.name} đã được xác nhận hôm nay. Mở cửa tầng ${floorNumber}`
                  : `✅ Chào mừng ${member.name}! Mở cửa tầng ${floorNumber}`;

                createNotification({ member_id, floor: floorNumber, message, status: 'success', origin: 'scanner' });
                return res.json({
                  success: true,
                  message,
                  type: 'success',
                  member: {
                    name: member.name,
                    phone: member.phone,
                    type: member.type,
                    expiry: member.expiry,
                    pt_sessions: responseMember.pt_sessions
                  },
                  floor: floorNumber,
                  timestamp: new Date().toLocaleTimeString('vi-VN'),
                  alreadyCheckedIn
                });
              });
            };

            processAttendance();
          });
        });
      });
    });
  }

  findQr((err, qr) => {
    if (err || !qr) {
      const message = '❌ QR không hợp lệ hoặc đã hết hạn. Vui lòng tạo lại mã QR hoặc xuống quầy lễ tân để được hỗ trợ.';
      createNotification({ member_id: payload?.member_id || null, floor: floorNumber, message, status: 'fail', origin: 'scanner' });
      return res.json({ success: false, message, type: 'error' });
    }

    processQr(qr);
  });
});

app.get('/pt', (req, res) => {
  db.all(`SELECT ps.*, m.name as member_name FROM pt_sessions ps JOIN members m ON ps.member_id = m.id`, [], (err, rows) => {
    if (err) return res.send('Lỗi lấy danh sách PT');
    res.render('pt', { sessions: rows });
  });
});

app.post('/pt/confirm/:id', requireAuth, (req, res) => {
  if (req.session.user.role !== 'pt') return res.redirect('/login');
  
  const sessionId = parseInt(req.params.id);
  const ptUserId = req.session.user.id;
  
  // Verify the session belongs to this PT
  db.get(`SELECT ps.*, p.name as pt_name FROM pt_sessions ps JOIN pts p ON ps.pt_id = p.id WHERE ps.id = ? AND p.user_id = ?`, 
         [sessionId, ptUserId], (err, session) => {
    if (err || !session) return res.send('Buổi học không tồn tại hoặc không thuộc PT này');
    
    db.run(`UPDATE pt_sessions SET confirmed = 1 WHERE id = ?`, [sessionId], (err) => {
      if (err) return res.send('Lỗi xác nhận');
      
      // Create notification for member
      const memberMessage = `✅ PT ${session.pt_name} đã xác nhận lịch tập ngày ${session.date}. Chuẩn bị sẵn sàng!`;
      createNotification({ member_id: session.member_id, message: memberMessage, status: 'success', origin: 'pt_confirmed' });
      
      db.run(`UPDATE members SET pt_sessions = pt_sessions - 1 WHERE id = ? AND pt_sessions > 0`, [session.member_id], (err) => {
        res.redirect('/pt/dashboard');
      });
    });
  });
});

// Legacy devices route (đã được sao chép sang devices-enhanced)
app.get('/admin/devices/basic', requireAuth, (req, res) => {
  db.all(`SELECT * FROM devices`, [], (err, rows) => {
    if (err) return res.send('Lỗi lấy thiết bị');
    res.render('devices', { devices: rows });
  });
});

app.post('/admin/devices/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const { ip } = req.body;
  
  // Validate IP
  if (!validateIP(ip)) {
    return res.send('Lỗi: Địa chỉ IP không hợp lệ. Phải là định dạng IPv4 (xxx.xxx.xxx.xxx)');
  }
  
  db.run(`UPDATE devices SET ip = ? WHERE id = ?`, [ip, id], (err) => {
    if (err) return res.send('Lỗi cập nhật thiết bị');
    res.redirect('/admin/devices');
  });
});

app.get('/admin/alerts', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const daysFromNow = (days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
  };
  
  // Get members with expiry < 5 days
  db.all(`SELECT * FROM members WHERE expiry <= '${daysFromNow(5)}' AND expiry >= '${today}'`, [], (err, expiryAlerts) => {
    // Get members with PT sessions < 2
    db.all(`SELECT * FROM members WHERE pt_sessions < 2 AND pt_sessions > 0`, [], (err, ptAlerts) => {
      res.render('admin-alerts', { 
        expiryAlerts: expiryAlerts || [], 
        ptAlerts: ptAlerts || [],
        dashboardPath: res.locals.dashboardPath || '/admin/dashboard'
      });
    });
  });
});

// TÍNH NĂNG MỚI: FLOOR CAPACITY MANAGEMENT
app.get('/admin/floor-capacity', requireAuth, (req, res) => {
  const oneHourAgo = usePg ? "NOW() - INTERVAL '1 hour'" : "datetime('now', '-1 hour')";
  const query = `SELECT fc.*, 
          (SELECT COUNT(*) FROM access_logs 
           WHERE floor = fc.floor AND 
           timestamp > ${oneHourAgo}) as current_count
          FROM floor_capacity fc`;

  db.all(query, [], (err, floors) => {
    if (err) return res.send('Lỗi lấy thông tin tầng');
    const floorsData = floors.map(f => ({
      ...f,
      usage_percent: Math.round((f.current_count / f.max_capacity) * 100),
      is_full: f.current_count >= f.max_capacity
    }));
    res.render('floor-capacity', { floors: floorsData });
  });
});

app.post('/admin/floor-capacity/:floor', (req, res) => {
  const floor = parseInt(req.params.floor);
  const { max_capacity } = req.body;
  db.run(`UPDATE floor_capacity SET max_capacity = ? WHERE floor = ?`, 
         [parseInt(max_capacity), floor], (err) => {
    if (err) return res.send('Lỗi cập nhật');
    res.redirect('/admin/floor-capacity');
  });
});

// TÍNH NĂNG MỚI: MEMBER SEARCH
app.get('/members/search', (req, res) => {
  const query = req.query.q || '';
  if (!query) return res.json([]);
  
  db.all(`SELECT * FROM members WHERE name LIKE ? OR phone LIKE ?`, 
         [`%${query}%`, `%${query}%`], (err, rows) => {
    res.json(rows || []);
  });
});

// TÍNH NĂNG MỚI: RENEWAL MANAGEMENT
app.get('/admin/renewals', requireAuth, (req, res) => {
  db.all(`SELECT *, 
          CASE 
            WHEN expiry < date('now') THEN 'expired'
            WHEN expiry <= date('now', '+30 days') THEN 'expiring_soon'
            ELSE 'active'
          END as status
          FROM members ORDER BY expiry ASC`, [], (err, members) => {
    if (err) return res.send('Lỗi lấy danh sách gia hạn');
    res.render('renewals', { members: members || [] });
  });
});

app.post('/admin/renew/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { new_expiry } = req.body;
  db.run(`UPDATE members SET expiry = ?, pt_sessions = 10 WHERE id = ?`, 
         [new_expiry, id], (err) => {
    if (err) return res.send('Lỗi gia hạn thẻ');
    res.redirect('/admin/renewals');
  });
});

// TÍNH NĂNG MỚI: PAYMENT HISTORY
app.get('/admin/payments', requireAuth, (req, res) => {
  db.all(`SELECT p.*, m.name as member_name FROM payments p 
          JOIN members m ON p.member_id = m.id 
          ORDER BY p.date DESC`, [], (err, payments) => {
    if (err) return res.send('Lỗi lấy lịch thanh toán');

    db.all(`SELECT id as member_id, name FROM members ORDER BY name ASC`, [], (err2, members) => {
      if (err2) return res.send('Lỗi lấy danh sách hội viên');

      const totalRevenue = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
      getPaymentQr((paymentQr) => {
        res.render('payments', { payments: payments || [], totalRevenue, members: members || [], paymentQr });
      });
    });
  });
});

app.post('/admin/payment/add', (req, res) => {
  const { member_id, amount, type } = req.body;
  db.run(`INSERT INTO payments (member_id, amount, type) VALUES (?, ?, ?)`,
         [parseInt(member_id), parseFloat(amount), type], (err) => {
    if (err) return res.send('Lỗi thêm thanh toán');
    
    // Get member name for notification
    db.get(`SELECT name FROM members WHERE id = ?`, [parseInt(member_id)], (err, member) => {
      if (member) {
        const message = `💰 Thanh toán ${amount}đ cho gói ${type} đã được ghi nhận. Cảm ơn bạn!`;
        createNotification({ member_id: parseInt(member_id), message, status: 'success', origin: 'payment' });
      }
    });
    
    res.redirect('/admin/payments');
  });
});

// TÍNH NĂNG MỚI: ATTENDANCE TRACKING
app.post('/attendance/checkin/:id', (req, res) => {
  const member_id = parseInt(req.params.id);
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toTimeString().split(' ')[0];
  
  db.get(`SELECT * FROM attendance WHERE member_id = ? AND date = ?`,
         [member_id, today], (err, row) => {
    if (row) {
      res.send('Đã check-in hôm nay rồi');
    } else {
      db.run(`INSERT INTO attendance (member_id, date, check_in_time) VALUES (?, ?, ?)`,
             [member_id, today, now], (err) => {
        res.send('Check-in thành công');
      });
    }
  });
});

app.post('/attendance/checkout/:id', (req, res) => {
  const member_id = parseInt(req.params.id);
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toTimeString().split(' ')[0];
  
  db.run(`UPDATE attendance SET check_out_time = ? WHERE member_id = ? AND date = ?`,
         [now, member_id, today], (err) => {
    res.send('Check-out thành công');
  });
});

app.get('/admin/attendance', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  db.all(`SELECT a.*, m.name, m.phone FROM attendance a
          JOIN members m ON a.member_id = m.id
          WHERE a.date = ?
          ORDER BY a.check_in_time DESC`, [today], (err, records) => {
    if (err) return res.send('Lỗi lấy lịch check-in');
    res.render('attendance', { records: records || [], today });
  });
});

// TÍNH NĂNG MỚI: PT SCHEDULE CONFLICT CHECK
app.post('/pt/create', (req, res) => {
  const { member_id, pt_id, date } = req.body;
  
  checkPTConflict(member_id, pt_id, date, (err, hasConflict) => {
    if (hasConflict) {
      return res.send('Lỗi: PT này đã có buổi vào ngày này');
    }
    db.run(`INSERT INTO pt_sessions (member_id, pt_id, date) VALUES (?, ?, ?)`,
           [parseInt(member_id), parseInt(pt_id), date], (err) => {
      if (err) return res.send('Lỗi tạo buổi PT');
      res.redirect('/pt');
    });
  });
});

// TÍNH NĂNG MỚI: MEMBER STATISTICS
app.get('/admin/member-stats', requireAuth, (req, res) => {
  db.all(`SELECT m.*,
          (SELECT COUNT(*) FROM access_logs WHERE member_id = m.id) as total_visits,
          (SELECT COUNT(*) FROM attendance WHERE member_id = m.id AND 
           date >= date('now', '-30 days')) as visits_30days,
          (SELECT COUNT(*) FROM pt_sessions WHERE member_id = m.id AND confirmed = 1) as pt_completed
          FROM members m`, [], (err, members) => {
    if (err) return res.send('Lỗi lấy thống kê');
    res.render('member-stats', { members: members || [] });
  });
});

// TÍNH NĂNG MỚI: EXPORT REPORTS
app.get('/admin/export/members', (req, res) => {
  db.all(`SELECT * FROM members`, [], (err, members) => {
    if (err) return res.send('Lỗi xuất dữ liệu');
    const csv = 'STT,Tên,Điện thoại,Loại,Hết hạn,Buổi PT\n' +
                members.map((m, i) => `${i+1},"${m.name}","${m.phone}","${m.type}","${m.expiry}",${m.pt_sessions}`).join('\n');
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', 'attachment; filename="members.csv"');
    res.send(csv);
  });
});

app.get('/admin/export/payments', (req, res) => {
  db.all(`SELECT p.*, m.name as member_name FROM payments p 
          JOIN members m ON p.member_id = m.id`, [], (err, payments) => {
    if (err) return res.send('Lỗi xuất dữ liệu');
    const csv = 'STT,Hội viên,Số tiền,Loại,Ngày,Trạng thái\n' +
                payments.map((p, i) => `${i+1},"${p.member_name}",${p.amount},"${p.type}","${p.date}","${p.status}"`).join('\n');
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', 'attachment; filename="payments.csv"');
    res.send(csv);
  });
});

// ========== RECEPTIONIST PAGES ==========
// Receptionist: Payments
app.get('/receptionist/payments', requireAuth, (req, res) => {
  db.all(`SELECT p.*, m.name as member_name FROM payments p 
          LEFT JOIN members m ON p.member_id = m.id 
          ORDER BY p.date DESC`, [], (err, payments) => {
    if (err) return res.send('Lỗi lấy thanh toán');

    db.all(`SELECT id as member_id, name FROM members ORDER BY name ASC`, [], (err2, members) => {
      if (err2) return res.send('Lỗi lấy danh sách hội viên');
      const totalRevenue = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
      getPaymentQr((paymentQr) => {
        res.render('payments', { payments: payments || [], totalRevenue, members: members || [], paymentQr });
      });
    });
  });
});

app.post('/receptionist/payment/add', requireAuth, (req, res) => {
  const { member_id, amount, type } = req.body;
  db.run(`INSERT INTO payments (member_id, amount, type) VALUES (?, ?, ?)`,
         [parseInt(member_id), parseFloat(amount), type], (err) => {
    if (err) return res.send('Lỗi thêm thanh toán');
    res.redirect('/receptionist/payments');
  });
});

// Receptionist: Attendance
app.get('/receptionist/attendance', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  db.all(`SELECT a.*, m.name, m.phone FROM attendance a 
          LEFT JOIN members m ON a.member_id = m.id 
          WHERE a.date = ? ORDER BY a.check_in_time DESC`, [today], (err, rows) => {
    if (err) return res.send('Lỗi lấy lịch tham dự');
    res.render('attendance', { records: rows || [], today });
  });
});

app.post('/receptionist/checkin/:id', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toTimeString().split(' ')[0];
  db.run(`INSERT INTO attendance (member_id, date, check_in_time) VALUES (?, ?, ?)`,
         [parseInt(req.params.id), today, now], (err) => {
    if (err) return res.send('Lỗi check-in');
    res.redirect('/receptionist/attendance');
  });
});

app.post('/receptionist/checkout/:id', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toTimeString().split(' ')[0];
  db.run(`UPDATE attendance SET check_out_time = ? WHERE member_id = ? AND date = ?`,
         [now, parseInt(req.params.id), today], (err) => {
    if (err) return res.send('Lỗi check-out');
    res.redirect('/receptionist/attendance');
  });
});

// ========== ADMIN USER MANAGEMENT ==========
// Manage Members (Hội viên)
app.get('/admin/manage-members', requireAuth, (req, res) => {
  const query = `SELECT u.*, m.name as member_name FROM users u 
          LEFT JOIN members m ON m.id = u.member_id 
          WHERE u.role = 'member' ORDER BY u.id`;

  db.all(query, [], (err, users) => {
    if (err) {
      console.error('manage-members query error:', err);
      if (err.message && err.message.includes('no such column: u.member_id')) {
        // Fallback for legacy DB where member_id column doesn't exist yet
        db.all(`SELECT * FROM users WHERE role = 'member' ORDER BY id`, [], (err2, users2) => {
          if (err2) {
            console.error('manage-members fallback query error:', err2);
            return res.send('Lỗi lấy danh sách hội viên');
          }
          return res.render('manage-users', { users: users2 || [], role: 'member', title: '👥 Quản Lý Hội Viên' });
        });
      } else {
        return res.send('Lỗi lấy danh sách hội viên');
      }
    } else {
      res.render('manage-users', { users: users || [], role: 'member', title: '👥 Quản Lý Hội Viên' });
    }
  });
});

app.post('/admin/create-member', requireAuth, (req, res) => {
  const { username, password, name, phone, type, expiry, pt_sessions } = req.body;
  if (!username || !password) return res.send('Bắt buộc nhập username và password');

  const memberName = name && name.trim() ? name.trim() : username;
  const memberPhone = (phone && phone.trim()) || null;
  const memberType = type && type.trim() ? type.trim() : 'Regular';
  const memberExpiry = expiry && expiry.trim() ? expiry.trim() : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const memberPts = Number.isInteger(parseInt(pt_sessions)) ? parseInt(pt_sessions) : 10;

  const insertMemberSql = usePg ? `INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES (?, ?, ?, ?, ?) RETURNING id` : `INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES (?, ?, ?, ?, ?)`;
  db.run(insertMemberSql,
         [memberName, memberPhone, memberType, memberExpiry, memberPts], function (err) {
    if (err) return res.send('Lỗi tạo hội viên trong members');

    const memberId = this.lastID;
    db.run(`INSERT INTO users (username, password, role, member_id, phone) VALUES (?, ?, ?, ?, ?)`,
           [username, password, 'member', memberId, memberPhone], (err2) => {
      if (err2) {
        // rollback member if user insert fails
        db.run(`DELETE FROM members WHERE id = ?`, [memberId]);
        return res.send('Lỗi tạo tài khoản hội viên - có thể username đã tồn tại');
      }
      res.redirect('/admin/manage-members');
    });
  });
});

// Manage Receptionists (Lễ tân)
app.get('/admin/manage-receptionists', requireAuth, (req, res) => {
  db.all(`SELECT * FROM users WHERE role = 'receptionist' ORDER BY id`, [], (err, users) => {
    if (err) return res.send('Lỗi lấy danh sách lễ tân');
    res.render('manage-users', { users: users || [], role: 'receptionist', title: '🎫 Quản Lý Lễ Tân' });
  });
});

app.post('/admin/create-receptionist', requireAuth, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.send('Bắt buộc nhập username và password');
  db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`,
         [username, password, 'receptionist'], (err) => {
    if (err) return res.send('Lỗi tạo lễ tân - có thể username đã tồn tại');
    res.redirect('/admin/manage-receptionists');
  });
});

// Manage PTs (Huấn luyện viên)
app.get('/admin/manage-pts', requireAuth, (req, res) => {
  db.all(`SELECT * FROM users WHERE role = 'pt' ORDER BY id`, [], (err, users) => {
    if (err) return res.send('Lỗi lấy danh sách PT');
    res.render('manage-users', { users: users || [], role: 'pt', title: '🏃 Quản Lý PT' });
  });
});

app.post('/admin/create-pt', requireAuth, (req, res) => {
  const { username, password, name, specialty, experience_years, bio, profile_picture } = req.body;
  if (!username || !password) return res.send('Bắt buộc nhập username và password');
  
  const insertPtUserSql = usePg ? `INSERT INTO users (username, password, role) VALUES (?, ?, ?) RETURNING id` : `INSERT INTO users (username, password, role) VALUES (?, ?, ?)`;
  db.run(insertPtUserSql,
         [username, password, 'pt'], function(err) {
    if (err) return res.send('Lỗi tạo PT - có thể username đã tồn tại');
    
    const ptUserId = this.lastID;
    const ptName = name && name.trim() ? name.trim() : username;
    
    db.run(`INSERT INTO pts (user_id, name, specialty, experience_years, bio, profile_picture) 
            VALUES (?, ?, ?, ?, ?, ?)`,
           [ptUserId, ptName, specialty || '', parseInt(experience_years) || 0, bio || '', profile_picture || ''], 
           (err2) => {
      if (err2) {
        console.error('Error creating PT profile:', err2);
        // PT user was created but profile failed - not critical
      }
      res.redirect('/admin/manage-pts');
    });
  });
});

// Reset password for any user
app.post('/admin/reset-password/:id', requireAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) return res.send('Bắt buộc nhập mật khẩu mới');
  db.run(`UPDATE users SET password = ? WHERE id = ?`, [newPassword, parseInt(req.params.id)], (err) => {
    if (err) return res.send('Lỗi reset mật khẩu');
    res.send('✅ Reset mật khẩu thành công! <a href="javascript:history.back()">Quay lại</a>');
  });
});

// Delete user
app.post('/admin/delete-user/:id', requireAuth, (req, res) => {
  db.run(`DELETE FROM users WHERE id = ?`, [parseInt(req.params.id)], (err) => {
    if (err) return res.send('Lỗi xóa tài khoản');
    res.send('✅ Xóa tài khoản thành công! <a href="javascript:history.back()">Quay lại</a>');
  });
});

// ========== DEVICE MANAGEMENT (ENHANCED) ==========
app.get('/admin/devices', requireAuth, (req, res) => {
  db.all(`SELECT * FROM devices ORDER BY floor`, [], (err, devices) => {
    if (err) return res.send('Lỗi lấy thiết bị');
    res.render('devices-enhanced', { devices: devices || [] });
  });
});

app.post('/admin/devices/add', requireAuth, (req, res) => {
  const { floor, ip } = req.body;
  if (!floor || !ip) return res.send('Bắt buộc nhập tầng và IP');
  if (!validateIP(ip)) return res.send('Lỗi: IP không hợp lệ (định dạng: xxx.xxx.xxx.xxx)');
  
  db.run(`INSERT INTO devices (floor, ip) VALUES (?, ?)`, [parseInt(floor), ip], (err) => {
    if (err) return res.send('Lỗi thêm thiết bị');
    res.redirect('/admin/devices');
  });
});

app.post('/admin/devices/update/:id', requireAuth, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.send('Bắt buộc nhập IP');
  if (!validateIP(ip)) return res.send('Lỗi: IP không hợp lệ');
  
  db.run(`UPDATE devices SET ip = ? WHERE id = ?`, [ip, parseInt(req.params.id)], (err) => {
    if (err) return res.send('Lỗi cập nhật thiết bị');
    res.redirect('/admin/devices');
  });
});

app.post('/admin/devices/delete/:id', requireAuth, (req, res) => {
  db.run(`DELETE FROM devices WHERE id = ?`, [parseInt(req.params.id)], (err) => {
    if (err) return res.send('Lỗi xóa thiết bị');
    res.redirect('/admin/devices');
  });
});

// 🔐 Scanner Interface - Real-time QR access control
app.get('/scanner', (req, res) => {
  res.render('scanner');
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  // First check users table
  db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, user) => {
    if (user) {
      if (user.role === 'member') {
        let loginCompleted = false;

        const findMemberAndLogin = (member) => {
          if (loginCompleted) return;
          loginCompleted = true;

          if (member) {
            req.session.user = { id: user.id, username: user.username, role: 'member', member_id: member.id };
          } else {
            req.session.user = { id: user.id, username: user.username, role: 'member' };
          }
          return res.redirect('/member/dashboard');
        };

        function queryMemberFallback() {
          // Try by phone first
          if (user.phone) {
            db.get(`SELECT * FROM members WHERE phone = ?`, [user.phone], (err1, member1) => {
              if (!loginCompleted && member1) {
                return findMemberAndLogin(member1);
              }
              // Try by username as phone
              if (!loginCompleted) {
                db.get(`SELECT * FROM members WHERE phone = ?`, [username], (err2, member2) => {
                  if (!loginCompleted && member2) {
                    return findMemberAndLogin(member2);
                  }
                  // Try by name
                  if (!loginCompleted) {
                    db.get(`SELECT * FROM members WHERE name = ?`, [username], (err3, member3) => {
                      if (!loginCompleted) {
                        findMemberAndLogin(member3);
                      }
                    });
                  }
                });
              }
            });
          } else {
            // No phone - try by username as phone then by name
            db.get(`SELECT * FROM members WHERE phone = ?`, [username], (err1, member1) => {
              if (!loginCompleted && member1) {
                return findMemberAndLogin(member1);
              }
              if (!loginCompleted) {
                db.get(`SELECT * FROM members WHERE name = ?`, [username], (err2, member2) => {
                  if (!loginCompleted) {
                    findMemberAndLogin(member2);
                  }
                });
              }
            });
          }
        }

        // Try direct member_id first
        if (user.member_id) {
          db.get(`SELECT * FROM members WHERE id = ?`, [user.member_id], (err2, member) => {
            if (!loginCompleted && member) {
              return findMemberAndLogin(member);
            }
            // If direct lookup fails, try fallback
            if (!loginCompleted) queryMemberFallback();
          });
        } else {
          queryMemberFallback();
        }

        return;
      }
      
      req.session.user = user;
      if (user.role === 'admin') res.redirect('/admin/dashboard');
      else if (user.role === 'receptionist') res.redirect('/receptionist/dashboard');
      else if (user.role === 'pt') res.redirect('/pt/dashboard');
      else res.redirect('/member/dashboard');
      return;
    }
    
    // If not found in users, check if username is phone number for member login
    db.get(`SELECT * FROM members WHERE phone = ?`, [username], (err, member) => {
      if (err || !member) return res.send('Đăng nhập không hợp lệ');
      
      req.session.user = { id: member.id, username: member.phone, role: 'member', member_id: member.id };
      res.redirect('/member/dashboard');
    });
  });
});

app.get('/admin/dashboard', requireAuth, (req, res) => {
  res.render('admin-dashboard');
});

app.get('/receptionist/dashboard', requireAuth, (req, res) => {
  res.render('receptionist-dashboard');
});

app.get('/pt/dashboard', requireAuth, (req, res) => {
  if (req.session.user.role !== 'pt') return res.redirect('/login');
  
  const ptUserId = req.session.user.id;
  
  // Get PT info
  db.get(`SELECT * FROM pts WHERE user_id = ?`, [ptUserId], (err, pt) => {
    if (err || !pt) return res.send('PT profile not found');
    
    // Get upcoming sessions (confirmed & pending)
    const today = new Date().toISOString().split('T')[0];
    db.all(`SELECT ps.*, m.name as member_name, m.phone as member_phone 
            FROM pt_sessions ps 
            JOIN members m ON ps.member_id = m.id 
            WHERE ps.pt_id = ? AND ps.date >= ? 
            ORDER BY ps.date ASC`, [pt.id, today], (err, sessions) => {
      if (err) return res.send('Lỗi lấy lịch dạy');
      
      // Get pending bookings (not yet confirmed and not rejected)
      db.all(`SELECT ps.*, m.name as member_name, m.phone as member_phone 
              FROM pt_sessions ps 
              JOIN members m ON ps.member_id = m.id 
              WHERE ps.pt_id = ? AND (ps.confirmed = 0 OR ps.confirmed IS NULL) AND (ps.rejection_reason IS NULL OR ps.rejection_reason = '') 
              ORDER BY ps.date ASC`, [pt.id], (err2, pendingBookings) => {
        if (err2) {
          console.error('Lỗi lấy pending bookings:', err2);
          pendingBookings = [];
        }
        res.render('pt-dashboard', { pt, sessions: sessions || [], pendingBookings: pendingBookings || [] });
      });
    });
  });
});

// PT update profile
app.get('/pt/edit-profile', requireAuth, (req, res) => {
  if (req.session.user.role !== 'pt') return res.redirect('/login');
  
  const ptUserId = req.session.user.id;
  db.get(`SELECT * FROM pts WHERE user_id = ?`, [ptUserId], (err, pt) => {
    if (err || !pt) return res.send('PT profile not found');
    res.render('pt-edit-profile', { pt });
  });
});

app.post('/pt/update-profile', requireAuth, (req, res) => {
  if (req.session.user.role !== 'pt') return res.redirect('/login');
  
  const ptUserId = req.session.user.id;
  const { name, specialty, experience_years, bio, profile_picture } = req.body;
  
  db.run(`UPDATE pts SET name = ?, specialty = ?, experience_years = ?, bio = ?, profile_picture = ? WHERE user_id = ?`,
         [name || '', specialty || '', parseInt(experience_years) || 0, bio || '', profile_picture || '', ptUserId], (err) => {
    if (err) return res.send('Lỗi cập nhật thông tin');
    res.redirect('/pt/dashboard');
  });
});

// PT reject session with reason
app.post('/pt/reject/:id', requireAuth, (req, res) => {
  if (req.session.user.role !== 'pt') return res.redirect('/login');
  
  const sessionId = parseInt(req.params.id);
  const ptUserId = req.session.user.id;
  const { rejection_reason } = req.body;
  
  // Verify session belongs to this PT
  db.get(`SELECT ps.*, p.name as pt_name FROM pt_sessions ps JOIN pts p ON ps.pt_id = p.id WHERE ps.id = ? AND p.user_id = ?`, 
         [sessionId, ptUserId], (err, session) => {
    if (err || !session) return res.send('Buổi học không tồn tại');
    
    db.run(`UPDATE pt_sessions SET rejection_reason = ?, confirmed = -1 WHERE id = ?`, 
           [rejection_reason || 'Không lý do', sessionId], (err) => {
      if (err) return res.send('Lỗi từ chối lịch');
      
      // Create notification for member
      const message = `❌ PT ${session.pt_name} từ chối buổi tập ngày ${session.date}. Lý do: ${rejection_reason || 'Không lý do'}`;
      createNotification({ member_id: session.member_id, message, status: 'rejected', origin: 'pt_rejection' });
      
      res.redirect('/pt/dashboard');
    });
  });
});

app.get('/member/dashboard', requireAuth, (req, res) => {
  if (req.session.user.role !== 'member') return res.redirect('/login');
  
  const memberId = req.session.user.member_id;
  const username = req.session.user.username;

  const renderMember = (member) => {
    if (member) return res.render('member-dashboard', { member });
    return res.send('Không tìm thấy hội viên');
  };

  if (memberId) {
    db.get(`SELECT * FROM members WHERE id = ?`, [memberId], (err, member) => {
      if (!err && member) return renderMember(member);
      db.get(`SELECT * FROM members WHERE phone = ? OR name = ?`, [username, username], (err2, member2) => {
        renderMember(member2);
      });
    });
  } else {
    db.get(`SELECT * FROM members WHERE phone = ? OR name = ?`, [username, username], (err, member) => {
      renderMember(member);
    });
  }
});

// Redirect tiện lợi từ /member-dashboard (với dấu -) sang đúng route
app.get('/member-dashboard', (req, res) => {
  res.redirect('/member/dashboard');
});

// Member PT booking
app.get('/member/book-pt', requireAuth, (req, res) => {
  if (req.session.user.role !== 'member') return res.redirect('/login');
  
  db.all(`SELECT p.*, u.username FROM pts p JOIN users u ON p.user_id = u.id`, [], (err, pts) => {
    if (err) return res.send('Lỗi lấy danh sách PT');
    res.render('member-book-pt', { pts: pts || [] });
  });
});

app.post('/member/book-pt', requireAuth, (req, res) => {
  if (req.session.user.role !== 'member') return res.redirect('/login');
  
  const { pt_id, date } = req.body;
  const member_id = req.session.user.member_id;
  
  // Check if member has PT sessions left
  db.get(`SELECT pt_sessions, name as member_name FROM members WHERE id = ?`, [member_id], (err, member) => {
    if (err || !member) return res.send('Lỗi lấy thông tin hội viên');
    if (member.pt_sessions <= 0) return res.send('Bạn đã hết buổi PT. Vui lòng gia hạn!');
    
    // Check conflict
    checkPTConflict(member_id, pt_id, date, (err, hasConflict) => {
      if (hasConflict) return res.send('PT này đã có lịch vào ngày này');
      
      db.run(`INSERT INTO pt_sessions (member_id, pt_id, date) VALUES (?, ?, ?)`, [member_id, pt_id, date], (err) => {
        if (err) return res.send('Lỗi đặt lịch PT');
        
        // Get PT info to send notifications
        db.get(`SELECT user_id, name as pt_name FROM pts WHERE id = ?`, [pt_id], (err, pt) => {
          if (pt) {
            // Create notification for PT
            const ptMessage = `📅 Hội viên ${member.member_name} vừa đặt lịch dạy ngày ${date}. Hãy xác nhận hoặc từ chối!`;
            createNotification({ receiver_user_id: pt.user_id, message: ptMessage, status: 'info', origin: 'member_booking' });
            
            // Create notification for Member
            const memberMessage = `✅ Bạn đã đặt lịch PT với ${pt.pt_name} vào ngày ${date}. Chờ PT xác nhận!`;
            createNotification({ member_id: member_id, message: memberMessage, status: 'info', origin: 'booking_confirmation' });
          }
        });
        
        res.redirect('/member/dashboard');
      });
    });
  });
});

app.get('/dashboard', (req, res) => {
  db.all(`SELECT floor, COUNT(*) as count FROM access_logs 
          WHERE timestamp > datetime('now', '-1 hour') 
          GROUP BY floor`, [], (err, rows) => {
    if (err) return res.send('Lỗi lấy dashboard');
    const allFloors = [1,2,3,4,5].map(f => ({
      floor: f,
      count: rows ? (rows.find(r => r.floor === f)?.count || 0) : 0
    }));
    res.render('dashboard', { data: allFloors });
  });
});

// PT reports - statistics for PT's sessions
app.get('/pt/reports', requireAuth, (req, res) => {
  if (req.session.user.role !== 'pt') return res.redirect('/login');
  
  const ptUserId = req.session.user.id;
  db.get(`SELECT id FROM pts WHERE user_id = ?`, [ptUserId], (err, pt) => {
    if (err || !pt) return res.send('PT not found');
    
    const ptId = pt.id;
    db.get(`SELECT COUNT(*) as pt_confirmed FROM pt_sessions WHERE pt_id = ? AND confirmed = 1`, [ptId], (err, ptRow) => {
      db.get(`SELECT COUNT(*) as pt_pending FROM pt_sessions WHERE pt_id = ? AND (confirmed = 0 OR confirmed IS NULL)`, [ptId], (err2, pendingRow) => {
        db.get(`SELECT COUNT(*) as pt_rejected FROM pt_sessions WHERE pt_id = ? AND rejection_reason IS NOT NULL`, [ptId], (err3, rejectedRow) => {
          res.render('pt-reports', { 
            pt_confirmed: ptRow?.pt_confirmed || 0,
            pt_pending: pendingRow?.pt_pending || 0,
            pt_rejected: rejectedRow?.pt_rejected || 0
          });
        });
      });
    });
  });
});

app.get('/admin/reports', (req, res) => {
  db.get(`SELECT COUNT(*) as member_count FROM members`, [], (err, memberRow) => {
    db.get(`SELECT COUNT(*) as access_count FROM access_logs`, [], (err, accessRow) => {
      db.get(`SELECT COUNT(*) as pt_confirmed FROM pt_sessions WHERE confirmed = 1`, [], (err, ptRow) => {
        db.get(`SELECT SUM(amount) as total_revenue FROM payments WHERE status = 'completed'`, [], (err, revenueRow) => {
          const revenue = revenueRow?.total_revenue || 0;
          res.render('reports', { 
            revenue, 
            members: memberRow?.member_count || 0, 
            accesses: accessRow?.access_count || 0,
            pt_confirmed: ptRow?.pt_confirmed || 0
          });
        });
      });
    });
  });
});

app.get('/receptionist/notifications', requireAuth, (req, res) => {
  db.all(`SELECT n.*, m.name AS member_name FROM notifications n LEFT JOIN members m ON n.member_id = m.id ORDER BY n.created_at DESC LIMIT 50`, [], (err, notes) => {
    if (err) return res.send('Lỗi lấy thông báo');
    res.render('receptionist-notifications', { notifications: notes || [] });
  });
});

// PT notifications
app.get('/pt/notifications', requireAuth, (req, res) => {
  if (req.session.user.role !== 'pt') return res.redirect('/login');
  const ptUserId = req.session.user.id;
  db.all(`SELECT * FROM notifications WHERE receiver_user_id = ? ORDER BY created_at DESC LIMIT 50`, [ptUserId], (err, notes) => {
    if (err) return res.send('Lỗi lấy thông báo');
    res.render('pt-notifications', { notifications: notes || [] });
  });
});

app.get('/admin/notifications', requireAuth, (req, res) => {
  db.all(`SELECT n.*, m.name AS member_name FROM notifications n LEFT JOIN members m ON n.member_id = m.id ORDER BY n.created_at DESC LIMIT 100`, [], (err, notes) => {
    if (err) return res.send('Lỗi lấy thông báo');
    res.render('receptionist-notifications', { notifications: notes || [] });
  });
});

app.get('/member/notifications', requireAuth, (req, res) => {
  if (!req.session.user || req.session.user.role !== 'member') return res.redirect('/login');
  const memberId = req.session.user.member_id;
  db.all(`SELECT * FROM notifications WHERE member_id = ? ORDER BY created_at DESC LIMIT 10`, [memberId], (err, notes) => {
    if (err) return res.send('Lỗi lấy thông báo');
    res.render('member-notifications', { notifications: notes || [] });
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.send('Lỗi đăng xuất');
    res.redirect('/login');
  });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`GymHome Demo running on port ${port}`);
});