import request from "supertest";
import { describe, it, expect, afterAll } from "@jest/globals";
import { createApp } from "../app";
import { pool } from "../db/pool.js";

describe("Backend App", () => {
  const app = createApp();

  it("should return healthy status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: "Server is healthy up and running.." });
  });

  afterAll(async () => {
    await pool.end();
  });
});
