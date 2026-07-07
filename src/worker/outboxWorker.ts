import { pool } from "../db/pool.js";
import { claimIdempotencyKey } from "../utils/idempotency.js";
import { sendEmail } from "../utils/mailer.js"
async function handleJob(job: any) {
  if (job.type === "EMAIL_RECEIPT") {
    const payload = job.payload;
    const userRes = await pool.query("SELECT email FROM users WHERE id=$1", [payload.userId]);
    const email = userRes.rows[0]?.email;

    if (!email) throw new Error(`No email for userId=${payload.userId}`);

    await sendEmail({
      to: email,
      subject: "Payment receipt",
      html: `Thanks! Invoice: ${payload.invoiceId}\nPaid: ${payload.amountPaid} ${payload.currency}`,
    });
    return;
  }

  if (job.type === "FULFILL_SUBSCRIPTION") {
    const payload = job.payload;

    const key = `FULFILLMENT:${payload.invoiceId}`;
    const claimed = await claimIdempotencyKey(key, "FULFILLMENT");
    if (claimed) console.log("✅ Fulfilled subscription for invoice:", payload.invoiceId);
    else console.log("↩️ Fulfillment already done for invoice:", payload.invoiceId);
    return;
  }
}

export function startOutboxWorker() {
  setInterval(async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const jobRes = await client.query(
        `SELECT *
         FROM outbox
         WHERE status='PENDING' AND next_run_at <= now()
         ORDER BY created_at ASC
         LIMIT 5
         FOR UPDATE SKIP LOCKED`
      );

      if (jobRes.rows.length === 0) {
        await client.query("COMMIT");
        return;
      }

      // mark all selected jobs as PROCESSING
      const ids = jobRes.rows.map((r: any) => r.id);
      await client.query(`UPDATE outbox SET status='PROCESSING' WHERE id = ANY($1)`, [ids]);

      await client.query("COMMIT");

      // process each job
      for (const job of jobRes.rows) {
        try {
          await handleJob(job);
          await pool.query("UPDATE outbox SET status='DONE' WHERE id=$1", [job.id]);
        } catch (err: any) {
          const msg = String(err?.message ?? err);

          await pool.query(
            `UPDATE outbox
             SET status='PENDING',
                 attempts = attempts + 1,
                 last_error = $2,
                 next_run_at = now() + (INTERVAL '1 minute' * LEAST(30, attempts + 1))
             WHERE id = $1`,
            [job.id, msg]
          );

          console.error("Outbox job failed:", { id: job.id, type: job.type, msg });
        }
      }
    } catch (e) {
      console.error("Outbox worker loop error:", e);
      try {
        await client.query("ROLLBACK");
      } catch {}
    } finally {
      client.release();
    }
  }, 2000);
}