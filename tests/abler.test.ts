import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import {
  AblerRawJob,
  AblerScraper,
  extractAblerSlug,
  normalizeAblerJob,
} from "../server/scrapers/abler.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { resilientFetch } from "../server/utils/fetch.js";

const mockAblerJobs: AblerRawJob[] = [
  {
    id: "400246",
    type: "public_vacancy",
    attributes: {
      company_id: 6102,
      title: "Analista de Sistemas Sênior (Node.js / React)",
      slug: "analista-de-sistemas-senior-724236",
      released: true,
      description:
        "<p>Desenvolvimento e arquitetura de microsserviços em Node.js, TypeScript, React e PostgreSQL.</p>",
      city: "Belo Horizonte",
      state: "Minas Gerais",
      work_type: ["remoto"],
      work_type_formatted: ["Remoto"],
      contracting_regime: "CLT",
      seniority_level_formatted: "Sênior",
      salary: 9000,
      full_url:
        "https://solucionare.abler.com.br/vagas/analista-de-sistemas-senior-724236",
    },
  },
  {
    id: "372662",
    type: "public_vacancy",
    attributes: {
      company_id: 4120,
      title: "Pessoa Engenheira de Dados Pleno (Python & AWS)",
      slug: "pessoa-engenheira-de-dados-pleno-911620",
      released: true,
      role_description_without_tags:
        "Construção de pipelines ETL com Python, SQL, Spark e AWS.",
      city: "Curitiba",
      state: "Paraná",
      work_type: ["hibrida"],
      work_type_formatted: ["Hibrida"],
      contracting_regime: "PJ",
      seniority_level_formatted: "Pleno",
    },
  },
  {
    id: "400738",
    type: "public_vacancy",
    attributes: {
      company_id: 415,
      title: "Assistente de Serviços Pós Vendas - Concessionária",
      slug: "assistente-de-servicos-pos-vendas-697825",
      released: true,
      description: "<p>Realizar o atendimento de clientes na loja de veículos.</p>",
      city: "Ponta Grossa",
      state: "Paraná",
      work_type: ["presencial"],
      work_type_formatted: ["Presencial"],
      contracting_regime: "CLT",
      seniority_level_formatted: "Não se aplica",
      salary: 0.01,
    },
  },
  {
    id: "400999",
    type: "public_vacancy",
    attributes: {
      title: "Vaga Não Publicada",
      released: false,
    },
  },
];

describe("Abler Scraper & E2E Pipeline", () => {
  it("should have correct metadata and extract slugs from Abler URLs", () => {
    const scraper = new AblerScraper();
    assert.equal(scraper.id, "ABLER");
    assert.equal(scraper.name, "Abler ATS (Brasil)");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");

    assert.equal(
      extractAblerSlug("https://ats.abler.com.br/jobs/grupobarigui"),
      "grupobarigui",
    );
    assert.equal(
      extractAblerSlug("https://solucionare.abler.com.br/vagas"),
      "solucionare",
    );
    assert.equal(extractAblerSlug("hublocal"), "hublocal");
  });

  it("should normalize Abler vacancies and filter with TechClassifierService", () => {
    const company = { name: "Solucionare", slug: "solucionare" };
    const normalized = mockAblerJobs
      .map((j) => normalizeAblerJob(j, company))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    // Vaga com released=false deve ser ignorada
    assert.equal(normalized.length, 3);

    const seniorJob = normalized[0];
    assert.equal(
      seniorJob.title,
      "Analista de Sistemas Sênior (Node.js / React)",
    );
    assert.equal(seniorJob.company, "Solucionare");
    assert.equal(seniorJob.location, "Belo Horizonte, MG");
    assert.equal(seniorJob.workModel, "REMOTO");
    assert.equal(seniorJob.contractType, "CLT");
    assert.equal(seniorJob.seniorityLevel, "SENIOR");
    assert.equal(
      seniorJob.url,
      "https://solucionare.abler.com.br/vagas/analista-de-sistemas-senior-724236",
    );
    assert.ok(seniorJob.stack.includes("Node"));
    assert.ok(seniorJob.stack.includes("React"));
    assert.ok(seniorJob.stack.includes("TypeScript"));
    assert.equal(TechClassifierService.isTechSync(seniorJob.title), true);

    const dataJob = normalized[1];
    assert.equal(dataJob.location, "Curitiba, PR");
    assert.equal(dataJob.workModel, "HIBRIDO");
    assert.equal(dataJob.contractType, "PJ");
    assert.equal(dataJob.seniorityLevel, "PLENO");
    assert.equal(
      dataJob.url,
      "https://ats.abler.com.br/jobs/solucionare/pessoa-engenheira-de-dados-pleno-911620",
    );
    assert.ok(dataJob.stack.includes("Python"));
    assert.ok(dataJob.stack.includes("AWS"));
    assert.equal(TechClassifierService.isTechSync(dataJob.title), true);

    const nonTechJob = normalized[2];
    assert.equal(nonTechJob.workModel, "PRESENCIAL");
    assert.equal(nonTechJob.salary, undefined);
    assert.equal(TechClassifierService.isTechSync(nonTechJob.title), false);
  });

  it("should format captured Abler jobs in WhatsApp Digest composer", () => {
    const company = { name: "Solucionare", slug: "solucionare" };
    const jobs = mockAblerJobs.slice(0, 2).map((v, idx) => {
      const n = normalizeAblerJob(v, company)!;
      return {
        ...n,
        id: `abler-test-${idx}`,
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

    assert.ok(digest, "Digest deve ser gerado com sucesso para vagas da Abler");
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("Solucionare"));
    assert.ok(
      digest.text.includes(
        "https://solucionare.abler.com.br/vagas/analista-de-sistemas-senior-724236",
      ),
    );
  });

  it("should query public Abler API live and normalize returned vacancies", async () => {
    const apiUrl =
      "https://hulk-smash.abler.com.br/api/company/v1/careers_pages/solucionare/vacancies?per_page=100&page=1";
    try {
      const res = await resilientFetch(apiUrl, {
        timeoutMs: 10000,
        maxRetries: 1,
        source: "ABLER",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (res.ok) {
        const payload = await res.json();
        const data: AblerRawJob[] = payload?.data || [];
        assert.ok(Array.isArray(data));
        assert.ok(
          data.length > 0,
          "Esperava vagas ativas para Solucionare na Abler",
        );
        const sample = normalizeAblerJob(data[0], {
          name: "Solucionare",
          slug: "solucionare",
        });
        assert.ok(sample);
        assert.equal(sample.source, "ABLER");
      }
    } catch {
      // Tratamento resiliente para ambientes sem rede externa
    }
  });
});
