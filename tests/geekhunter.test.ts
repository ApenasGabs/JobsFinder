import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GeekHunterScraper } from "../server/scrapers/geekhunter.js";
import { ScraperRegistry } from "../server/scrapers/base.js";
import { CrawlerService } from "../server/services/crawler.js";
import { ScraperHealthService } from "../server/services/scraper-health.js";

describe("GeekHunter Scraper & E2E Pipeline", () => {
  it("should have correct metadata and register in ScraperRegistry", () => {
    CrawlerService.initialize();
    const scraper = new GeekHunterScraper();
    assert.equal(scraper.id, "GEEKHUNTER");
    assert.equal(scraper.name, "GeekHunter");
    assert.equal(scraper.type, "CLT");
    assert.equal(scraper.isFastMode, true);
    assert.equal(ScraperRegistry.isRegistered("GEEKHUNTER"), true);
  });

  it("should fetch real published vacancies live from GeekHunter and validate telemetry", async () => {
    const scraper = new GeekHunterScraper();
    const jobs = await scraper.scrape({ keywords: [] }, () => {});

    assert.ok(Array.isArray(jobs), "Jobs deve ser um array");
    assert.ok(jobs.length > 0, "Deve capturar ao menos 1 vaga no GeekHunter");

    const firstJob = jobs[0];
    assert.equal(firstJob.source, "GEEKHUNTER");
    assert.equal(firstJob.contractType, "CLT");
    assert.ok(firstJob.url.includes("geekhunter.com"));
    assert.ok(firstJob.title.length > 3);

    // Verifica telemetria de saúde
    ScraperHealthService.recordStart("GEEKHUNTER", "GeekHunter");
    ScraperHealthService.recordSuccess("GEEKHUNTER", jobs.length, 500);

    const report = ScraperHealthService.getHealthReport(false);
    const health = report.scrapers.sources.find((s) => s.id === "GEEKHUNTER");
    assert.ok(health, "GEEKHUNTER deve constar em ScraperHealthService");
    assert.equal(health.status, "HEALTHY");
    assert.equal(health.consecutiveZeroRuns, 0);
  });
});
