import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import { ScraperRegistry } from "../server/scrapers/base.js";
import {
  normalizeSolidesVacancy,
  SolidesRawVacancy,
  SolidesScraper,
} from "../server/scrapers/solides.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { CompanyAuditorService } from "../server/services/company-auditor.js";
import { ConfigService } from "../server/services/config.js";
import { CrawlerService } from "../server/services/crawler.js";
import { ScraperHealthService } from "../server/services/scraper-health.js";

const mockSolidesVacancies: SolidesRawVacancy[] = [
  {
    id: 935178,
    title: "Analista de Suporte Técnico Pleno",
    description:
      "<p>Atuação com suporte em ERP, banco de dados SQL e atendimento via Zendesk.</p>",
    currentState: "em_andamento",
    companyName: "ACOM Sistemas",
    slug: "acomsistemas",
    isHiddenJob: false,
    isDisabled: false,
    homeOffice: false,
    jobType: "hibrido",
    city: { name: "Curitiba" },
    state: { code: "PR", name: "Paraná" },
    seniority: [{ id: 5, name: "Pleno" }],
    recruitmentContractType: [{ id: 10, name: "CLT" }],
    hardSkills: [{ id: 1, name: "SQL" }],
  },
  {
    id: 935999,
    title: "Pessoa Desenvolvedora Fullstack Sênior (React / Node.js) - Remoto",
    description: "<p>Desenvolvimento com TypeScript, React, Node e AWS.</p>",
    currentState: "em_andamento",
    companyName: "ACOM Sistemas",
    slug: "acomsistemas",
    isHiddenJob: false,
    isDisabled: false,
    homeOffice: true,
    jobType: "remoto",
    seniority: [{ id: 6, name: "Sênior" }],
    recruitmentContractType: [{ id: 11, name: "PJ" }],
    hardSkills: [
      { id: 2, name: "React" },
      { id: 3, name: "Node" },
      { id: 4, name: "TypeScript" },
    ],
  },
  {
    id: 936000,
    title: "Vendedor Externo de Loja",
    description: "<p>Vendas presenciais no varejo.</p>",
    currentState: "em_andamento",
    companyName: "ACOM Sistemas",
    slug: "acomsistemas",
    isHiddenJob: false,
    isDisabled: false,
    homeOffice: false,
    jobType: "presencial",
    city: { name: "Curitiba" },
    state: { code: "PR" },
  },
  {
    id: 936001,
    title: "Vaga Oculta Desativada",
    currentState: "encerrada",
    isHiddenJob: true,
    isDisabled: true,
  },
];

describe("Sólides Scraper & E2E Pipeline", () => {
  it("should have correct metadata, registration, and 91 configured companies", () => {
    CrawlerService.initialize();
    const scraper = new SolidesScraper();
    assert.equal(scraper.id, "SOLIDES");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");
    assert.equal(ScraperRegistry.isRegistered("SOLIDES"), true);

    const config = ConfigService.getConfig();
    assert.ok(Array.isArray(config.solidesCompanies));
    assert.equal(config.solidesCompanies.length, 91);

    // Verifica que Vetta e Evolux foram adicionadas na Gupy conforme especificação
    const gupySlugs = new Set(
      (config.gupyCompanies || []).map((c) => c.slug.toLowerCase()),
    );
    assert.ok(gupySlugs.has("vetta"), "Vetta deve estar em gupyCompanies");
    assert.ok(gupySlugs.has("evolux"), "Evolux deve estar em gupyCompanies");
  });

  it("should normalize Sólides jobs and filter with TechClassifierService", () => {
    const company = { name: "ACOM Sistemas", slug: "acomsistemas" };
    const normalized = mockSolidesVacancies
      .map((v) => normalizeSolidesVacancy(v, company))
      .filter((v): v is NonNullable<typeof v> => v !== null);

    // A vaga oculta/encerrada deve ser descartada
    assert.equal(normalized.length, 3);

    const supportJob = normalized[0];
    assert.equal(supportJob.title, "Analista de Suporte Técnico Pleno");
    assert.equal(supportJob.company, "ACOM Sistemas");
    assert.equal(supportJob.location, "Curitiba, PR");
    assert.equal(supportJob.workModel, "HIBRIDO");
    assert.equal(supportJob.contractType, "CLT");
    assert.equal(supportJob.seniorityLevel, "PLENO");
    assert.equal(
      supportJob.url,
      "https://acomsistemas.vagas.solides.com.br/vaga/935178",
    );
    assert.ok(supportJob.stack.includes("SQL"));
    assert.equal(TechClassifierService.isTechSync(supportJob as any), true);

    const devJob = normalized[1];
    assert.equal(devJob.workModel, "REMOTO");
    assert.equal(devJob.contractType, "PJ");
    assert.equal(devJob.seniorityLevel, "SENIOR");
    assert.ok(devJob.stack.includes("React"));
    assert.ok(devJob.stack.includes("Node"));
    assert.ok(devJob.stack.includes("TypeScript"));
    assert.equal(TechClassifierService.isTechSync(devJob.title), true);

    const nonTechJob = normalized[2];
    assert.equal(TechClassifierService.isTechSync(nonTechJob.title), false);
  });

  it("should fetch real published vacancies from Sólides public API and validate auditor/telemetry", async () => {
    const verifyRes = await CompanyAuditorService.verifySingle(
      "SOLIDES",
      "acomsistemas",
    );
    assert.equal(verifyRes.ok, true);
    assert.equal(verifyRes.httpStatus, 200);
    assert.ok(
      typeof verifyRes.jobsCount === "number" && verifyRes.jobsCount >= 0,
    );

    // Verifica telemetria em ScraperHealthService (/api/scrapers/health)
    ScraperHealthService.recordStart("SOLIDES", "Sólides");
    ScraperHealthService.recordSuccess(
      "SOLIDES",
      verifyRes.jobsCount || 2,
      verifyRes.durationMs,
    );
    const healthReport = ScraperHealthService.getHealthReport(false);
    const solidesHealth = healthReport.scrapers.sources.find(
      (s) => s.id === "SOLIDES",
    );
    assert.ok(solidesHealth, "SOLIDES deve constar na telemetria de saúde");
    assert.equal(solidesHealth.status, "HEALTHY");
    assert.equal(solidesHealth.circuitBreakerOpen, false);
    assert.ok(
      healthReport.memoryUsageMB.heapUsed < 512,
      "Uso de memória deve permanecer saudável sem vazamentos",
    );
  });

  it("should format captured Sólides jobs in WhatsApp Digest composer", () => {
    const company = { name: "ACOM Sistemas", slug: "acomsistemas" };
    const jobs = mockSolidesVacancies
      .slice(0, 2)
      .map((v, idx) => {
        const n = normalizeSolidesVacancy(v, company)!;
        return {
          ...n,
          id: `solides-test-${idx}`,
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

    assert.ok(digest, "Digest deve ser gerado com sucesso para vagas da Sólides");
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("ACOM Sistemas"));
    assert.ok(
      digest.text.includes(
        "https://acomsistemas.vagas.solides.com.br/vaga/935178",
      ),
    );
  });
});
