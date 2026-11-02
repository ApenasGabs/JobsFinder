import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import {
  extractRecruiteeSlug,
  normalizeRecruiteeJob,
  RecruiteeRawJob,
  RecruiteeScraper,
} from "../server/scrapers/recruitee.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { ConfigService } from "../server/services/config.js";
import { ScraperHealthService } from "../server/services/scraper-health.js";
import { StorageService } from "../server/services/storage.js";
import { Job } from "../server/types.js";
import { resilientFetch } from "../server/utils/fetch.js";

const mockRecruiteeJobs: RecruiteeRawJob[] = [
  {
    id: 2705516,
    title: "Líder de Engenharia de Software (Tech Lead) - Node.js & React",
    slug: "lider-de-engenharia-de-software-tech-lead",
    careers_url:
      "https://asksuite.recruitee.com/o/lider-de-engenharia-de-software-tech-lead",
    city: "Florianópolis, Brazil",
    state_code: "SC",
    country: "Brasil",
    remote: true,
    hybrid: false,
    on_site: false,
    department: "TI",
    description:
      "<p>Liderança técnica em arquitetura de microsserviços com Node.js, TypeScript, React e AWS.</p>",
    employment_type_code: "fulltime_permanent",
    experience_code: "senior_level",
    status: "published",
  },
  {
    id: 2175358,
    title: "Google Cloud Platform Engineer (Python / Kubernetes)",
    slug: "platform-engineer",
    careers_url: "https://kaizo.recruitee.com/o/platform-engineer",
    city: "Amsterdam",
    state_code: "NH",
    country: "Netherlands",
    remote: false,
    hybrid: true,
    on_site: false,
    department: "Engineering",
    description:
      "<p>Infrastructure and DevOps with GCP, Docker, Kubernetes, Terraform and Python.</p>",
    employment_type_code: "contract",
    experience_code: "mid_level",
    status: "published",
  },
  {
    id: 2781247,
    title: "Executivo de Vendas Comerciais",
    slug: "executivo-de-vendas-comerciais",
    careers_url: "https://asksuite.recruitee.com/o/executivo-de-vendas",
    city: "Florianópolis",
    state_code: "SC",
    country: "Brasil",
    remote: false,
    hybrid: false,
    on_site: true,
    department: "Vendas",
    status: "published",
  },
  {
    id: 9999999,
    title: "Vaga Arquivada Draft",
    status: "archived",
  },
];

describe("Recruitee Scraper & E2E Pipeline", () => {
  it("should have correct metadata and extract slugs from Recruitee URLs", () => {
    const scraper = new RecruiteeScraper();
    assert.equal(scraper.id, "RECRUITEE");
    assert.equal(scraper.name, "Recruitee (CPQD & Startups)");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");

    assert.equal(extractRecruiteeSlug("https://cpqd.recruitee.com"), "cpqd");
    assert.equal(
      extractRecruiteeSlug("https://asksuite.recruitee.com/"),
      "asksuite",
    );
    assert.equal(extractRecruiteeSlug("kaizo"), "kaizo");
  });

  it("should normalize Recruitee offers and filter with TechClassifierService", () => {
    const company = { name: "Asksuite", slug: "asksuite" };
    const normalized = mockRecruiteeJobs
      .map((j) => normalizeRecruiteeJob(j, company))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    // Vaga arquivada deve ser descartada
    assert.equal(normalized.length, 3);

    const techLeadJob = normalized[0];
    assert.equal(
      techLeadJob.title,
      "Líder de Engenharia de Software (Tech Lead) - Node.js & React",
    );
    assert.equal(techLeadJob.company, "Asksuite");
    assert.equal(techLeadJob.location, "Florianópolis, Brazil, SC");
    assert.equal(techLeadJob.workModel, "REMOTO");
    assert.equal(techLeadJob.contractType, "CLT");
    assert.equal(techLeadJob.seniorityLevel, "SENIOR");
    assert.equal(
      techLeadJob.url,
      "https://asksuite.recruitee.com/o/lider-de-engenharia-de-software-tech-lead",
    );
    assert.ok(techLeadJob.stack.includes("Node"));
    assert.ok(techLeadJob.stack.includes("React"));
    assert.equal(TechClassifierService.isTechSync(techLeadJob.title), true);

    const platformJob = normalized[1];
    assert.equal(platformJob.location, "Amsterdam, NH");
    assert.equal(platformJob.workModel, "HIBRIDO");
    assert.equal(platformJob.contractType, "PJ");
    assert.equal(platformJob.seniorityLevel, "PLENO");
    assert.ok(platformJob.stack.includes("Python"));
    assert.ok(platformJob.stack.includes("Kubernetes"));
    assert.ok(platformJob.stack.includes("Docker"));
    assert.equal(TechClassifierService.isTechSync(platformJob.title), true);

    const salesJob = normalized[2];
    assert.equal(salesJob.workModel, "PRESENCIAL");
    assert.equal(TechClassifierService.isTechSync(salesJob.title), false);
  });

  it("should format captured Recruitee jobs in WhatsApp Digest composer", () => {
    const company = { name: "Asksuite", slug: "asksuite" };
    const jobs = mockRecruiteeJobs.slice(0, 2).map((v, idx) => {
      const n = normalizeRecruiteeJob(v, company)!;
      return {
        ...n,
        id: `recruitee-test-${idx}`,
        scrapedAt: new Date().toISOString(),
        isTech: true,
      };
    });

    const digest = buildDigest(jobs, {
      title: "VAGAS PLENO E SÊNIOR",
      emoji: "🚀",
      radarUrl: "https://querovagas.apenasgabs.dev/",
      includeAbroad: true,
      minJobs: 1,
    });

    assert.ok(
      digest,
      "Digest deve ser gerado com sucesso para vagas do Recruitee",
    );
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("Asksuite"));
    assert.ok(
      digest.text.includes(
        "https://asksuite.recruitee.com/o/lider-de-engenharia-de-software-tech-lead",
      ),
    );
  });

  it("should query public Recruitee API live and normalize returned offers", async () => {
    const apiUrl = "https://asksuite.recruitee.com/api/offers/";
    try {
      const res = await resilientFetch(apiUrl, {
        timeoutMs: 10000,
        maxRetries: 1,
        source: "RECRUITEE",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (res.ok) {
        const data = await res.json();
        const offers: RecruiteeRawJob[] = data?.offers || [];
        assert.ok(Array.isArray(offers));
        assert.ok(
          offers.length > 0,
          "Esperava ofertas ativas para Asksuite no Recruitee",
        );
        const sample = normalizeRecruiteeJob(offers[0], {
          name: "Asksuite",
          slug: "asksuite",
        });
        assert.ok(sample);
        assert.equal(sample.source, "RECRUITEE");
      }
    } catch {
      // Tratamento resiliente para ambientes sem rede externa
    }
  });

  it("should extract stack past 1000 chars of company boilerplate and honor experience_code fallback", () => {
    const longIntro = `<p>${"Sobre a nossa cultura institucional de atendimento global. ".repeat(30)}</p>`;
    const jobWithLateRequirements: RecruiteeRawJob = {
      id: 888001,
      title: "Data Scientist",
      slug: "data-scientist",
      department: "AI",
      description: longIntro,
      requirements:
        "<ul><li>Experiência sólida com Python, Docker, Kubernetes e SQL.</li></ul>",
      experience_code: "junior_level",
      employment_type_code: "fulltime_permanent",
      remote: true,
      status: "published",
    };

    const normalized = normalizeRecruiteeJob(jobWithLateRequirements, {
      name: "Kaizo",
      slug: "kaizo",
    });

    assert.ok(normalized);
    assert.equal(normalized.seniorityLevel, "JUNIOR");
    assert.ok(normalized.stack.includes("Python"));
    assert.ok(normalized.stack.includes("Docker"));
    assert.ok(normalized.stack.includes("Kubernetes"));
    assert.ok((normalized.description || "").length <= 1000);
  });

  it("should capture tech roles with unaccented searchTerms, reject RevOps/Sales, and emit SOURCE_SCHEMA_CHANGED on malformed payload", async () => {
    const originalFetch = globalThis.fetch;
    const originalUpsert = StorageService.upsertJob.bind(StorageService);
    const originalGetConfig = ConfigService.getConfig.bind(ConfigService);

    const baseConfig = originalGetConfig();
    ConfigService.getConfig = () => ({
      ...baseConfig,
      recruiteeCompanies: [
        {
          name: "Asksuite",
          slug: "asksuite",
          link: "https://asksuite.recruitee.com",
          enabled: true,
        },
        {
          name: "BrokenSchemaCo",
          slug: "brokenschema",
          link: "https://brokenschema.recruitee.com",
          enabled: true,
        },
      ],
    });

    StorageService.upsertJob = (jobData: Omit<Job, "id">) => {
      const isTech = TechClassifierService.isTechSync(jobData.title);
      return {
        job: {
          ...jobData,
          id: `mock-${jobData.url}`,
          scrapedAt: new Date().toISOString(),
          isTech,
        },
        isNew: isTech,
      };
    };

    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("brokenschema.recruitee.com")) {
        return new Response(JSON.stringify({ invalidRoot: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          offers: [
            {
              id: 101,
              title: "Líder de Engenharia de Software (Tech Lead)",
              slug: "lider-de-engenharia",
              department: "TI",
              description: `<p>${"Texto institucional longo. ".repeat(60)}</p>`,
              requirements: "<p>Domínio de Node.js, TypeScript e AWS.</p>",
              experience_code: "senior_level",
              remote: true,
              status: "published",
            },
            {
              id: 102,
              title: "Analista de RevOps (Revenue Operations)",
              slug: "analista-revops",
              department: "RevOps",
              description: "<p>Operações comerciais com consultas SQL.</p>",
              status: "published",
            },
            {
              id: 103,
              title: "Estágio em Marketing",
              slug: "estagio-marketing",
              department: "Marketing",
              employment_type_code: "internship",
              status: "published",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    ScraperHealthService.reset();
    try {
      ScraperHealthService.recordStart("RECRUITEE", "Recruitee");
      const scraper = new RecruiteeScraper();
      const jobs = await scraper.scrape(
        {
          keywords: [
            "java",
            "react",
            "node",
            "typescript",
            "fullstack",
            "frontend",
            "backend",
            "python",
            "devops",
            "estagio",
            "junior",
          ],
          sources: ["RECRUITEE"],
        },
        () => {},
      );

      assert.equal(jobs.length, 1);
      assert.equal(
        jobs[0].title,
        "Líder de Engenharia de Software (Tech Lead)",
      );

      ScraperHealthService.recordSuccess("RECRUITEE", jobs.length, 50);
      const alerts = ScraperHealthService.getActiveAlerts();
      const schemaAlert = alerts.find(
        (a) => a.code === "SOURCE_SCHEMA_CHANGED" && a.source === "RECRUITEE",
      );
      assert.ok(
        schemaAlert,
        "Deve emitir alerta SOURCE_SCHEMA_CHANGED quando uma empresa retornar schema inválido",
      );
    } finally {
      globalThis.fetch = originalFetch;
      StorageService.upsertJob = originalUpsert;
      ConfigService.getConfig = originalGetConfig;
      ScraperHealthService.reset();
    }
  });
});
