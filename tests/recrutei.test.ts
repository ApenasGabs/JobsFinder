import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import { ScraperRegistry } from "../server/scrapers/base.js";
import {
  normalizeRecruteiJob,
  RecruteiRawJob,
  RecruteiScraper,
} from "../server/scrapers/recrutei.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { ScraperHealthService } from "../server/services/scraper-health.js";
import { resilientFetch } from "../server/utils/fetch.js";

const mockRecruteiJobs: RecruteiRawJob[] = [
  {
    id: 137563,
    title: "Analista de Infraestrutura - Linux Sênior (PJ ou CLT)",
    regime: "Pessoa Jurídica",
    department: "Infraestrutura",
    company_name: "Singularis RH",
    salary: "R$ 9.500,00 p/ Mês",
    show_remuneration: 1,
    location: ["Blumenau", "SC", "Brasil"],
    public_link:
      "https://jobs.recrutei.com.br/singularis-rh/vacancy/137563-analista-de-infraestrutura-linux-senior-pj-ou-clt",
    slug: "analista-de-infraestrutura-linux-senior-pj-ou-clt",
    description: "Administração de servidores Linux, Docker, AWS e CI/CD.",
  },
  {
    id: 162558,
    title: "Desenvolvedor Full Stack Pleno (React / Node) - Remoto",
    regime: "CLT",
    department: "Desenvolvimento",
    company_name: "InCicle",
    salary: "A combinar",
    show_remuneration: 0,
    location: ["Remoto"],
    public_link:
      "https://jobs.recrutei.com.br/incicle-sistemas/vacancy/162558-desenvolvedor-full-stack-pleno",
    slug: "desenvolvedor-full-stack-pleno",
    description: "Desenvolvimento web com React, Node e TypeScript.",
  },
  {
    id: 155341,
    title: "Analista de Recursos Humanos",
    regime: "CLT",
    department: "Recursos Humanos",
    company_name: "INCICLE SISTEMAS",
    salary: "A combinar",
    show_remuneration: 0,
    location: ["São José dos Campos", "SP", "Brasil"],
    public_link:
      "https://jobs.recrutei.com.br/incicle-sistemas/vacancy/155341-analista-de-recursos-humanos",
    slug: "analista-de-recursos-humanos",
  },
  {
    id: 999999,
    title: "Vaga Desativada",
    isDisabled: true,
  },
];

describe("Recrutei Scraper & E2E Pipeline", () => {
  it("should have correct metadata and register in ScraperRegistry", () => {
    const scraper = new RecruteiScraper();
    ScraperRegistry.register(scraper);

    assert.equal(scraper.id, "RECRUTEI");
    assert.equal(scraper.name, "Recrutei ATS (Brasil)");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");
    assert.equal(ScraperRegistry.isRegistered("RECRUTEI"), true);
  });

  it("should normalize Recrutei jobs and filter with TechClassifierService", () => {
    const company = { name: "Singularis RH", slug: "singularis-rh" };
    const normalized = mockRecruteiJobs
      .map((j) => normalizeRecruteiJob(j, company))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    assert.equal(normalized.length, 3);

    const infraJob = normalized[0];
    assert.equal(
      infraJob.title,
      "Analista de Infraestrutura - Linux Sênior (PJ ou CLT)",
    );
    assert.equal(infraJob.company, "Singularis RH");
    assert.equal(infraJob.location, "Blumenau, SC");
    assert.equal(infraJob.workModel, "PRESENCIAL");
    assert.equal(infraJob.contractType, "PJ");
    assert.equal(infraJob.seniorityLevel, "SENIOR");
    assert.equal(infraJob.salary, "R$ 9.500,00 p/ Mês");
    assert.ok(infraJob.stack.includes("Docker"));
    assert.ok(infraJob.stack.includes("AWS"));
    assert.ok(infraJob.stack.includes("CI/CD"));
    assert.equal(TechClassifierService.isTechSync(infraJob as any), true);

    const devJob = normalized[1];
    assert.equal(devJob.workModel, "REMOTO");
    assert.equal(devJob.location, "Remoto");
    assert.equal(devJob.contractType, "CLT");
    assert.equal(devJob.seniorityLevel, "PLENO");
    assert.equal(devJob.salary, undefined);
    assert.ok(devJob.stack.includes("React"));
    assert.ok(devJob.stack.includes("Node"));
    assert.ok(devJob.stack.includes("TypeScript"));
    assert.equal(TechClassifierService.isTechSync(devJob.title), true);

    const hrJob = normalized[2];
    assert.equal(hrJob.location, "São José dos Campos, SP");
    assert.equal(TechClassifierService.isTechSync(hrJob.title), false);
  });

  it("should fetch real published vacancies from Recrutei v2 API and validate telemetry", async () => {
    const start = Date.now();
    const response = await resilientFetch(
      "https://api.recrutei.com.br/api/v2/vacancies/per-departments/singularis-rh",
      {
        method: "POST",
        timeoutMs: 12000,
        maxRetries: 1,
        source: "RECRUTEI",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    const durationMs = Date.now() - start;

    assert.equal(response.ok, true);
    const payload = await response.json();
    const groups = payload?.data?.vacancies || [];
    assert.ok(
      Array.isArray(groups) && groups.length > 0,
      `Esperava grupos de vagas ativas na Singularis RH (Recrutei), obteve ${groups.length}`,
    );

    ScraperHealthService.recordStart("RECRUTEI", "Recrutei ATS (Brasil)");
    ScraperHealthService.recordSuccess("RECRUTEI", groups.length, durationMs);
    const healthReport = ScraperHealthService.getHealthReport(false);
    const recHealth = healthReport.scrapers.sources.find(
      (s) => s.id === "RECRUTEI",
    );
    assert.ok(recHealth, "RECRUTEI deve constar na telemetria de saúde");
    assert.equal(recHealth.status, "HEALTHY");
    assert.equal(recHealth.circuitBreakerOpen, false);
  });

  it("should format captured Recrutei jobs in WhatsApp Digest composer", () => {
    const company = { name: "Singularis RH", slug: "singularis-rh" };
    const jobs = mockRecruteiJobs.slice(0, 2).map((v, idx) => {
      const n = normalizeRecruteiJob(v, company)!;
      return {
        ...n,
        id: `recrutei-test-${idx}`,
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
      "Digest deve ser gerado com sucesso para vagas da Recrutei",
    );
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("Singularis RH"));
  });
});
