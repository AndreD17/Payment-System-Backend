import { pool } from "../db/pool.js";
/** Returns true if key was inserted; false if already exists */
export async function claimIdempotencyKey(key, scope) {
    try {
        await pool.query("INSERT INTO idempotency_keys(key,scope) VALUES($1,$2)", [key, scope]);
        return true;
    }
    catch {
        return false;
    }
}
