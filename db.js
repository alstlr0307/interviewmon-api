// api/db.js
const mysql = require('mysql2/promise');

// 환경변수: 언더바 있는/없는 둘 다 지원
const host =
  process.env.MYSQL_HOST ||
  process.env.MYSQLHOST ||
  '127.0.0.1';

const port =
  Number(process.env.MYSQL_PORT || process.env.MYSQLPORT || 3306);

const user =
  process.env.MYSQL_USER ||
  process.env.MYSQLUSER ||
  'root';

const password =
  process.env.MYSQL_PASSWORD ||
  process.env.MYSQLPASSWORD ||
  '';

const database =
  process.env.MYSQL_DATABASE ||
  process.env.MYSQLDATABASE ||
  'interviewmon';

const pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_POOL || 10),
  queueLimit: 0,
  dateStrings: false, // JS Date 객체로
});

module.exports = { pool };
