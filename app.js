const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
const session = require('express-session');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static('public'));

// Session middleware
app.use(session({
  secret: 'gymhome-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Database
const db = new sqlite3.Database('./gymhome.db');

// Init DB
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    type TEXT,
    expiry DATE,
    pt_sessions INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER,
    floor INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    floor INTEGER,
    ip TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS pt_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER,
    pt_id INTEGER,
    date DATE,
    confirmed BOOLEAN DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS floor_capacity (
    floor INTEGER PRIMARY KEY,
    max_capacity INTEGER DEFAULT 50,
    current_count INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    password TEXT,
    role TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS qr_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER,
    qr_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    used BOOLEAN DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER,
    amount REAL,
    type TEXT,
    date DATE DEFAULT CURRENT_DATE,
    status TEXT DEFAULT 'completed'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER,
    date DATE,
    check_in_time TIME,
    check_out_time TIME
  )`);

  // Insert mock data if empty
  db.get(`SELECT COUNT(*) as count FROM members`, [], (err, row) => {
    if (row.count === 0) {
      db.run(`INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES ('Nguyen Van A', '0123456789', 'Regular', '2026-12-31', 10)`);
      db.run(`INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES ('Tran Thi B', '0987654321', 'VIP', '2026-12-31', 20)`);
    }
  });
  db.get(`SELECT COUNT(*) as count FROM devices`, [], (err, row) => {
    if (row.count === 0) {
      for (let i = 1; i <= 5; i++) {
        db.run(`INSERT INTO devices (floor, ip) VALUES (?, ?)`, [i, `192.168.1.${i}`]);
      }
    }
  });
  db.get(`SELECT COUNT(*) as count FROM pt_sessions`, [], (err, row) => {
    if (row.count === 0) {
      db.run(`INSERT INTO pt_sessions (member_id, pt_id, date) VALUES (1, 1, '2026-03-29')`);
    }
  });
  db.get(`SELECT COUNT(*) as count FROM users`, [], (err, row) => {
    if (row.count === 0) {
      db.run(`INSERT INTO users (username, password, role) VALUES ('admin', 'admin', 'admin')`);
      db.run(`INSERT INTO users (username, password, role) VALUES ('letan', 'letan', 'receptionist')`);
      db.run(`INSERT INTO users (username, password, role) VALUES ('pt', 'pt', 'pt')`);
      db.run(`INSERT INTO users (username, password, role) VALUES ('member', 'member', 'member')`);
    }
  });
});

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

function requireRole(role) {
  return (req, res, next) => {
    if (req.session.user && req.session.user.role === role) {
      return next();
    } else {
      res.redirect('/login');
    }
  };
}

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
  const { name, phone, type, expiry, pt_sessions } = req.body;
  
  // Validate phone
  if (!validatePhone(phone)) {
    return res.send('Lỗi: Số điện thoại phải 10 chữ số và bắt đầu bằng số mạng hợp lệ (010-020, 090-099)');
  }
  
  db.run(`INSERT INTO members (name, phone, type, expiry, pt_sessions) VALUES (?, ?, ?, ?, ?)`, [name, phone, type, expiry, parseInt(pt_sessions) || 0], function(err) {
    if (err) return res.send('Lỗi đăng ký hội viên');
    res.redirect('/members');
  });
});

app.get('/members', (req, res) => {
  db.all(`SELECT * FROM members`, [], (err, rows) => {
    if (err) return res.send('Lỗi lấy danh sách hội viên');
    res.render('members', { members: rows });
  });
});

app.get('/qr/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.get(`SELECT * FROM members WHERE id = ?`, [id], (err, member) => {
    if (err || !member) return res.send('Hội viên không tồn tại');
    const qrData = JSON.stringify({ member_id: id, timestamp: Date.now(), name: member.name, type: member.type });
    qrcode.toDataURL(qrData, (err, url) => {
      if (err) return res.send('Lỗi tạo QR');
      res.render('qr', { qr: url, id, member });
    });
  });
});

app.post('/access', (req, res) => {
  const { qr_data, floor } = req.body;
  try {
    const data = JSON.parse(qr_data);
    const member_id = data.member_id;
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
      
      if (member.type === 'Regular' && floor > 3) {
        return res.json({ 
          success: false, 
          message: `❌ Thẻ ${member.type} chỉ được vào tầng 1-3, không vào tầng ${floor}`,
          type: 'restricted',
          member: member
        });
      }
      
      db.run(`INSERT INTO access_logs (member_id, floor) VALUES (?, ?)`, [member_id, floor], (err) => {
        if (err) {
          return res.json({ 
            success: false, 
            message: '❌ Lỗi ghi log truy cập',
            type: 'error'
          });
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
  } catch (e) {
    res.json({ 
      success: false, 
      message: '❌ QR không hợp lệ hoặc hết hạn',
      type: 'invalid'
    });
  }
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

app.get('/admin/devices', (req, res) => {
  db.all(`SELECT * FROM devices`, [], (err, rows) => {
    if (err) return res.send('Lỗi lấy thiết bị');
    res.render('devices', { devices: rows });
  });
});

app.post('/admin/devices/:id', (req, res) => {
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
  db.all(`SELECT fc.*, 
          (SELECT COUNT(*) FROM access_logs 
           WHERE floor = fc.floor AND 
           timestamp > datetime('now', '-1 hour')) as current_count
          FROM floor_capacity fc`, [], (err, floors) => {
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
    res.render('attendance', { attendance: rows || [], today });
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
  db.all(`SELECT u.*, m.name as member_name FROM users u 
          LEFT JOIN members m ON m.id = u.id 
          WHERE u.role = 'member' ORDER BY u.id`, [], (err, users) => {
    if (err) return res.send('Lỗi lấy danh sách hội viên');
    res.render('manage-users', { users: users || [], role: 'member', title: '👥 Quản Lý Hội Viên' });
  });
});

app.post('/admin/create-member', requireAuth, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.send('Bắt buộc nhập username và password');
  db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`,
         [username, password, 'member'], (err) => {
    if (err) return res.send('Lỗi tạo hội viên - có thể username đã tồn tại');
    res.redirect('/admin/manage-members');
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
  db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, user) => {
    if (err || !user) return res.send('Đăng nhập không hợp lệ');
    req.session.user = user;
    if (user.role === 'admin') res.redirect('/admin/dashboard');
    else if (user.role === 'receptionist') res.redirect('/receptionist/dashboard');
    else if (user.role === 'pt') res.redirect('/pt/dashboard');
    else res.redirect('/member/dashboard');
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
  // Giả sử member đầu tiên, có thể cải thiện sau
  db.get(`SELECT * FROM members LIMIT 1`, [], (err, member) => {
    if (err || !member) return res.send('Không có hội viên');
    res.render('member-dashboard', { member });
  });
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

app.listen(3000, () => {
  console.log('GymHome Demo running on port 3000');
});