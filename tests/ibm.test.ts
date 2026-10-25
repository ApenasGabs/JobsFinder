import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import {
  IbmRawHit,
  IbmScraper,
  normalizeIbmJob,
} from "../server/scrapers/ibm.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { resilientFetch } from "../server/utils/fetch.js";

const mockIbmHits: IbmRawHit[] = [
  {
    _id: "ibm-hit-1",
    _source: {
      url: "https://careers.ibm.com/careers/JobDetail?jobId=138182",
      title: "Enterprise Security Architect | Zero Trust, IAM & Cloud Security",
      description:
        "Work with hybrid cloud, AWS, Kubernetes and AI journeys across Brazil.",
      field_keyword_05: "Brazil",
      field_keyword_08: "Software Engineering",
      field_keyword_17: "Hybrid",
      field_keyword_18: "Professional",
      field_keyword_19: "SÃO PAULO, BR",
    },
  },
  {
    _id: "ibm-hit-2",
    _source: {
      url: "https://careers.ibm.com/careers/JobDetail?jobId=136474",
      title: "Cientista de Dados Sênior (Python & Machine Learning)",
      description: "Data science with Python, SQL and PyTorch.",
      field_keyword_05: "Brazil",
      field_keyword_08: "Data & Analytics",
      field_keyword_17: "Remote",
      field_keyword_18: "Professional",
      field_keyword_19: "NO City, BR",
    },
  },
  {
    _id: "ibm-hit-3",
    _source: {
      url: "https://careers.ibm.com/careers/JobDetail?jobId=199999",
      title: "Vendedor Externo de Loja",
      description: "Atendimento comercial presencial.",
      field_keyword_05: "Brazil",
      field_keyword_08: "Sales",
      field_keyword_17: "On-site",
      field_keyword_18: "Professional",
      field_keyword_19: "SÃO PAULO, BR",
    },
  },
];

describe("IBM Careers Scraper & E2E Pipeline", () => {
  it("should have correct metadata", () => {
    const scraper = new IbmScraper();
    assert.equal(scraper.id, "IBM");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");
  });

  it("should normalize IBM hits and filter with TechClassifierService", () => {
    const normalized = mockIbmHits
      .map((h) => normalizeIbmJob(h))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    assert.equal(normalized.length, 3);

    const archJob = normalized[0];
    assert.equal(archJob.company, "IBM");
    assert.equal(archJob.workModel, "HIBRIDO");
    assert.equal(
      archJob.url,
      "https://careers.ibm.com/careers/JobDetail?jobId=138182",
    );
    assert.ok(archJob.stack.includes("AWS"));
    assert.equal(TechClassifierService.isTechSync(archJob.title), true);

    const dataJob = normalized[1];
    assert.equal(dataJob.workModel, "REMOTO");
    assert.equal(dataJob.seniorityLevel, "SENIOR");
    assert.ok(dataJob.stack.includes("Python"));
    assert.equal(TechClassifierService.isTechSync(dataJob.title), true);

    const salesJob = normalized[2];
    assert.equal(salesJob.workModel, "PRESENCIAL");
    assert.equal(TechClassifierService.isTechSync(salesJob.title), false);
  });

  it("should format captured IBM jobs in WhatsApp Digest composer", () => {
    const jobs = mockIbmHits.slice(0, 2).map((h, idx) => {
      const n = normalizeIbmJob(h)!;
      return {
        ...n,
        id: `ibm-test-${idx}`,
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

    assert.ok(digest, "Digest deve ser gerado com sucesso para vagas da IBM");
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("IBM"));
    assert.ok(
      digest.text.includes(
        "https://careers.ibm.com/careers/JobDetail?jobId=138182",
      ),
    );
  });

  it("should query IBM Search API v2 live for Brazil jobs", async () => {
    const res = await resilientFetch("https://www-api.ibm.com/search/api/v2", {
      method: "POST",
      timeoutMs: 10000,
      maxRetries: 1,
      source: "IBM",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        appId: "careers",
        scopes: ["careers2"],
        query: { bool: { must: [] } },
        post_filter: { term: { field_keyword_05: "Brazil" } },
        _source: [
          "_id",
          "title",
          "url",
          "description",
          "field_keyword_05",
          "field_keyword_08",
          "field_keyword_17",
          "field_keyword_18",
          "field_keyword_19",
        ],
        size: 5,
        lang: "zz",
        localeSelector: { lc: "pt", cc: "br" },
      }),
    });

    assert.equal(res.ok, true);
    const data = await res.json();
    assert.ok(Array.isArray(data?.hits?.hits));
  });
});
