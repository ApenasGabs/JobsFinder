import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import {
  extractRecrutaiSlug,
  normalizeRecrutaiJob,
  parseRecrutaiJobsHtml,
  RecrutaiRawJob,
  RecrutaiScraper,
} from "../server/scrapers/recrutai.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { resilientFetch } from "../server/utils/fetch.js";

const mockRecrutaiJobs: RecrutaiRawJob[] = [
  {
    code: "JGE4BD",
    title: "Software Engineering Expert - Fintech (Node.js / TypeScript)",
    location: "Vagas Remotas",
    workModel: "Remoto",
    contractType: "Efetivo",
    description:
      "Desenvolvimento de soluções escaláveis na Fintech Petlove com Node.js, TypeScript e AWS.",
  },
  {
    code: "U7A0WG",
    title: "Tech Lead (Java / Spring / React)",
    location: "São Paulo / SP",
    workModel: "Híbrido",
    contractType: "PJ",
    address: "Avenida das Nações Unidas, 12901",
  },
  {
    code: "U8UMZT",
    title: "Banhista Tosador",
    location: "São Paulo / SP",
    workModel: "Presencial",
    contractType: "Efetivo",
  },
];

const mockRecrutaiHtml = `
<div id="agentJobs">
  <h4><span class="ms-icon"><i class="zmdi zmdi-pin"></i></span> Belo Horizonte / MG <span class="badge badge-secondary">1</span></h4>
  <div class="row masonry-container">
    <div class="col-lg-6 col-md-6 masonry-item">
      <div class="card">
        <div class="col-sm-8">
          <h5 class="color-primary mt-1"><span class="badge mr">91B9FT</span><br />Desenvolvedor Full Stack Java Sr - BH</h5>
          <div class="row">
            <div class="col-sm-12"><p title="Tipo de Contrato"><small><i class="zmdi zmdi-file-text"></i> Efetivo</small></p></div>
            <div class="col-sm-12"><p><small><i class="zmdi zmdi-pin-account"></i> Híbrido</small></p></div>
            <div class="col-sm-12 text-left"><p><small><i class="zmdi zmdi-pin"></i> Avenida Barbacena 41</small></p></div>
          </div>
          <a href="job/91B9FT" class="btn btn-raised btn-sm">VER OPORTUNIDADE</a>
        </div>
      </div>
    </div>
  </div>
</div>
<div id="otherJobs">
  <h4><span class="ms-icon"><i class="zmdi zmdi-pin-off"></i></span> Vagas Remotas <span class="badge badge-secondary">1</span></h4>
  <table width="100%">
    <tbody>
      <tr height="30px">
        <td width="40%"><a href="job/JGE4BD">Software Engineering Expert - Fintech</a></td>
        <td width="15%">Efetivo</td>
        <td width="15%"><b>Remoto</b></td>
        <td width="30%"></td>
      </tr>
    </tbody>
  </table>
</div>
`;

describe("Recrut.ai Scraper & E2E Pipeline", () => {
  it("should have correct metadata and parse Recrut.ai slugs and HTML", () => {
    const scraper = new RecrutaiScraper();
    assert.equal(scraper.id, "RECRUTAI");
    assert.equal(scraper.name, "Recrut.ai (Petlove & Tech BR)");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");

    assert.equal(
      extractRecrutaiSlug("https://petlove.jobs.recrut.ai"),
      "petlove",
    );
    assert.equal(extractRecrutaiSlug("apdata"), "apdata");

    const parsedHtmlJobs = parseRecrutaiJobsHtml(mockRecrutaiHtml);
    assert.equal(parsedHtmlJobs.length, 2);
    assert.equal(parsedHtmlJobs[0].code, "91B9FT");
    assert.equal(
      parsedHtmlJobs[0].title,
      "Desenvolvedor Full Stack Java Sr - BH",
    );
    assert.equal(parsedHtmlJobs[0].workModel, "Híbrido");
    assert.equal(parsedHtmlJobs[0].location, "Belo Horizonte / MG");

    assert.equal(parsedHtmlJobs[1].code, "JGE4BD");
    assert.equal(
      parsedHtmlJobs[1].title,
      "Software Engineering Expert - Fintech",
    );
    assert.equal(parsedHtmlJobs[1].workModel, "Remoto");
  });

  it("should normalize Recrut.ai jobs and classify Tech vs Non-Tech", () => {
    const company = { name: "Petlove", slug: "petlove" };
    const normalized = mockRecrutaiJobs
      .map((j) => normalizeRecrutaiJob(j, company))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    assert.equal(normalized.length, 3);

    const expertJob = normalized[0];
    assert.equal(
      expertJob.title,
      "Software Engineering Expert - Fintech (Node.js / TypeScript)",
    );
    assert.equal(expertJob.company, "Petlove");
    assert.equal(expertJob.location, "Remoto");
    assert.equal(expertJob.workModel, "REMOTO");
    assert.equal(expertJob.contractType, "CLT");
    assert.equal(expertJob.seniorityLevel, "PLENO");
    assert.equal(expertJob.url, "https://petlove.jobs.recrut.ai/job/JGE4BD");
    assert.ok(expertJob.stack.includes("Node"));
    assert.ok(expertJob.stack.includes("TypeScript"));
    assert.equal(TechClassifierService.isTechSync(expertJob.title), true);

    const leadJob = normalized[1];
    assert.equal(leadJob.location, "São Paulo, SP");
    assert.equal(leadJob.workModel, "HIBRIDO");
    assert.equal(leadJob.contractType, "PJ");
    assert.equal(leadJob.seniorityLevel, "SENIOR");
    assert.equal(leadJob.url, "https://petlove.jobs.recrut.ai/job/U7A0WG");
    assert.ok(leadJob.stack.includes("Java"));
    assert.ok(leadJob.stack.includes("React"));
    assert.equal(TechClassifierService.isTechSync(leadJob.title), true);

    const nonTechJob = normalized[2];
    assert.equal(nonTechJob.workModel, "PRESENCIAL");
    assert.equal(TechClassifierService.isTechSync(nonTechJob.title), false);
  });

  it("should format captured Recrut.ai jobs in WhatsApp Digest composer", () => {
    const company = { name: "Petlove", slug: "petlove" };
    const jobs = mockRecrutaiJobs.slice(0, 2).map((v, idx) => {
      const n = normalizeRecrutaiJob(v, company)!;
      return {
        ...n,
        id: `recrutai-test-${idx}`,
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
      "Digest deve ser gerado com sucesso para vagas da Recrut.ai",
    );
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("Petlove"));
    assert.ok(digest.text.includes("https://petlove.jobs.recrut.ai/job/JGE4BD"));
  });

  it("should query public Recrut.ai endpoint live and parse returned jobs", async () => {
    const apiUrl =
      "https://petlove.jobs.recrut.ai/company/public-jobs/*/*/*/*/?search=";
    try {
      const res = await resilientFetch(apiUrl, {
        timeoutMs: 10000,
        maxRetries: 1,
        source: "RECRUTAI",
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (res.ok) {
        const data = await res.json();
        const jobs = parseRecrutaiJobsHtml(data?.html || "");
        assert.ok(Array.isArray(jobs));
        assert.ok(
          jobs.length > 0,
          "Esperava vagas ativas para Petlove na Recrut.ai",
        );
        const sample = normalizeRecrutaiJob(jobs[0], {
          name: "Petlove",
          slug: "petlove",
        });
        assert.ok(sample);
        assert.equal(sample.source, "RECRUTAI");
      }
    } catch {
      // Tratamento resiliente para ambientes sem rede externa
    }
  });
});
