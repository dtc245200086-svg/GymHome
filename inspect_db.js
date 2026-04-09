const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./gymhome.db');

db.serialize(() => {
  ['pts','members','users','pt_sessions','notifications'].forEach(table => {
    db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
      console.log(`${table.toUpperCase()} SCHEMA`, err || rows);
    });
  });
  db.all('SELECT id, user_id, name, specialty FROM pts', [], (err, rows) => {
    console.log('PTS', err || rows);
  });
  db.all('SELECT id, username, role, member_id, phone FROM users', [], (err, rows) => {
    console.log('USERS', err || rows);
  });
  db.all('SELECT id, name, phone, pt_sessions FROM members', [], (err, rows) => {
    console.log('MEMBERS', err || rows);
  });
});

db.close();
