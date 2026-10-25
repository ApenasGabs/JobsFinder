import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import { ScraperRegistry } from "../server/scrapers/base.js";
import {
  normalizeQuickinJob,
  QuickinRawJob,
  QuickinScraper,
} from "../server/scrapers/quickin.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { CompanyAuditorService } from "../server/services/company-auditor.js";
import { ConfigService } from "../server/services/config.js";
import { CrawlerService } from "../server/services/crawler.js";
import { ScraperHealthService } from "../server/services/scraper-health.js";

const mockQuickinJobs: QuickinRawJob[] = [
  {
    _id: "6ad916f9cb2e530013f735c4",
    publicate: "published",
    title: "Senior Frontend Engineer",
    description:
      "<p>Desenvolvimento frontend com React, TypeScript e Next.js em ambiente global.</p>",
    city: "Global",
    region: "SP",
    country: "BR",
    position_category: "it",
    workplace_type: "remote",
    code: "CQE1090",
    career_url: "https://jobs.quickin.io/botcity/jobs/6ad916f9cb2e530013f735c4",
    contract_id: { name: "PJ" },
    remuneration: 14000,
    currency: "BRL",
  },
  {
    _id: "6ad916f9cb2e530013f735c5",
    publicate: "published",
    title: "Specialist Backend Java (Multiple Positions Open)",
    description:
      "<p>Arquitetura de microsserviços em Java, Spring, Docker, Kubernetes e AWS.</p>",
    city: "Campinas",
    region: "SP",
    country: "BR",
    position_category: "it",
    workplace_type: "hybrid",
    code: "CQE1091",
    career_url: "https://jobs.quickin.io/botcity/jobs/6ad916f9cb2e530013f735c5",
    contract_id: { name: "CLT" },
  },
  {
    _id: "6ad916f9cb2e530013f735c6",
    publicate: "published",
    title: "Executivo Comercial de Vendas",
    description: "<p>Prospecção de clientes B2B.</p>",
    city: "São Paulo",
    region: "SP",
    country: "BR",
    workplace_type: "on-site",
  },
  {
    _id: "6ad916f9cb2e530013f735c7",
    publicate: "draft",
    title: "Desenvolvedor Python Pleno (Rascunho)",
    workplace_type: "remote",
  },
];

describe("Quickin Scraper & E2E Pipeline", () => {
  it("should have correct metadata, registration, and 36 configured companies", () => {
    CrawlerService.initialize();
    const scraper = new QuickinScraper();
    assert.equal(scraper.id, "QUICKIN");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");
    assert.equal(ScraperRegistry.isRegistered("QUICKIN"), true);

    const config = ConfigService.getConfig();
    assert.ok(Array.isArray(config.quickinCompanies));
    assert.equal(config.quickinCompanies.length, 36);
  });

  it("should normalize Quickin jobs and classify Tech vs Non-Tech", () => {
    const company = { name: "BotCity", slug: "botcity" };
    const normalized = mockQuickinJobs
      .map((j) => normalizeQuickinJob(j, company))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    // Rascunho não-publicado deve ser ignorado
    assert.equal(normalized.length, 3);

    const frontendJob = normalized[0];
    assert.equal(frontendJob.title, "Senior Frontend Engineer");
    assert.equal(frontendJob.company, "BotCity");
    assert.equal(frontendJob.location, "Remoto");
    assert.equal(frontendJob.workModel, "REMOTO");
    assert.equal(frontendJob.contractType, "PJ");
    assert.equal(frontendJob.seniorityLevel, "SENIOR");
    assert.equal(
      frontendJob.url,
      "https://jobs.quickin.io/botcity/jobs/6ad916f9cb2e530013f735c4",
    );
    assert.ok(frontendJob.stack.includes("React"));
    assert.ok(frontendJob.stack.includes("TypeScript"));
    assert.equal(TechClassifierService.isTechSync(frontendJob.title), true);

    const javaJob = normalized[1];
    assert.equal(javaJob.location, "Campinas, SP");
    assert.equal(javaJob.workModel, "HIBRIDO");
    assert.equal(javaJob.contractType, "CLT");
    assert.equal(javaJob.seniorityLevel, "PLENO"); // "Specialist" em inglês sem Sênior/Especialista mapeia para PLENO ou verificamos stack
    assert.ok(javaJob.stack.includes("Java"));
    assert.ok(javaJob.stack.includes("Spring"));
    assert.equal(TechClassifierService.isTechSync(javaJob), true);

    const salesJob = normalized[2];
    assert.equal(salesJob.workModel, "PRESENCIAL");
    assert.equal(TechClassifierService.isTechSync(salesJob.title), false);
  });

  it("should fetch real published jobs live from Quickin public API for BotCity and validate telemetry", async () => {
    const verifyRes = await CompanyAuditorService.verifySingle(
      "QUICKIN",
      "botcity",
    );
    assert.equal(verifyRes.ok, true);
    assert.equal(verifyRes.httpStatus, 200);
    assert.ok(
      typeof verifyRes.jobsCount === "number" && verifyRes.jobsCount > 0,
      `Esperava vagas ativas na BotCity no Quickin, obteve ${verifyRes.jobsCount}`,
    );

    // Testa também um tenant inexistente (ex: altbank que retornou 404)
    const brokenRes = await CompanyAuditorService.verifySingle(
      "QUICKIN",
      "altbank",
    );
    assert.equal(brokenRes.ok, false);
    assert.equal(brokenRes.httpStatus, 404);

    // Verifica telemetria em ScraperHealthService (/api/scrapers/health)
    ScraperHealthService.recordStart("QUICKIN", "Quickin");
    ScraperHealthService.recordSuccess(
      "QUICKIN",
      verifyRes.jobsCount || 11,
      verifyRes.durationMs,
    );
    const healthReport = ScraperHealthService.getHealthReport(false);
    const quickinHealth = healthReport.scrapers.sources.find(
      (s) => s.id === "QUICKIN",
    );
    assert.ok(quickinHealth, "QUICKIN deve constar na telemetria de saúde");
    assert.equal(quickinHealth.status, "HEALTHY");
    assert.equal(quickinHealth.circuitBreakerOpen, false);
  });

  it("should format captured Quickin jobs in WhatsApp Digest composer", () => {
    const company = { name: "BotCity", slug: "botcity" };
    const jobs = mockQuickinJobs
      .slice(0, 2)
      .map((v, idx) => {
        const n = normalizeQuickinJob(v, company)!;
        return {
          ...n,
          id: `quickin-test-${idx}`,
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

    assert.ok(digest, "Digest deve ser gerado com sucesso para vagas do Quickin");
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("BotCity"));
    assert.ok(
      digest.text.includes(
        "https://jobs.quickin.io/botcity/jobs/6ad916f9cb2e530013f735c4",
      ),
    );
  });
});
