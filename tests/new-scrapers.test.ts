import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SolidesScraper } from "../server/scrapers/solides.js";
import { WorkdayScraper } from "../server/scrapers/workday.js";
import { QuickinScraper } from "../server/scrapers/quickin.js";
import { CustomSiteScraper } from "../server/scrapers/custom-site.js";
import { LinkedInJobsScraper } from "../server/scrapers/linkedin-jobs.js";
import { ScraperRegistry } from "../server/scrapers/base.js";
import { CrawlerService } from "../server/services/crawler.js";

describe("New Scrapers Suite (Solides, Workday, Quickin, Custom Site, LinkedIn)", () => {
  it("should initialize Solides scraper with proper metadata", () => {
    const scraper = new SolidesScraper();
    assert.equal(scraper.id, "SOLIDES");
    assert.equal(scraper.type, "CLT");
    assert.equal(scraper.isFastMode, true);
    assert.ok(scraper.name.includes("Solides"));
  });

  it("should initialize Workday scraper with proper metadata", () => {
    const scraper = new WorkdayScraper();
    assert.equal(scraper.id, "WORKDAY");
    assert.equal(scraper.type, "CLT");
    assert.equal(scraper.isFastMode, true);
    assert.ok(scraper.name.includes("Workday"));
  });

  it("should initialize Quickin scraper with proper metadata", () => {
    const scraper = new QuickinScraper();
    assert.equal(scraper.id, "QUICKIN");
    assert.equal(scraper.type, "CLT");
    assert.equal(scraper.isFastMode, true);
    assert.ok(scraper.name.includes("Quickin"));
  });

  it("should initialize Custom Site scraper with proper metadata", () => {
    const scraper = new CustomSiteScraper();
    assert.equal(scraper.id, "CUSTOM_SITE");
    assert.equal(scraper.type, "ALL");
    assert.equal(scraper.isFastMode, false);
  });

  it("should initialize LinkedIn Jobs scraper with proper metadata", () => {
    const scraper = new LinkedInJobsScraper();
    assert.equal(scraper.id, "LINKEDIN");
    assert.equal(scraper.type, "ALL");
    assert.equal(scraper.isFastMode, true);
    assert.ok(scraper.name.includes("LinkedIn"));
  });

  it("should register all 15 scrapers in ScraperRegistry via CrawlerService", () => {
    CrawlerService.initialize();
    assert.ok(ScraperRegistry.isRegistered("SOLIDES"));
    assert.ok(ScraperRegistry.isRegistered("WORKDAY"));
    assert.ok(ScraperRegistry.isRegistered("QUICKIN"));
    assert.ok(ScraperRegistry.isRegistered("CUSTOM_SITE"));
    assert.ok(ScraperRegistry.isRegistered("LINKEDIN"));
    assert.ok(ScraperRegistry.isRegistered("GUPY"));
    assert.ok(ScraperRegistry.isRegistered("INHIRE"));
    assert.ok(ScraperRegistry.isRegistered("GREENHOUSE"));
    assert.ok(ScraperRegistry.isRegistered("LEVER"));
    assert.ok(ScraperRegistry.isRegistered("ASHBY"));
  });
});
