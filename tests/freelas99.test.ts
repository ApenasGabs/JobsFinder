import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Freelas99Scraper } from "../server/scrapers/freelas99.js";
import { ScraperRegistry } from "../server/scrapers/base.js";
import { CrawlerService } from "../server/services/crawler.js";
import { ScraperHealthService } from "../server/services/scraper-health.js";

describe("99Freelas Scraper & E2E Pipeline", () => {
  it("should have correct metadata and register in ScraperRegistry", () => {
    CrawlerService.initialize();
    const scraper = new Freelas99Scraper();
    assert.equal(scraper.id, "FREELAS_99");
    assert.equal(scraper.name, "99Freelas");
    assert.equal(scraper.type, "FREELANCE");
    assert.equal(scraper.isFastMode, true);
    assert.equal(ScraperRegistry.isRegistered("FREELAS_99"), true);
  });

  it("should fetch real published projects live from 99Freelas /projects and validate telemetry", async () => {
    const scraper = new Freelas99Scraper();
    const jobs = await scraper.scrape({ keywords: ["programacao"] }, () => {});

    assert.ok(Array.isArray(jobs), "Jobs deve ser um array");
    assert.ok(jobs.length > 0, "Deve capturar ao menos 1 projeto no 99Freelas");

    const firstJob = jobs[0];
    assert.equal(firstJob.source, "FREELAS_99");
    assert.equal(firstJob.contractType, "FREELANCER");
    assert.equal(firstJob.workModel, "REMOTO");
    assert.ok(firstJob.url.includes("99freelas.com.br/project/"));
    assert.ok(firstJob.title.includes("[Projeto Freelance]"));

    // Verifica telemetria de saúde
    ScraperHealthService.recordStart("FREELAS_99", "99Freelas");
    ScraperHealthService.recordSuccess("FREELAS_99", jobs.length, 500);

    const report = ScraperHealthService.getHealthReport(false);
    const health = report.scrapers.sources.find((s) => s.id === "FREELAS_99");
    assert.ok(health, "FREELAS_99 deve constar em ScraperHealthService");
    assert.equal(health.status, "HEALTHY");
    assert.equal(health.consecutiveZeroRuns, 0);
  });
});
