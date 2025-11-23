// api/db.js
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'interviewmon',
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_POOL || 10),
  queueLimit: 0,
  dateStrings: false, // JS Date 객체로
});

module.exports = { pool };
