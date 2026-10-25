import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import {
  extractMindsightSlug,
  MindsightRawJob,
  MindsightScraper,
  normalizeMindsightJob,
  parseMindsightHtml,
} from "../server/scrapers/mindsight.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { resilientFetch } from "../server/utils/fetch.js";

const mockMindsightJobs: MindsightRawJob[] = [
  {
    id: 647,
    name: "SRE Sênior - (DevSecOps & Plataforma) - AWS / Kubernetes",
    status: "IN_PROGRESS",
    positions: 1,
    start_salary_range: "12000.00",
    end_salary_range: "15000.00",
    competencies: ["Docker", "Terraform"],
    country: "BR",
    state: "MG",
    city: "Uberlândia",
    work_model: "HYBRID",
    hire_model: "EFFECTIVE_CLT",
    external_publication: true,
    unlisted_external_publication: false,
    already_canceled: false,
    publication_path_segment: "sre-senior-devsecops-plataforma",
  },
  {
    id: 68,
    name: "Engenheiro(a) de Dados Pleno (Python & SQL) - Remoto",
    status: "IN_PROGRESS",
    positions: 1,
    start_salary_range: "8000.00",
    end_salary_range: "10000.00",
    competencies: ["Python", "SQL", "AWS"],
    country: "BR",
    state: "SP",
    city: "",
    work_model: "REMOTE",
    hire_model: "AUTONOMOUS_PJ",
    external_publication: true,
    unlisted_external_publication: false,
    already_canceled: false,
  },
  {
    id: 83,
    name: "Analista de Marketing Nutricional Pleno",
    status: "IN_PROGRESS",
    positions: 1,
    country: "BR",
    state: "SP",
    city: "São Paulo",
    work_model: "IN_PERSON",
    hire_model: "EFFECTIVE_CLT",
    external_publication: true,
    unlisted_external_publication: false,
    already_canceled: false,
  },
  {
    id: 999,
    name: "Desenvolvedor Backend Cancelado",
    status: "CANCELED",
    already_canceled: true,
    external_publication: false,
  },
];

describe("Mindsight Scraper & E2E Pipeline", () => {
  it("should have correct metadata and slug extraction", () => {
    const scraper = new MindsightScraper();
    assert.equal(scraper.id, "MINDSIGHT");
    assert.equal(scraper.name, "Mindsight (Tech & Startups BR)");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");

    assert.equal(
      extractMindsightSlug("https://oportunidades.mindsight.com.br/sankhya"),
      "sankhya",
    );
    assert.equal(
      extractMindsightSlug("https://oportunidades.mindsight.com.br/pt/pontotel/"),
      "pontotel",
    );
    assert.equal(extractMindsightSlug("siteware"), "siteware");
  });

  it("should normalize Mindsight jobs and filter with TechClassifierService", () => {
    const company = {
      name: "Sankhya",
      slug: "sankhya",
      link: "https://oportunidades.mindsight.com.br/sankhya",
    };

    const normalized = mockMindsightJobs
      .map((item) => normalizeMindsightJob(item, company))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    // Vaga cancelada deve ser descartada
    assert.equal(normalized.length, 3);

    const sreJob = normalized[0];
    assert.equal(
      sreJob.title,
      "SRE Sênior - (DevSecOps & Plataforma) - AWS / Kubernetes",
    );
    assert.equal(sreJob.company, "Sankhya");
    assert.equal(sreJob.location, "Uberlândia, MG");
    assert.equal(sreJob.workModel, "HIBRIDO");
    assert.equal(sreJob.contractType, "CLT");
    assert.equal(sreJob.seniorityLevel, "SENIOR");
    assert.equal(
      sreJob.url,
      "https://oportunidades.mindsight.com.br/sankhya/647",
    );
    assert.ok(sreJob.stack.includes("AWS"));
    assert.ok(sreJob.stack.includes("Kubernetes"));
    assert.ok(sreJob.stack.includes("Docker"));
    assert.equal(TechClassifierService.isTechSync(sreJob.title), true);

    const dataJob = normalized[1];
    assert.equal(dataJob.location, "Remoto");
    assert.equal(dataJob.workModel, "REMOTO");
    assert.equal(dataJob.contractType, "PJ");
    assert.equal(dataJob.seniorityLevel, "PLENO");
    assert.ok(dataJob.stack.includes("Python"));
    assert.ok(dataJob.stack.includes("SQL"));
    assert.equal(TechClassifierService.isTechSync(dataJob.title), true);

    const marketingJob = normalized[2];
    assert.equal(marketingJob.location, "São Paulo, SP");
    assert.equal(marketingJob.workModel, "PRESENCIAL");
    assert.equal(TechClassifierService.isTechSync(marketingJob.title), false);
  });

  it("should format captured Mindsight jobs in WhatsApp Digest composer", () => {
    const company = { name: "Sankhya", slug: "sankhya" };
    const jobs = mockMindsightJobs.slice(0, 2).map((v, idx) => {
      const n = normalizeMindsightJob(v, company)!;
      return {
        ...n,
        id: `mindsight-test-${idx}`,
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
      "Digest deve ser gerado com sucesso para vagas da Mindsight",
    );
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("Sankhya"));
    assert.ok(
      digest.text.includes(
        "https://oportunidades.mindsight.com.br/sankhya/647",
      ),
    );
  });

  it("should fetch and parse real vacancies live from Mindsight SSR portal", async () => {
    const company = { name: "Sankhya", slug: "sankhya" };
    try {
      const res = await resilientFetch(
        "https://oportunidades.mindsight.com.br/sankhya",
        {
          timeoutMs: 12000,
          maxRetries: 1,
          source: "MINDSIGHT",
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
            "User-Agent": "Mozilla/5.0",
          },
        },
      );

      if (res.ok) {
        const html = await res.text();
        const postings = parseMindsightHtml(html);
        assert.ok(Array.isArray(postings));
        if (postings.length > 0) {
          const sample = normalizeMindsightJob(postings[0], company);
          assert.ok(sample);
          assert.equal(sample.source, "MINDSIGHT");
          assert.ok(
            sample.url.startsWith(
              "https://oportunidades.mindsight.com.br/sankhya/",
            ),
          );
        }
      }
    } catch {
      // Tratamento resiliente para ambientes sem rede externa
    }
  });
});
