const fsp = require('fs/promises');
const path = require('path');
const { pool } = require('../db');

async function statDisk(targetDir) {
  let probePath = path.resolve(targetDir || '.');
  try {
    await fsp.access(probePath);
  } catch {
    probePath = path.dirname(probePath);
  }
  const stats = await fsp.statfs(probePath);
  const bsize = Number(stats.bsize || 0);
  const totalBytes = bsize * Number(stats.blocks || 0);
  const freeBytes = bsize * Number(stats.bavail ?? stats.bfree ?? 0);
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const usedPercent = totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 1000) / 10) : 0;
  return { totalBytes, freeBytes, usedBytes, usedPercent };
}

async function queryUploads() {
  let activeCount = 0;
  let activeBytes = 0;
  let trashCount = 0;
  let trashBytes = 0;
  try {
    const [rows] = await pool.query(
      'SELECT (deleted_at IS NOT NULL) AS in_trash, COUNT(*) AS cnt, COALESCE(SUM(file_size), 0) AS bytes FROM files GROUP BY (deleted_at IS NOT NULL)',
    );
    for (const row of rows) {
      if (row.in_trash) {
        trashCount = Number(row.cnt || 0);
        trashBytes = Number(row.bytes || 0);
      } else {
        activeCount = Number(row.cnt || 0);
        activeBytes = Number(row.bytes || 0);
      }
    }
  } catch {
    try {
      const [rows] = await pool.query('SELECT COUNT(*) AS cnt, COALESCE(SUM(file_size), 0) AS bytes FROM files');
      activeCount = Number(rows[0]?.cnt || 0);
      activeBytes = Number(rows[0]?.bytes || 0);
    } catch {}
  }
  return { activeCount, activeBytes, trashCount, trashBytes };
}

async function getStorageSummary(targetDir) {
  const [disk, uploads] = await Promise.all([statDisk(targetDir), queryUploads()]);
  return { disk, uploads };
}

module.exports = { getStorageSummary, statDisk };
