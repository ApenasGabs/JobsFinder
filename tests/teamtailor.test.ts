import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import { ScraperRegistry } from "../server/scrapers/base.js";
import {
  normalizeTeamtailorJob,
  parseTeamtailorRss,
  TeamtailorRawJob,
  TeamtailorScraper,
} from "../server/scrapers/teamtailor.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { ScraperHealthService } from "../server/services/scraper-health.js";
import { resilientFetch } from "../server/utils/fetch.js";

const mockTeamtailorJobs: TeamtailorRawJob[] = [
  {
    guid: "697291-backend-engineer",
    title: "Backend Engineer Mid - Node | TypeScript",
    description:
      "<p>Build scalable microservices with Node, TypeScript, PostgreSQL and AWS.</p>",
    link: "https://instaleap.na.teamtailor.com/jobs/697291-backend-engineer-mid-node-typescript",
    remoteStatus: "hybrid",
    department: "Engineering",
    role: "Engineering",
    locations: [{ city: "São Paulo", country: "Brazil" }],
  },
  {
    guid: "464847-senior-backend",
    title: "Senior Backend Engineer (Python / Go)",
    description: "<p>Remote engineering position working with Python, Go and Docker.</p>",
    link: "https://instaleap.na.teamtailor.com/jobs/464847-senior-backend-engineer",
    remoteStatus: "fully",
    department: "Engineering",
    locations: [{ city: "Remote", country: "Brazil" }],
  },
  {
    guid: "8584832-sdr",
    title: "Sales Development Representative Jr",
    description: "<p>Prospecção comercial ativa B2B.</p>",
    link: "https://edrone.teamtailor.com/jobs/8584832-sales-development-representative-jr",
    remoteStatus: "none",
    department: "Sales",
    locations: [{ city: "São José dos Campos", country: "Brazil" }],
  },
  {
    guid: "disabled-1",
    title: "Vaga Desativada",
    isDisabled: true,
  },
];

describe("Teamtailor Scraper & E2E Pipeline", () => {
  it("should have correct metadata and register in ScraperRegistry", () => {
    const scraper = new TeamtailorScraper();
    ScraperRegistry.register(scraper);

    assert.equal(scraper.id, "TEAMTAILOR");
    assert.equal(scraper.name, "Teamtailor (Loft & Global Tech)");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");
    assert.equal(ScraperRegistry.isRegistered("TEAMTAILOR"), true);
  });

  it("should parse Teamtailor RSS XML and normalize jobs with TechClassifierService", () => {
    const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:tt="https://teamtailor.com/locations">
        <channel>
          <title>Instaleap</title>
          <item>
            <title>Backend Engineer Mid - Node | TypeScript</title>
            <description>&lt;p&gt;Node and TypeScript backend role.&lt;/p&gt;</description>
            <link>https://instaleap.na.teamtailor.com/jobs/697291-backend-engineer-mid-node-typescript</link>
            <remoteStatus>hybrid</remoteStatus>
            <guid>697291</guid>
            <tt:locations>
              <tt:location>
                <tt:city>Bogotá</tt:city>
                <tt:country>Colombia</tt:country>
              </tt:location>
            </tt:locations>
            <tt:department>Engineering</tt:department>
          </item>
        </channel>
      </rss>`;

    const parsed = parseTeamtailorRss(sampleRss);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].title, "Backend Engineer Mid - Node | TypeScript");
    assert.equal(parsed[0].remoteStatus, "hybrid");
    assert.equal(parsed[0].department, "Engineering");
    assert.equal(parsed[0].locations?.[0]?.city, "Bogotá");

    const company = { name: "Instaleap", slug: "instaleap.na" };
    const normalized = mockTeamtailorJobs
      .map((j) => normalizeTeamtailorJob(j, company))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    assert.equal(normalized.length, 3);

    const midJob = normalized[0];
    assert.equal(midJob.title, "Backend Engineer Mid - Node | TypeScript");
    assert.equal(midJob.company, "Instaleap");
    assert.equal(midJob.location, "São Paulo, Brazil");
    assert.equal(midJob.workModel, "HIBRIDO");
    assert.equal(midJob.contractType, "CLT");
    assert.equal(midJob.seniorityLevel, "PLENO");
    assert.ok(midJob.stack.includes("Node"));
    assert.ok(midJob.stack.includes("TypeScript"));
    assert.ok(midJob.stack.includes("PostgreSQL"));
    assert.ok(midJob.stack.includes("AWS"));
    assert.equal(TechClassifierService.isTechSync(midJob.title), true);

    const seniorJob = normalized[1];
    assert.equal(seniorJob.workModel, "REMOTO");
    assert.equal(seniorJob.location, "Remoto");
    assert.equal(seniorJob.seniorityLevel, "SENIOR");
    assert.ok(seniorJob.stack.includes("Python"));
    assert.ok(seniorJob.stack.includes("Go"));
    assert.ok(seniorJob.stack.includes("Docker"));
    assert.equal(TechClassifierService.isTechSync(seniorJob.title), true);

    const salesJob = normalized[2];
    assert.equal(salesJob.workModel, "PRESENCIAL");
    assert.equal(TechClassifierService.isTechSync(salesJob.title), false);
  });

  it("should fetch real published vacancies from Teamtailor RSS feed and validate telemetry", async () => {
    const start = Date.now();
    const response = await resilientFetch(
      "https://loft.teamtailor.com/jobs.rss",
      {
        timeoutMs: 12000,
        maxRetries: 1,
        source: "TEAMTAILOR",
        headers: {
          Accept: "application/rss+xml, application/xml, text/xml, */*",
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        },
      },
    );
    const durationMs = Date.now() - start;

    assert.equal(response.ok, true);
    const xml = await response.text();
    const rawJobs = parseTeamtailorRss(xml);
    assert.ok(
      rawJobs.length > 0,
      `Esperava vagas ativas na Loft (Teamtailor), obteve ${rawJobs.length}`,
    );

    ScraperHealthService.recordStart(
      "TEAMTAILOR",
      "Teamtailor (Loft & Global Tech)",
    );
    ScraperHealthService.recordSuccess("TEAMTAILOR", rawJobs.length, durationMs);
    const healthReport = ScraperHealthService.getHealthReport(false);
    const ttHealth = healthReport.scrapers.sources.find(
      (s) => s.id === "TEAMTAILOR",
    );
    assert.ok(ttHealth, "TEAMTAILOR deve constar na telemetria de saúde");
    assert.equal(ttHealth.status, "HEALTHY");
    assert.equal(ttHealth.circuitBreakerOpen, false);
  });

  it("should format captured Teamtailor jobs in WhatsApp Digest composer", () => {
    const company = { name: "Loft", slug: "loft" };
    const jobs = mockTeamtailorJobs.slice(0, 2).map((v, idx) => {
      const n = normalizeTeamtailorJob(v, company)!;
      return {
        ...n,
        id: `teamtailor-test-${idx}`,
        scrapedAt: new Date().toISOString(),
        isTech: true,
      };
    });

    const digest = buildDigest(jobs, {
      title: "VAGAS PLENO E SÊNIOR",
      emoji: "🚀",
      radarUrl: "https://querovagas.apenasgabs.dev/",
      minJobs: 1,
    });

    assert.ok(
      digest,
      "Digest deve ser gerado com sucesso para vagas do Teamtailor",
    );
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("Loft"));
  });
});
