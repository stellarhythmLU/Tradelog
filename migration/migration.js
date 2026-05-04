// ═══════════════════════════════════════════════════════════════
// migration/migration.js — 本地数据迁移工具（预留接口，暂未启用）
//
// 启用方式：将 MIGRATION_ENABLED 改为 true
// 建议在 v2.x 版本稳定后再决定是否使用
// 使用场景：将 v1.x 在本地浏览器中存储的数据一次性迁移到 Firestore
// ═══════════════════════════════════════════════════════════════

const MIGRATION_ENABLED = false;

/**
 * 从 localStorage 读取 v1.x 格式数据并写入 Firestore
 * @param {string} uid - 当前登录用户的 Firebase UID
 * @param {Object} dbModule - 从 src/db.js 导入的数据库模块
 */
export async function migrateLocalDataToFirestore(uid, dbModule) {
  if (!MIGRATION_ENABLED) {
    console.log('[migration] 迁移功能未启用，如需使用请将 MIGRATION_ENABLED 设为 true');
    return { skipped: true };
  }

  // ── 待实现区域（MIGRATION_ENABLED = true 时生效）────────────
  //
  // Step 1: 读取 localStorage 中的 v1.x 数据
  // const raw = localStorage.getItem('tl_v7');
  // if (!raw) return { error: '本地未找到 v1.x 数据' };
  // const local = JSON.parse(raw);
  //
  // Step 2: 写入 trades
  // if (local.trades?.length) {
  //   await dbModule.batchAddTrades(uid, local.trades);
  // }
  //
  // Step 3: 写入 cashFlows
  // if (local.cashFlows?.length) {
  //   await dbModule.batchAddCashFlows(uid, local.cashFlows);
  // }
  //
  // Step 4: 写入 dailySnapshots
  // if (local.dailySnapshots) {
  //   for (const [date, snap] of Object.entries(local.dailySnapshots)) {
  //     await dbModule.saveSnapshot(uid, date, snap);
  //   }
  // }
  //
  // Step 5: 写入 analysisData
  // if (local.analysisData) {
  //   for (const [key, data] of Object.entries(local.analysisData)) {
  //     await dbModule.saveAnalysis(uid, key, data);
  //   }
  // }
  //
  // Step 6: 写入 journalEntries
  // if (local.journalEntries) {
  //   for (const [date, entry] of Object.entries(local.journalEntries)) {
  //     await dbModule.saveJournal(uid, date, entry);
  //   }
  // }
  //
  // Step 7: 写入元数据
  // await dbModule.saveMeta(uid, local);
  //
  // return { success: true, trades: local.trades?.length, cashFlows: local.cashFlows?.length };
  // ─────────────────────────────────────────────────────────────
}
