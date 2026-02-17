import { pool } from "../db/pool.js";

export async function enqueueOutbox(type: "EMAIL_RECEIPT"|"FULFILL_SUBSCRIPTION", payload: any) {
  await pool.query(
    "INSERT INTO outbox(type,payload) VALUES($1,$2)",
    [type, payload]
  );
}
