import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import { ScraperRegistry } from "../server/scrapers/base.js";
import {
  normalizeTotvsJob,
  parseTotvsHtml,
  TotvsRawJob,
  TotvsScraper,
} from "../server/scrapers/totvs.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { ScraperHealthService } from "../server/services/scraper-health.js";
import { resilientFetch } from "../server/utils/fetch.js";

const mockTotvsJobs: TotvsRawJob[] = [
  {
    id: "d56a8151-b3d7-4766-8a08-086135a6e800",
    code: "65",
    title: "Pessoa Desenvolvedora Full Stack Pleno (Node &#x2B; React)",
    departmentName: "Tecnologia",
    positionName: "Full stack pleno",
    cityName: "S&#xE3;o Paulo",
    stateSmallName: "SP",
    pageUrl: "/starbem/job-opportunity/65",
    url: "https://atracaodetalentos.totvs.app/starbem/65/pessoa-desenvolvedora-full-stack-pleno",
    hideLocation: "False",
    remoteString: "Remoto",
  },
  {
    id: "6cb269fe-b787-4a11-ba57-7eb0ab20a42a",
    code: "12270",
    title: "Especialista Cloud &amp; DevOps (AWS / Kubernetes) - Remoto",
    departmentName: "PA - CLOUD - CPT PROTHEUS - SP 2",
    positionName: "ANALISTA III DE SERVI&#xC7;OS CLOUD",
    cityName: "",
    stateSmallName: "",
    pageUrl: "/vempratotvs/job-opportunity/12270",
    hideLocation: "True",
    remoteString: "Remoto",
  },
  {
    id: "b9575b2f-7800-46b1-8dbf-f18af3a30d5b",
    code: "12870",
    title: "Executivo Comercial de Contas",
    departmentName: "COMERCIAL VAREJO",
    positionName: "EXECUTIVO DE VENDAS",
    cityName: "Belo Horizonte",
    stateSmallName: "MG",
    pageUrl: "/vempratotvs/job-opportunity/12870",
    hideLocation: "False",
    remoteString: "Remoto",
  },
  {
    id: "00000000-0000-0000-0000-000000000000",
    code: "99999",
    title: "Vaga Desativada Teste",
    isDisabled: true,
  },
];

describe("TOTVS ATS Scraper & E2E Pipeline", () => {
  it("should have correct metadata and register in ScraperRegistry", () => {
    const scraper = new TotvsScraper();
    ScraperRegistry.register(scraper);

    assert.equal(scraper.id, "TOTVS");
    assert.equal(scraper.name, "TOTVS Atração de Talentos");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");
    assert.equal(ScraperRegistry.isRegistered("TOTVS"), true);
  });

  it("should parse TOTVS HTML and normalize jobs with TechClassifierService", () => {
    const sampleHtml = `
      <div class="index__job-opportunities__grid">
        <div class="index__job-opportunities__grid__item"
          data-id="d56a8151-b3d7-4766-8a08-086135a6e800"
          data-department-name="Tecnologia"
          data-position-name="Full stack pleno"
          data-city-name="S&#xE3;o Paulo"
          data-state-small-name="SP"
          data-title="Pessoa Desenvolvedora Full Stack Pleno (Node &#x2B; React)"
          data-code="65"
          data-page-url="/starbem/job-opportunity/65"
          data-hide-location="False"
          data-remote-string="Remoto">
          <div>
            <a class="ats-clickable index__job-opportunity-name"
               href="https://atracaodetalentos.totvs.app/starbem/65/pessoa-desenvolvedora-full-stack-pleno">
              Pessoa Desenvolvedora Full Stack Pleno (Node + React)
            </a>
          </div>
        </div>
      </div>
    `;
    const parsed = parseTotvsHtml(sampleHtml);
    assert.equal(parsed.length, 1);
    assert.equal(
      parsed[0].title,
      "Pessoa Desenvolvedora Full Stack Pleno (Node + React)",
    );
    assert.equal(parsed[0].cityName, "São Paulo");

    const company = { name: "Starbem", slug: "starbem" };
    const normalized = mockTotvsJobs
      .map((j) => normalizeTotvsJob(j, company))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    assert.equal(normalized.length, 3);

    const devJob = normalized[0];
    assert.equal(
      devJob.title,
      "Pessoa Desenvolvedora Full Stack Pleno (Node + React)",
    );
    assert.equal(devJob.company, "Starbem");
    assert.equal(devJob.location, "São Paulo, SP");
    assert.equal(devJob.workModel, "PRESENCIAL");
    assert.equal(devJob.contractType, "CLT");
    assert.equal(devJob.seniorityLevel, "PLENO");
    assert.equal(
      devJob.url,
      "https://atracaodetalentos.totvs.app/starbem/65/pessoa-desenvolvedora-full-stack-pleno",
    );
    assert.ok(devJob.stack.includes("Node"));
    assert.ok(devJob.stack.includes("React"));
    assert.equal(TechClassifierService.isTechSync(devJob.title), true);

    const cloudJob = normalized[1];
    assert.equal(cloudJob.workModel, "REMOTO");
    assert.equal(cloudJob.location, "Remoto");
    assert.equal(cloudJob.seniorityLevel, "ESPECIALISTA");
    assert.ok(cloudJob.stack.includes("AWS"));
    assert.ok(cloudJob.stack.includes("Kubernetes"));
    assert.ok(cloudJob.stack.includes("DevOps"));
    assert.equal(TechClassifierService.isTechSync(cloudJob.title), true);

    const salesJob = normalized[2];
    assert.equal(salesJob.location, "Belo Horizonte, MG");
    assert.equal(TechClassifierService.isTechSync(salesJob.title), false);
  });

  it("should fetch real published vacancies from TOTVS ATS portal and validate telemetry", async () => {
    const start = Date.now();
    const response = await resilientFetch(
      "https://atracaodetalentos.totvs.app/vempratotvs",
      {
        timeoutMs: 12000,
        maxRetries: 1,
        source: "TOTVS",
      },
    );
    const durationMs = Date.now() - start;

    assert.equal(response.ok, true);
    const html = await response.text();
    const rawJobs = parseTotvsHtml(html);
    assert.ok(
      rawJobs.length > 0,
      `Esperava vagas ativas em vempratotvs, obteve ${rawJobs.length}`,
    );

    ScraperHealthService.recordStart("TOTVS", "TOTVS Atração de Talentos");
    ScraperHealthService.recordSuccess("TOTVS", rawJobs.length, durationMs);
    const healthReport = ScraperHealthService.getHealthReport(false);
    const totvsHealth = healthReport.scrapers.sources.find(
      (s) => s.id === "TOTVS",
    );
    assert.ok(totvsHealth, "TOTVS deve constar na telemetria de saúde");
    assert.equal(totvsHealth.status, "HEALTHY");
    assert.equal(totvsHealth.circuitBreakerOpen, false);
  });

  it("should format captured TOTVS jobs in WhatsApp Digest composer", () => {
    const company = { name: "TOTVS", slug: "vempratotvs" };
    const jobs = mockTotvsJobs.slice(0, 2).map((v, idx) => {
      const n = normalizeTotvsJob(v, company)!;
      return {
        ...n,
        id: `totvs-test-${idx}`,
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

    assert.ok(digest, "Digest deve ser gerado com sucesso para vagas da TOTVS");
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("TOTVS"));
  });
});
