import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import { ScraperRegistry } from "../server/scrapers/base.js";
import {
  normalizeSmartRecruitersJob,
  parseCiandtPortalHtml,
  SmartRecruitersRawJob,
  SmartRecruitersScraper,
} from "../server/scrapers/smartrecruiters.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { CompanyAuditorService } from "../server/services/company-auditor.js";
import { ConfigService } from "../server/services/config.js";
import { CrawlerService } from "../server/services/crawler.js";
import { ScraperHealthService } from "../server/services/scraper-health.js";

const mockSmartRecruitersJobs: SmartRecruitersRawJob[] = [
  {
    id: "744000045612345",
    name: "Senior Software Engineer (React / Node.js)",
    company: { name: "CI&T", identifier: "CIAndT" },
    releasedDate: "2026-10-20T10:00:00.000Z",
    location: {
      city: "Campinas",
      region: "SP",
      country: "br",
      remote: false,
      hybrid: true,
      fullLocation: "Campinas, SP, Brazil",
    },
    department: { label: "Engineering" },
    typeOfEmployment: { label: "Permanent" },
    experienceLevel: { label: "Mid-Senior level" },
  },
  {
    id: "744000045612346",
    name: "Staff Backend Engineer - Golang & Distributed Systems (Remoto)",
    company: { name: "CI&T", identifier: "CIAndT" },
    location: {
      city: "São Paulo",
      region: "SP",
      country: "br",
      remote: true,
      fullLocation: "São Paulo, SP, Brazil",
    },
    department: { label: "Technology" },
    typeOfEmployment: { label: "Contract" },
    experienceLevel: { label: "Associate" },
  },
  {
    id: "744000045612347",
    name: "Gerente de Vendas Corporativas B2B",
    company: { name: "CI&T", identifier: "CIAndT" },
    location: {
      city: "Belo Horizonte",
      region: "MG",
      remote: false,
      fullLocation: "Belo Horizonte, MG, Brazil",
    },
    department: { label: "Sales & Marketing" },
    typeOfEmployment: { label: "Permanent" },
  },
];

describe("SmartRecruiters Scraper & E2E Pipeline", () => {
  it("should have correct metadata, registration, and configured companies", () => {
    CrawlerService.initialize();
    const scraper = new SmartRecruitersScraper();
    assert.equal(scraper.id, "SMARTRECRUITERS");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");
    assert.equal(ScraperRegistry.isRegistered("SMARTRECRUITERS"), true);

    const config = ConfigService.getConfig();
    assert.ok(Array.isArray(config.smartrecruitersCompanies));
    assert.ok(
      config.smartrecruitersCompanies.length >= 8,
      "SmartRecruiters deve conter no mínimo 8 empresas configuradas",
    );
  });

  it("should normalize SmartRecruiters postings and filter with TechClassifierService", () => {
    const company = { name: "CI&T", slug: "CIAndT" };
    const normalized = mockSmartRecruitersJobs
      .map((j) => normalizeSmartRecruitersJob(j, company))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    assert.equal(normalized.length, 3);

    const seniorJob = normalized[0];
    assert.equal(seniorJob.title, "Senior Software Engineer (React / Node.js)");
    assert.equal(seniorJob.company, "CI&T");
    assert.equal(seniorJob.location, "Campinas, SP, Brazil");
    assert.equal(seniorJob.workModel, "HIBRIDO");
    assert.equal(seniorJob.contractType, "CLT");
    assert.equal(seniorJob.seniorityLevel, "SENIOR");
    assert.equal(
      seniorJob.url,
      "https://jobs.smartrecruiters.com/CIAndT/744000045612345",
    );
    assert.ok(seniorJob.stack.includes("React"));
    assert.ok(seniorJob.stack.includes("Node"));
    assert.equal(TechClassifierService.isTechSync(seniorJob.title), true);

    const backendJob = normalized[1];
    assert.equal(backendJob.workModel, "REMOTO");
    assert.equal(backendJob.location, "São Paulo, SP, Brazil");
    assert.equal(backendJob.seniorityLevel, "ESPECIALISTA");
    assert.ok(backendJob.stack.includes("Golang"));
    assert.equal(TechClassifierService.isTechSync(backendJob.title), true);

    const salesJob = normalized[2];
    assert.equal(salesJob.workModel, "NAO_INFORMADO");
    assert.equal(TechClassifierService.isTechSync(salesJob.title), false);
  });

  it("should fetch real published vacancies from SmartRecruiters public API and validate auditor/telemetry", async () => {
    const verifyRes = await CompanyAuditorService.verifySingle(
      "SMARTRECRUITERS",
      "CIAndT",
    );
    assert.equal(verifyRes.ok, true);
    assert.equal(verifyRes.httpStatus, 200);
    assert.ok(
      typeof verifyRes.jobsCount === "number" && verifyRes.jobsCount >= 0,
    );

    // Telemetria em ScraperHealthService (/api/scrapers/health)
    ScraperHealthService.recordStart("SMARTRECRUITERS", "SmartRecruiters");
    ScraperHealthService.recordSuccess(
      "SMARTRECRUITERS",
      verifyRes.jobsCount || 10,
      verifyRes.durationMs,
    );
    const healthReport = ScraperHealthService.getHealthReport(false);
    const srHealth = healthReport.scrapers.sources.find(
      (s) => s.id === "SMARTRECRUITERS",
    );
    assert.ok(srHealth, "SMARTRECRUITERS deve constar na telemetria de saúde");
    assert.equal(srHealth.status, "HEALTHY");
    assert.equal(srHealth.circuitBreakerOpen, false);
  });

  it("should format captured SmartRecruiters jobs in WhatsApp Digest composer", () => {
    const company = { name: "CI&T", slug: "CIAndT" };
    const jobs = mockSmartRecruitersJobs.slice(0, 2).map((v, idx) => {
      const n = normalizeSmartRecruitersJob(v, company)!;
      return {
        ...n,
        id: `sr-test-${idx}`,
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
      "Digest deve ser gerado com sucesso para vagas do SmartRecruiters",
    );
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("CI&T"));
    assert.ok(
      digest.text.includes(
        "https://jobs.smartrecruiters.com/CIAndT/744000045612345",
      ),
    );
  });

  it("should parse CI&T career portal SSR HTML cards correctly", () => {
    const mockHtml = `
      <div class="opportunities-list">
        <div class="opprtunity-item">
          <h2>Engenheiro(a) de Software Sênior (Java / Cloud)</h2>
          <span class="short-text-caption">Campinas, SP, Brasil</span>
          <div class="filters-item">Workplace_type_Remote Pa[í]s_Brazil Tecnologia</div>
          <a href="/br/pt-br/carreiras/oportunidades/candidate-se?opportunity=abcd-1234-uuid">Candidatar-se</a>
        </div>
        <div class="opprtunity-item">
          <h2>Arquiteto de Soluções Cloud</h2>
          <span class="short-text-caption">São Paulo, SP</span>
          <div class="filters-item">Workplace_type_Hybrid Pa[í]s_Brazil</div>
          <a href="/br/pt-br/carreiras/oportunidades/candidate-se?opportunity=efgh-5678-uuid">Candidatar-se</a>
        </div>
      </div>
    `;

    const jobs = parseCiandtPortalHtml(mockHtml, "CI&T");
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].title, "Engenheiro(a) de Software Sênior (Java / Cloud)");
    assert.equal(jobs[0].company, "CI&T");
    assert.equal(jobs[0].workModel, "REMOTO");
    assert.equal(jobs[0].seniorityLevel, "SENIOR");
    assert.ok(jobs[0].url.includes("opportunity=abcd-1234-uuid"));
    assert.equal(jobs[1].workModel, "HIBRIDO");
    assert.ok(jobs[1].url.includes("opportunity=efgh-5678-uuid"));
  });
});
