import { pool } from "../db/pool.js";

export async function claimIdempotencyKey(key: string, scope: string): Promise<boolean> {
  try {
    await pool.query(
      "INSERT INTO idempotency_keys(key,scope) VALUES($1,$2)",
      [key, scope]
    );
    return true;
  } catch {
    return false;
  }
}
