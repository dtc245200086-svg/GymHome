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
const usePg = !!process.env.DATABASE_URL;
let sqliteDb;
let pgPool;

function replaceSqliteFunctions(sql) {
  if (!usePg) return sql;
  return sql
    .replace(/datetime\('now'\)/g, 'NOW()')
    .replace(/date\('now'\)/g, 'CURRENT_DATE')
    .replace(/date\('now', '\+30 days'\)/g, "CURRENT_DATE + INTERVAL '30 days'");
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
        .then(res => callback && callback(null, res))
        .catch(err => callback && callback(err));
    }
    return sqliteDb.run(sql, params, function (err) {
      if (callback) callback(err, this);
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
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  sqliteDb = new sqlite3.Database('./gymhome.db');
}

// Init DB
function initSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS members (
    id SERIAL PRIMARY KEY,
    name TEXT,
    phone TEXT,
    type TEXT,
    expiry DATE,
    pt_sessions INTEGER DEFAULT 0
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS access_logs (
    id SERIAL PRIMARY KEY,
    member_id INTEGER,
    floor INTEGER,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    id SERIAL PRIMARY KEY,
    floor INTEGER,
    ip TEXT
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS pt_sessions (
    id SERIAL PRIMARY KEY,
    member_id INTEGER,
    pt_id INTEGER,
    date DATE,
    confirmed BOOLEAN DEFAULT FALSE
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS floor_capacity (
    floor INTEGER PRIMARY KEY,
    max_capacity INTEGER DEFAULT 50,
    current_count INTEGER DEFAULT 0
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT,
    password TEXT,
    role TEXT,
    member_id INTEGER,
    phone TEXT
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS qr_codes (
    id SERIAL PRIMARY KEY,
    member_id INTEGER,
    qr_data TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    used BOOLEAN DEFAULT FALSE
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    member_id INTEGER,
    amount REAL,
    type TEXT,
    date DATE DEFAULT CURRENT_DATE,
    status TEXT DEFAULT 'completed'
  )`, []);
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id SERIAL PRIMARY KEY,
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

      db.run(`INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES (?, ?, ?, ?, ?)`, [name, phone, type, expiry, parseInt(pt_sessions) || 0], function(err) {
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

function generateCodeForMember(member, res) {
  const today = new Date().toISOString().split('T')[0];
  if (new Date(member.expiry) < new Date(today)) {
    return res.send('Thẻ đã hết hạn - Vui lòng gia hạn');
  }

  const qrData = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();

  db.run(`INSERT INTO qr_codes (member_id, qr_data, expires_at) VALUES (?, ?, ?)`, [member.id, qrData, expiresAt], function(err) {
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
  
  // Check if QR exists and is valid
  const expiryCondition = usePg ? 'expires_at > NOW()' : "expires_at > datetime('now')";
  db.get(`SELECT * FROM qr_codes WHERE qr_data = ? AND used = 0 AND ${expiryCondition}`, [qr_data], (err, qr) => {
    if (err || !qr) {
      return res.json({ 
        success: false, 
        message: '❌ QR không hợp lệ hoặc đã hết hạn',
        type: 'invalid'
      });
    }
    
    const member_id = qr.member_id;
    db.get(`SELECT * FROM members WHERE id = ?`, [member_id], (err, member) => {
      if (err || !member) {
        return res.json({ 
          success: false, 
          message: '❌ Hội viên không tồn tại',
          type: 'error'
        });
      }
      
      const today = new Date().toISOString().split('T')[0];
      if (new Date(member.expiry) < new Date(today)) {
        return res.json({ 
          success: false, 
          message: '❌ Thẻ đã hết hạn - Vui lòng gia hạn',
          type: 'expired',
          member: member
        });
      }
      
      const floorNumber = parseInt(floor, 10);
      if (member.type === 'Regular' && floorNumber > 3) {
        return res.json({ 
          success: false, 
          message: `❌ Thẻ ${member.type} chỉ được vào tầng 1-3, không vào tầng ${floorNumber}`,
          type: 'restricted',
          member: member
        });
      }
      
      // Mark QR as used
      db.run(`UPDATE qr_codes SET used = 1 WHERE id = ?`, [qr.id], (err) => {
        if (err) {
          return res.json({ 
            success: false, 
            message: '❌ Lỗi cập nhật QR',
            type: 'error'
          });
        }
        
        // Log access
        db.run(`INSERT INTO access_logs (member_id, floor) VALUES (?, ?)`, [member_id, floorNumber], (err) => {
          if (err) {
            return res.json({ 
              success: false, 
              message: '❌ Lỗi ghi log truy cập',
              type: 'error'
            });
          }
          
          // Update floor capacity
          db.run(`UPDATE floor_capacity SET current_count = current_count + 1 WHERE floor = ?`, [floorNumber], (err) => {
            if (err) {
              console.log('Error updating floor capacity:', err);
            }
            
            res.json({ 
              success: true, 
              message: `✅ Chào mừng ${member.name}! Truy cập tầng ${floor}`,
              type: 'success',
              member: {
                name: member.name,
                phone: member.phone,
                type: member.type,
                expiry: member.expiry,
                pt_sessions: member.pt_sessions
              },
              floor: floor,
              timestamp: new Date().toLocaleTimeString('vi-VN')
            });
          });
        });
      });
    });
  });
});

app.get('/pt', (req, res) => {
  db.all(`SELECT ps.*, m.name as member_name FROM pt_sessions ps JOIN members m ON ps.member_id = m.id`, [], (err, rows) => {
    if (err) return res.send('Lỗi lấy danh sách PT');
    res.render('pt', { sessions: rows });
  });
});

app.post('/pt/confirm/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.run(`UPDATE pt_sessions SET confirmed = 1 WHERE id = ?`, [id], (err) => {
    if (err) return res.send('Lỗi xác nhận');
    db.run(`UPDATE members SET pt_sessions = pt_sessions - 1 WHERE id = (SELECT member_id FROM pt_sessions WHERE id = ?) AND pt_sessions > 0`, [id], (err) => {
      res.redirect('/pt');
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
        ptAlerts: ptAlerts || [] 
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
    const totalRevenue = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
    res.render('payments', { payments: payments || [], totalRevenue });
  });
});

app.post('/admin/payment/add', (req, res) => {
  const { member_id, amount, type } = req.body;
  db.run(`INSERT INTO payments (member_id, amount, type) VALUES (?, ?, ?)`,
         [parseInt(member_id), parseFloat(amount), type], (err) => {
    if (err) return res.send('Lỗi thêm thanh toán');
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
    const totalRevenue = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
    res.render('payments', { payments: payments || [], totalRevenue });
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

  db.run(`INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES (?, ?, ?, ?, ?)`,
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
  const { username, password } = req.body;
  if (!username || !password) return res.send('Bắt buộc nhập username và password');
  db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`,
         [username, password, 'pt'], (err) => {
    if (err) return res.send('Lỗi tạo PT - có thể username đã tồn tại');
    res.redirect('/admin/manage-pts');
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
        const findMemberAndLogin = (member) => {
          if (member) {
            req.session.user = { id: user.id, username: user.username, role: 'member', member_id: member.id };
          } else {
            req.session.user = { id: user.id, username: user.username, role: 'member' };
          }
          return res.redirect('/member/dashboard');
        };

        const queryMemberFallback = (done) => {
          if (user.phone) {
            db.get(`SELECT * FROM members WHERE phone = ?`, [user.phone], (err1, member1) => {
              if (!err1 && member1) return done(member1);
            });
          }
          db.get(`SELECT * FROM members WHERE phone = ?`, [username], (err1, member1) => {
            if (!err1 && member1) return done(member1);

            db.get(`SELECT * FROM members WHERE name = ?`, [username], (err2, member2) => {
              if (!err2 && member2) return done(member2);

              db.get(`SELECT * FROM members WHERE id = ?`, [user.member_id || user.id], (err3, member3) => {
                return done(member3);
              });
            });
          });
        };

        if (user.member_id) {
          db.get(`SELECT * FROM members WHERE id = ?`, [user.member_id], (err2, member) => {
            if (!err2 && member) return findMemberAndLogin(member);
            queryMemberFallback(findMemberAndLogin);
          });
        } else {
          queryMemberFallback(findMemberAndLogin);
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
      
      // For demo, accept any password for members, or check a default
      // Here, assume password is 'member' or something, but for simplicity, allow
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
  res.render('pt-dashboard');
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

app.get('/admin/reports', (req, res) => {
  db.get(`SELECT COUNT(*) as member_count FROM members`, [], (err, memberRow) => {
    db.get(`SELECT COUNT(*) as access_count FROM access_logs`, [], (err, accessRow) => {
      db.get(`SELECT COUNT(*) as pt_confirmed FROM pt_sessions WHERE confirmed = 1`, [], (err, ptRow) => {
        const revenue = (memberRow?.member_count || 0) * 100; // Mock
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