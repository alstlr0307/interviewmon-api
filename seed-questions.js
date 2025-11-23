// api/seed-questions.js
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const { pool } = require('./db');

/** Upsert by (company, text(255)) unique key */
async function upsertQuestion(company, q) {
  const text = (q.text || '').trim();
  if (!text) return;
  const category = q.category || null;

  await pool.execute(
    `INSERT INTO questions (text, category, company)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE category=VALUES(category)`,
    [text, category, company]
  );
}

async function seedCompany(company) {
  const f = path.resolve(process.cwd(), `seeds/questions/${company}.json`);
  if (!fs.existsSync(f)) {
    console.warn(`[SKIP] ${company}: seeds/questions/${company}.json 없음`);
    return;
  }
  const arr = JSON.parse(fs.readFileSync(f, 'utf-8'));
  for (const q of arr) await upsertQuestion(company, q);
  console.log(`[OK] ${company} ${arr.length}문항 삽입/갱신`);
}

(async () => {
  const companies = ['samsung','apple','nvidia','nexon','amd','intel']; // 6개
  for (const c of companies) await seedCompany(c);
  await pool.end();
  console.log('완료');
})();
