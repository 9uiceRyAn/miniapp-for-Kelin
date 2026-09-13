require('dotenv').config();

const { testConnection, pool } = require('./src/db');

async function main() {
  try {
    await testConnection();

    const [rows] = await pool.query('SHOW TABLES');

    console.log('MySQL connection successful.');
    console.log(rows);
  } catch (error) {
    console.error('MySQL connection failed:');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
