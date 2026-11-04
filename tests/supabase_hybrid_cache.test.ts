import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { ConfigService } from "../server/services/config.js";
import { SupabaseCompanyRow, SupabaseSyncService } from "../server/services/supabase.js";
import { runCompaniesSync } from "../scripts/sync-companies.js";

describe("ConfigService & Supabase Hybrid Hot Cache (#19)", () => {
  let tmpDir: string;
  let tmpConfigPath: string;
  let originalUrl: string | undefined;
  let originalKey: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  const sampleLocalConfig = {
    searchTerms: ["typescript", "node"],
    seniorityLevels: ["JUNIOR", "PLENO", "SENIOR"],
    contractTypes: ["CLT", "PJ"],
    sources: [{ id: "GUPY", name: "Gupy", type: "CLT", enabled: true, fastMode: true }],
    gupyCompanies: [
      {
        name: "Cielo",
        slug: "cielo",
        link: "https://cielo.gupy.io",
        enabled: true,
        status: "healthy" as const,
      },
      {
        name: "PagBank",
        slug: "pagseguro",
        link: "https://pagseguro.gupy.io",
        enabled: true,
      },
    ],
    greenhouseCompanies: [
      {
        name: "Agibank",
        slug: "agibank",
        link: "https://boards.greenhouse.io/agibank",
        enabled: true,
      },
    ],
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobsfinder-hybrid-cache-"));
    tmpConfigPath = path.join(tmpDir, "search.config.json");
    fs.writeFileSync(tmpConfigPath, JSON.stringify(sampleLocalConfig, null, 2), "utf-8");

    ConfigService.setConfigFilePath(tmpConfigPath);
    ConfigService.resetCache();

    (SupabaseSyncService as unknown as { envLoaded: boolean }).envLoaded = true;
    originalUrl = process.env.SUPABASE_URL;
    originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl !== undefined) process.env.SUPABASE_URL = originalUrl;
    else delete process.env.SUPABASE_URL;

    if (originalKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    ConfigService.setConfigFilePath(
      path.resolve(process.cwd(), "config/search.config.json"),
    );
    ConfigService.resetCache();

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should automatically fall back to local search.config.json when Supabase is not configured", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const stats = await ConfigService.initializeHotCache();

    assert.equal(stats.source, "local_fallback");
    assert.equal(stats.totalCompanies, 3);
    assert.equal(stats.byAts.GUPY, 2);
    assert.equal(stats.byAts.GREENHOUSE, 1);

    const cfg = ConfigService.getConfig();
    assert.equal(cfg.gupyCompanies.length, 2);
    assert.equal(cfg.gupyCompanies[0].slug, "cielo");
  });

  it("should gracefully fall back to local search.config.json when Supabase connection fails or is offline", async () => {
    process.env.SUPABASE_URL = "https://mock.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-role-key";

    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED: Supabase offline");
    };

    const stats = await ConfigService.initializeHotCache();

    assert.equal(stats.source, "local_fallback");
    assert.ok(stats.lastError?.includes("ECONNREFUSED"));
    assert.equal(stats.totalCompanies, 3);

    const cfg = ConfigService.getConfig();
    assert.equal(cfg.gupyCompanies.length, 2);
    assert.equal(cfg.greenhouseCompanies?.length, 1);
  });

  it("should hydrate RAM Hot Cache from Supabase public.companies when online and serve subsequent reads from memory without network calls", async () => {
    process.env.SUPABASE_URL = "https://mock.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-role-key";

    let fetchCalls = 0;
    const remoteRows: SupabaseCompanyRow[] = [
      {
        id: "comp-gupy-itau",
        name: "Itaú Unibanco",
        ats: "GUPY",
        slug: "vemproitau",
        url: "https://vemproitau.gupy.io",
        enabled: true,
        health_status: "HEALTHY",
        failure_count: 0,
        last_scraped_at: "2026-10-31T00:00:00.000Z",
      },
      {
        id: "comp-greenhouse-nubank",
        name: "Nubank",
        ats: "GREENHOUSE",
        slug: "nubank",
        url: "https://boards.greenhouse.io/nubank",
        enabled: true,
        health_status: "HEALTHY",
        failure_count: 0,
        last_scraped_at: "2026-10-31T00:00:00.000Z",
      },
      {
        id: "comp-lever-picpay",
        name: "PicPay",
        ats: "LEVER",
        slug: "picpay",
        url: "https://jobs.lever.co/picpay",
        enabled: false,
        health_status: "BROKEN",
        failure_count: 4,
        last_scraped_at: null,
      },
    ];

    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify(remoteRows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const stats = await ConfigService.initializeHotCache({ persistToDisk: false });

    assert.equal(fetchCalls, 1);
    assert.equal(stats.source, "supabase");
    assert.equal(stats.totalCompanies, 3);
    assert.equal(stats.byAts.GUPY, 1);
    assert.equal(stats.byAts.GREENHOUSE, 1);
    assert.equal(stats.byAts.LEVER, 1);

    // Subsequent calls to getConfig() must hit RAM Hot Cache with zero network calls
    const cfg1 = ConfigService.getConfig();
    const cfg2 = ConfigService.getConfig();
    assert.equal(fetchCalls, 1);
    assert.strictEqual(cfg1, cfg2);
    assert.equal(cfg1.gupyCompanies[0].slug, "vemproitau");
    assert.equal(cfg1.leverCompanies?.[0].slug, "picpay");
    assert.equal(cfg1.leverCompanies?.[0].enabled, false);
    assert.equal(cfg1.leverCompanies?.[0].status, "broken_link");
    assert.equal(cfg1.leverCompanies?.[0].healthStatus, "BROKEN");
    assert.equal(cfg1.leverCompanies?.[0].failureCount, 4);
  });

  it("should update in-memory telemetry and trigger atomic PATCH to Supabase on recordCompanyScrapeOutcome", async () => {
    process.env.SUPABASE_URL = "https://mock.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-role-key";

    let patchUrl = "";
    let patchBody: Record<string, unknown> = {};

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      patchUrl = String(input);
      patchBody = init?.body ? JSON.parse(String(init.body)) : {};
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof globalThis.fetch;

    ConfigService.recordCompanyScrapeOutcome("GUPY", "cielo", {
      success: false,
      error: "HTTP 503",
      scrapedAt: "2026-10-31T02:00:00.000Z",
    });

    const cfg = ConfigService.getConfig();
    const cielo = cfg.gupyCompanies.find((c) => c.slug === "cielo");
    assert.ok(cielo);
    assert.equal(cielo.failureCount, 1);
    assert.equal(cielo.healthStatus, "WARNING");
    assert.equal(cielo.lastScrapedAt, "2026-10-31T02:00:00.000Z");

    assert.ok(patchUrl.includes("/rest/v1/companies?ats=eq.GUPY&slug=eq.cielo"));
    assert.equal(patchBody.health_status, "WARNING");
    assert.equal(patchBody.failure_count, 1);
    assert.equal(patchBody.last_scraped_at, "2026-10-31T02:00:00.000Z");
  });

  it("should support bidirectional CLI synchronization preserving remote telemetry", async () => {
    process.env.SUPABASE_URL = "https://mock.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-role-key";

    let upsertedRows: SupabaseCompanyRow[] = [];

    const existingRemoteRows: SupabaseCompanyRow[] = [
      {
        id: "comp-gupy-cielo",
        name: "Cielo",
        ats: "GUPY",
        slug: "cielo",
        url: "https://cielo.gupy.io",
        enabled: true,
        health_status: "WARNING",
        failure_count: 2,
        last_scraped_at: "2026-10-30T15:00:00.000Z",
      },
    ];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (init?.method === "POST" && urlStr.includes("on_conflict=ats,slug")) {
        upsertedRows = JSON.parse(String(init.body));
        return new Response(JSON.stringify(upsertedRows), { status: 201 });
      }
      // GET /rest/v1/companies
      return new Response(
        JSON.stringify(upsertedRows.length > 0 ? upsertedRows : existingRemoteRows),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const syncRes = await runCompaniesSync({
      direction: "bidirectional",
      dryRun: false,
      configPath: tmpConfigPath,
      batchSize: 50,
    });

    assert.equal(syncRes.localCount, 3);
    assert.equal(syncRes.pushedCount, 3);
    assert.equal(syncRes.pulledCount, 3);
    assert.equal(syncRes.failedBatches, 0);

    const cieloUpserted = upsertedRows.find((r) => r.slug === "cielo");
    assert.ok(cieloUpserted);
    assert.equal(cieloUpserted.health_status, "WARNING");
    assert.equal(cieloUpserted.failure_count, 2);
    assert.equal(cieloUpserted.last_scraped_at, "2026-10-30T15:00:00.000Z");
  });

  it("should validate SQL migration file for public.companies schema integrity", () => {
    const migrationPath = path.resolve(
      process.cwd(),
      "supabase/migrations/20261031000000_create_companies_table.sql",
    );
    assert.equal(fs.existsSync(migrationPath), true, "Migration SQL file must exist");

    const sql = fs.readFileSync(migrationPath, "utf-8");
    assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS public.companies"));
    assert.ok(sql.includes("health_status"));
    assert.ok(sql.includes("failure_count"));
    assert.ok(sql.includes("last_scraped_at"));
    assert.ok(sql.includes("UNIQUE (ats, slug)"));
    assert.ok(sql.includes("UNIQUE (url)"));
    assert.ok(sql.includes("ENABLE ROW LEVEL SECURITY"));
  });
});
