import test from "node:test";
import assert from "node:assert/strict";
import { SupabaseSyncService } from "../server/services/supabase.js";
import type { Job } from "../server/types.js";

test("SupabaseSyncService Unit Tests", async (t) => {
  await t.test("mapJobToRow should correctly map internal Job to Supabase PostgreSQL columns", () => {
    const mockJob: Job = {
      id: "abc123md5",
      title: "Desenvolvedor Full Stack React/Node",
      company: "Tech Company",
      location: "São Paulo, SP",
      workModel: "REMOTO",
      salary: "R$ 10.000",
      contractType: "CLT",
      seniorityLevel: "PLENO",
      url: "https://gupy.io/jobs/12345",
      source: "GUPY",
      stack: ["React", "Node.js", "TypeScript"],
      description: "Descrição da oportunidade",
      isTech: true,
      scrapedAt: "2026-09-15T12:00:00.000Z",
    };

    const row = SupabaseSyncService.mapJobToRow(mockJob);

    assert.equal(row.id, "abc123md5");
    assert.equal(row.title, "Desenvolvedor Full Stack React/Node");
    assert.equal(row.company, "Tech Company");
    assert.equal(row.location, "São Paulo, SP");
    assert.equal(row.work_model, "REMOTO");
    assert.equal(row.salary, "R$ 10.000");
    assert.equal(row.contract_type, "CLT");
    assert.equal(row.seniority_level, "PLENO");
    assert.equal(row.url, "https://gupy.io/jobs/12345");
    assert.equal(row.source, "GUPY");
    assert.deepEqual(row.stack, ["React", "Node.js", "TypeScript"]);
    assert.equal(row.description, "Descrição da oportunidade");
    assert.equal(row.is_tech, true);
    assert.equal(row.scraped_at, "2026-09-15T12:00:00.000Z");
  });

  await t.test("isConfigured should return false when environment variables are missing", () => {
    const originalUrl = process.env.SUPABASE_URL;
    const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    try {
      assert.equal(SupabaseSyncService.isConfigured(), false);
    } finally {
      if (originalUrl) process.env.SUPABASE_URL = originalUrl;
      if (originalKey) process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    }
  });

  await t.test("syncJob should gracefully return false without throwing when not configured", async () => {
    const mockJob: Job = {
      id: "abc123md5",
      title: "Engenheiro de Software",
      company: "Acme",
      location: "Remoto",
      workModel: "REMOTO",
      contractType: "CLT",
      seniorityLevel: "SENIOR",
      url: "https://example.com/job/1",
      source: "TEST",
      stack: ["Go"],
      scrapedAt: new Date().toISOString(),
      isTech: true,
    };

    const result = await SupabaseSyncService.syncJob(mockJob);
    assert.equal(result, false);
  });
});

