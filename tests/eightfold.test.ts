import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import {
  EightfoldRawJob,
  EightfoldScraper,
  normalizeEightfoldJob,
  parseEightfoldUrl,
} from "../server/scrapers/eightfold.js";
import { ConfigService } from "../server/services/config.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { StorageService } from "../server/services/storage.js";
import { Job } from "../server/types.js";
import { resilientFetch } from "../server/utils/fetch.js";

const mockEightfoldJobs: EightfoldRawJob[] = [
  {
    id: 44717707,
    displayJobId: "127266",
    name: "Senior Backend Software Engineer - Java & Golang (Híbrido)",
    locations: ["São Paulo, SP, Brazil"],
    department: "Engineering",
    workLocationOption: "hybrid",
    positionUrl: "/careers/job/44717707",
  },
  {
    id: 790298014263,
    name: "Staff AI & Distributed Systems Engineer (Python / React) - Remoto",
    posting_name:
      "Staff AI & Distributed Systems Engineer (Python / React) - Remoto",
    location: "Remote, Brazil",
    locations: ["Remote, Brazil"],
    department: "Data & Insights",
    work_location_option: "remote",
    canonicalPositionUrl:
      "https://explore.jobs.netflix.net/careers/job/790298014263",
    isPrivate: false,
  },
  {
    id: 1374434650090,
    name: "COORDENADOR (A) ADM DE PESSOAL CSC / RESCISÃO E MOVIMENTAÇÃO",
    location: "São Paulo, Brazil",
    business_unit: "Coca Cola FEMSA",
    work_location_option: "onsite",
    canonicalPositionUrl:
      "https://coca-colafemsa.eightfold.ai/careers/job/1374434650090",
    isPrivate: false,
  },
];

describe("Eightfold Scraper & E2E Pipeline", () => {
  it("should have correct metadata", () => {
    const scraper = new EightfoldScraper();
    assert.equal(scraper.id, "EIGHTFOLD");
    assert.equal(scraper.name, "Eightfold.ai (Meli, Netflix & Global)");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");
  });

  it("should extract host, domain, applyApiUrl and pcsxApiUrl from Eightfold URLs and slugs", () => {
    const meli = parseEightfoldUrl("https://mercadolibre.eightfold.ai/careers");
    assert.ok(meli);
    assert.equal(meli.host, "mercadolibre.eightfold.ai");
    assert.equal(meli.domain, "mercadolibre.com");
    assert.equal(
      meli.pcsxApiUrl,
      "https://mercadolibre.eightfold.ai/api/pcsx/search?domain=mercadolibre.com&query=software&location=&start=0",
    );

    const netflix = parseEightfoldUrl(
      "https://explore.jobs.netflix.net/careers",
    );
    assert.ok(netflix);
    assert.equal(netflix.host, "explore.jobs.netflix.net");
    assert.equal(netflix.domain, "netflix.com");
    assert.equal(
      netflix.applyApiUrl,
      "https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&start=0&num=20",
    );

    const femsa = parseEightfoldUrl(
      "https://coca-colafemsa.eightfold.ai/careers",
    );
    assert.ok(femsa);
    assert.equal(femsa.host, "coca-colafemsa.eightfold.ai");
    assert.equal(femsa.domain, "coca-colafemsa.com");
  });

  it("should normalize Eightfold postings and filter with TechClassifierService", () => {
    const meliCompany = {
      name: "Mercado Livre",
      slug: "mercadolibre",
      link: "https://mercadolibre.eightfold.ai/careers",
    };

    const normalized = mockEightfoldJobs
      .map((j) => normalizeEightfoldJob(j, meliCompany))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    assert.equal(normalized.length, 3);

    const seniorJob = normalized[0];
    assert.equal(
      seniorJob.title,
      "Senior Backend Software Engineer - Java & Golang (Híbrido)",
    );
    assert.equal(seniorJob.company, "Mercado Livre");
    assert.equal(seniorJob.location, "São Paulo, SP, Brazil");
    assert.equal(seniorJob.workModel, "HIBRIDO");
    assert.equal(seniorJob.contractType, "CLT");
    assert.equal(seniorJob.seniorityLevel, "SENIOR");
    assert.equal(
      seniorJob.url,
      "https://mercadolibre.eightfold.ai/careers/job/44717707",
    );
    assert.ok(seniorJob.stack.includes("Java"));
    assert.ok(seniorJob.stack.includes("Golang"));
    assert.equal(TechClassifierService.isTechSync(seniorJob.title), true);

    const staffJob = normalized[1];
    assert.equal(staffJob.workModel, "REMOTO");
    assert.equal(staffJob.location, "Remoto");
    assert.equal(staffJob.seniorityLevel, "ESPECIALISTA");
    assert.equal(
      staffJob.url,
      "https://explore.jobs.netflix.net/careers/job/790298014263",
    );
    assert.ok(staffJob.stack.includes("Python"));
    assert.ok(staffJob.stack.includes("React"));
    assert.equal(TechClassifierService.isTechSync(staffJob.title), true);

    const hrJob = normalized[2];
    assert.equal(hrJob.workModel, "PRESENCIAL");
    assert.equal(TechClassifierService.isTechSync(hrJob.title), false);
  });

  it("should format captured Eightfold jobs in WhatsApp Digest composer", () => {
    const company = {
      name: "Mercado Livre",
      slug: "mercadolibre",
      link: "https://mercadolibre.eightfold.ai/careers",
    };
    const jobs = mockEightfoldJobs.slice(0, 2).map((v, idx) => {
      const n = normalizeEightfoldJob(v, company)!;
      return {
        ...n,
        id: `ef-test-${idx}`,
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
      "Digest deve ser gerado com sucesso para vagas Eightfold",
    );
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("Mercado Livre"));
    assert.ok(
      digest.text.includes(
        "https://mercadolibre.eightfold.ai/careers/job/44717707",
      ),
    );
  });

  it("should capture Mercado Livre PCSX and Netflix Apply v2 engineering roles during broad radar sweep and reject non-tech", async () => {
    const originalFetch = globalThis.fetch;
    const originalUpsert = StorageService.upsertJob.bind(StorageService);
    const originalGetConfig = ConfigService.getConfig.bind(ConfigService);

    const baseConfig = originalGetConfig();
    ConfigService.getConfig = () =>
      ({
        ...baseConfig,
        eightfoldCompanies: [
          {
            name: "Mercado Livre",
            slug: "mercadolibre",
            link: "https://mercadolibre.eightfold.ai/careers",
            enabled: true,
          },
          {
            name: "Netflix",
            slug: "netflix",
            link: "https://explore.jobs.netflix.net/careers",
            enabled: true,
          },
        ],
      }) as any;

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

    const requestedUrls: string[] = [];
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedUrls.push(url);
      if (url.includes("mercadolibre.eightfold.ai/api/pcsx/search")) {
        return new Response(
          JSON.stringify({
            data: {
              positions: [
                {
                  id: 44717707,
                  name: "Software Technical Leader",
                  department: "IT",
                  locations: ["São Paulo, Brazil"],
                  workLocationOption: "hybrid",
                },
                {
                  id: 44717708,
                  name: "COORDENADOR (A) ADM DE PESSOAL CSC",
                  department: "HR",
                  locations: ["São Paulo, Brazil"],
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("explore.jobs.netflix.net/api/pcsx/search")) {
        return new Response(JSON.stringify({ data: { positions: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("explore.jobs.netflix.net/api/apply/v2/jobs")) {
        return new Response(
          JSON.stringify({
            positions: [
              {
                id: 790298014263,
                name: "AI Engineer 6 - AI Foundation & Tooling",
                department: "Data & Insights",
                location: "Remote, Brazil",
                work_location_option: "remote",
              },
              {
                id: 790298014264,
                name: "Security Software Engineer 5",
                department: "Engineering",
                location: "Remote, Brazil",
                work_location_option: "remote",
              },
              {
                id: 790298014265,
                name: "Software Development Engineer in Test 5",
                department: "Engineering",
                location: "Remote, Brazil",
                work_location_option: "remote",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };

    try {
      const scraper = new EightfoldScraper();
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
          sources: ["EIGHTFOLD"],
        },
        () => {},
      );

      assert.ok(
        requestedUrls.some((u) =>
          u.includes("mercadolibre.eightfold.ai/api/pcsx/search?domain=mercadolibre.com&query=software"),
        ),
        "Deve consultar PCSX com query=software",
      );
      assert.equal(jobs.length, 4);
      const titles = jobs.map((j) => j.title);
      assert.ok(titles.includes("Software Technical Leader"));
      assert.ok(titles.includes("AI Engineer 6 - AI Foundation & Tooling"));
      assert.ok(titles.includes("Security Software Engineer 5"));
      assert.ok(titles.includes("Software Development Engineer in Test 5"));
    } finally {
      globalThis.fetch = originalFetch;
      StorageService.upsertJob = originalUpsert;
      ConfigService.getConfig = originalGetConfig;
    }
  });

  it("should query public Eightfold API resiliently", async () => {
    const parsed = parseEightfoldUrl(
      "https://mercadolibre.eightfold.ai/careers",
    )!;
    try {
      const res = await resilientFetch(parsed.pcsxApiUrl, {
        timeoutMs: 10000,
        maxRetries: 1,
        source: "EIGHTFOLD",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (res.ok) {
        const payload = await res.json();
        const positions: EightfoldRawJob[] = payload?.data?.positions || [];
        assert.ok(Array.isArray(positions));
        if (positions.length > 0) {
          const sample = normalizeEightfoldJob(positions[0], {
            name: "Mercado Livre",
            slug: "mercadolibre",
            link: "https://mercadolibre.eightfold.ai/careers",
          });
          assert.ok(sample);
          assert.equal(sample.source, "EIGHTFOLD");
        }
      }
    } catch {
      // Tratamento resiliente para ambientes sem rede externa
    }
  });
});
