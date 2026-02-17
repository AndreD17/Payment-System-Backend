import nodemailer from "nodemailer";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { claimIdempotencyKey } from "../utils/idempotency.js";
const transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined
});
async function sendEmail(to, subject, text) {
    await transporter.sendMail({ from: env.emailFrom, to, subject, text });
}
export function startOutboxWorker() {
    setInterval(async () => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const jobRes = await client.query(`SELECT * FROM outbox
         WHERE status='PENDING' AND next_run_at <= now()
         ORDER BY created_at ASC
         LIMIT 5
         FOR UPDATE SKIP LOCKED`);
            if (jobRes.rows.length === 0) {
                await client.query("COMMIT");
                return;
            }
            const job = jobRes.rows[0];
            await client.query("UPDATE outbox SET status='PROCESSING' WHERE id=$1", [job.id]);
            await client.query("COMMIT");
            // process outside transaction
            if (job.type === "EMAIL_RECEIPT") {
                const payload = job.payload;
                const userRes = await pool.query("SELECT email FROM users WHERE id=$1", [payload.userId]);
                const email = userRes.rows[0]?.email;
                if (email) {
                    await sendEmail(email, "Payment receipt", `Thanks! Invoice: ${payload.invoiceId}\nPaid: ${payload.amountPaid} ${payload.currency}`);
                }
            }
            if (job.type === "FULFILL_SUBSCRIPTION") {
                const payload = job.payload;
                // Idempotent fulfillment key: same invoice should not fulfill twice
                const key = `FULFILLMENT:${payload.invoiceId}`;
                const claimed = await claimIdempotencyKey(key, "FULFILLMENT");
                if (claimed) {
                    // Do real fulfillment: enable premium, provision resources, etc.
                    // For portfolio: update a user flag or write a log row
                    console.log("✅ Fulfilled subscription for invoice:", payload.invoiceId);
                }
                else {
                    console.log("↩️ Fulfillment already done for invoice:", payload.invoiceId);
                }
            }
            await pool.query("UPDATE outbox SET status='DONE' WHERE id=$1", [job.id]);
        }
        catch (e) {
            // exponential-ish retry
            try {
                await pool.query(`UPDATE outbox
           SET status='PENDING',
               attempts=attempts+1,
               last_error=$2,
               next_run_at = now() + (INTERVAL '1 minute' * LEAST(30, attempts+1))
           WHERE id=$1`, [(e?.jobId ?? null), String(e?.message ?? e)]);
            }
            catch { }
            console.error("Outbox worker error:", e);
            try {
                await client.query("ROLLBACK");
            }
            catch { }
        }
        finally {
            client.release();
        }
    }, 2000);
}
