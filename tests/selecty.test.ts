import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import { ScraperRegistry } from "../server/scrapers/base.js";
import {
  normalizeSelectyJob,
  SelectyRawJob,
  SelectyScraper,
} from "../server/scrapers/selecty.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { ScraperHealthService } from "../server/services/scraper-health.js";
import { resilientFetch } from "../server/utils/fetch.js";

const mockSelectyJobs: SelectyRawJob[] = [
  {
    id: 1713,
    occupation: "Engenheiro de Dados Pleno",
    activities:
      "Construção e manutenção de pipelines de integração de dados; boas práticas de CI/CD.",
    requirements:
      "Proficiência em Python, SQL e AWS (S3, DMS, Lambda, RDS).",
    city: "São Paulo",
    state: "SP",
    workplace_type: "Híbrido",
    contract_type: "{\"CLT (Efetivo)\"}",
    interest_area: "Internet",
    slug: "vaga-para-engenheiro-de-dados-pleno-em-sao-paulo-sp",
    published: true,
  },
  {
    id: 65,
    occupation: "Desenvolvedor Backend Node.js Sênior",
    activities: "Desenvolvimento de microsserviços em Node, TypeScript e PostgreSQL.",
    requirements: "Experiência com Docker, Kubernetes e mensageria.",
    city: "Chapecó",
    state: "SC",
    workplace_type: "Remoto",
    contract_type: "{PJ}",
    interest_area: "Tecnologia",
    salary: "R$ 14.000,00",
    slug: "vaga-para-desenvolvedor-backend-node-senior",
    published: true,
  },
  {
    id: 90,
    occupation: "Auxiliar de Rouparia Hospitalar",
    activities: "Organização de enxoval hospitalar.",
    city: "Brasília",
    state: "DF",
    workplace_type: "Presencial",
    contract_type: "{\"CLT (Efetivo)\"}",
    published: true,
  },
  {
    id: 91,
    occupation: "Vaga Encerrada Teste",
    published: false,
    finished_date: "2026-10-01",
  },
];

describe("Selecty Scraper & E2E Pipeline", () => {
  it("should have correct metadata and register in ScraperRegistry", () => {
    const scraper = new SelectyScraper();
    ScraperRegistry.register(scraper);

    assert.equal(scraper.id, "SELECTY");
    assert.equal(scraper.name, "Selecty ATS (Brasil)");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");
    assert.equal(ScraperRegistry.isRegistered("SELECTY"), true);
  });

  it("should normalize Selecty jobs and filter with TechClassifierService", () => {
    const company = { name: "projeto22", slug: "projeto22" };
    const normalized = mockSelectyJobs
      .map((j) => normalizeSelectyJob(j, company))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    assert.equal(normalized.length, 3);

    const dataJob = normalized[0];
    assert.equal(dataJob.title, "Engenheiro de Dados Pleno");
    assert.equal(dataJob.company, "projeto22");
    assert.equal(dataJob.location, "São Paulo, SP");
    assert.equal(dataJob.workModel, "HIBRIDO");
    assert.equal(dataJob.contractType, "CLT");
    assert.equal(dataJob.seniorityLevel, "PLENO");
    assert.equal(
      dataJob.url,
      "https://projeto22.selecty.com.br/vaga/1713/vaga-para-engenheiro-de-dados-pleno-em-sao-paulo-sp",
    );
    assert.ok(dataJob.stack.includes("Python"));
    assert.ok(dataJob.stack.includes("SQL"));
    assert.ok(dataJob.stack.includes("AWS"));
    assert.ok(dataJob.stack.includes("CI/CD"));
    assert.equal(TechClassifierService.isTechSync(dataJob.title), true);

    const backendJob = normalized[1];
    assert.equal(backendJob.workModel, "REMOTO");
    assert.equal(backendJob.location, "Chapecó, SC");
    assert.equal(backendJob.contractType, "PJ");
    assert.equal(backendJob.seniorityLevel, "SENIOR");
    assert.equal(backendJob.salary, "R$ 14.000,00");
    assert.ok(backendJob.stack.includes("Node"));
    assert.ok(backendJob.stack.includes("TypeScript"));
    assert.ok(backendJob.stack.includes("PostgreSQL"));
    assert.ok(backendJob.stack.includes("Docker"));
    assert.ok(backendJob.stack.includes("Kubernetes"));
    assert.equal(TechClassifierService.isTechSync(backendJob.title), true);

    const nonTechJob = normalized[2];
    assert.equal(nonTechJob.workModel, "PRESENCIAL");
    assert.equal(TechClassifierService.isTechSync(nonTechJob.title), false);
  });

  it("should fetch real published vacancies from Selecty backend API and validate telemetry", async () => {
    const start = Date.now();
    const response = await resilientFetch(
      "https://amplimed.selecty.com.br/backend/vacancy",
      {
        method: "POST",
        timeoutMs: 12000,
        maxRetries: 1,
        source: "SELECTY",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ page: 1, limit: 50 }),
      },
    );
    const durationMs = Date.now() - start;

    assert.equal(response.ok, true);
    const payload = await response.json();
    const items = payload?.items || [];
    assert.ok(
      Array.isArray(items) && items.length > 0,
      `Esperava vagas ativas na Amplimed (Selecty), obteve ${items.length}`,
    );

    ScraperHealthService.recordStart("SELECTY", "Selecty ATS (Brasil)");
    ScraperHealthService.recordSuccess("SELECTY", items.length, durationMs);
    const healthReport = ScraperHealthService.getHealthReport(false);
    const selHealth = healthReport.scrapers.sources.find(
      (s) => s.id === "SELECTY",
    );
    assert.ok(selHealth, "SELECTY deve constar na telemetria de saúde");
    assert.equal(selHealth.status, "HEALTHY");
    assert.equal(selHealth.circuitBreakerOpen, false);
  });

  it("should format captured Selecty jobs in WhatsApp Digest composer", () => {
    const company = { name: "Amplimed", slug: "amplimed" };
    const jobs = mockSelectyJobs.slice(0, 2).map((v, idx) => {
      const n = normalizeSelectyJob(v, company)!;
      return {
        ...n,
        id: `selecty-test-${idx}`,
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
      "Digest deve ser gerado com sucesso para vagas da Selecty",
    );
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("Amplimed"));
  });
});
