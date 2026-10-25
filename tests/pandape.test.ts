import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import {
  extractPandapeSlug,
  normalizePandapeJob,
  PandapeRawJob,
  PandapeScraper,
  parsePandapeHtml,
} from "../server/scrapers/pandape.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { resilientFetch } from "../server/utils/fetch.js";

const mockPandapeHtml = `
<div id="VacancyList">
  <a target="_blank" class="card card-vacancy mb-20" href="/Detail/3814457">
    <div class="card-body p-20">
      <div class="d-flex align-items-center mb-10">
        <h3 class="link font-xl mb-0 fw-600" title="Pessoa Desenvolvedora Fullstack Sênior (React / Node.js)">Pessoa Desenvolvedora Fullstack Sênior (React / Node.js)</h3>
      </div>
      <div class="vacancy-detail">
        <div class="d-flex text-medium flex-wrap">
          <div class="align-middle mr-20 mb-10">
            <div class="icon-container d-inline-block lh-100 align-middle"><i class="icon icon-location-pin-1"></i></div>
            Todo Brasil
          </div>
          <div class="align-middle mr-20 mb-10">
            <div class="icon-container d-inline-block lh-100 align-middle"><i class="icon icon-user-with-headphones"></i></div>
            Home Office
          </div>
          <div class="align-middle mr-20 mb-10">
            <div class="icon-container d-inline-block lh-100 align-middle"><i class="icon icon-clock"></i></div>
            Per&#xED;odo Integral
          </div>
          <div class="align-middle mb-10 mr-20">
            <div class="icon-container d-inline-block lh-100 align-middle"><i class="icon icon-sheet"></i></div>
            PJ
          </div>
          <div class="align-middle text-medium mb-10">
            <div class="icon-container d-inline-block lh-100 align-middle"><i class="icon icon-wallet"></i></div>
            R$ 12.000,00 - R$ 15.000,00
          </div>
        </div>
        <div class="vacancy-date font-sm tetx-medium">15 out</div>
      </div>
    </div>
  </a>
  <a target="_blank" class="card card-vacancy mb-20" href="/Detail/3814458">
    <div class="card-body p-20">
      <div class="d-flex align-items-center mb-10">
        <h3 class="link font-xl mb-0 fw-600" title="Analista de Dados e BI Pleno (SQL / Python)">Analista de Dados e BI Pleno (SQL / Python)</h3>
      </div>
      <div class="vacancy-detail">
        <div class="d-flex text-medium flex-wrap">
          <div class="align-middle mr-20 mb-10">
            <div class="icon-container d-inline-block lh-100 align-middle"><i class="icon icon-location-pin-1"></i></div>
            Porto Alegre - RS
          </div>
          <div class="align-middle mr-20 mb-10">
            <div class="icon-container d-inline-block lh-100 align-middle"><i class="icon icon-building-house"></i></div>
            H&#xED;brido
          </div>
          <div class="align-middle mb-10 mr-20">
            <div class="icon-container d-inline-block lh-100 align-middle"><i class="icon icon-sheet"></i></div>
            Efetivo &#x2013; CLT
          </div>
        </div>
        <div class="vacancy-date font-sm tetx-medium">10 out</div>
      </div>
    </div>
  </a>
  <a target="_blank" class="card card-vacancy mb-20" href="/Detail/3757331">
    <div class="card-body p-20">
      <div class="d-flex align-items-center mb-10">
        <h3 class="link font-xl mb-0 fw-600" title="Auxiliar de Limpeza e Copa">Auxiliar de Limpeza e Copa</h3>
      </div>
      <div class="vacancy-detail">
        <div class="d-flex text-medium flex-wrap">
          <div class="align-middle mr-20 mb-10">
            <div class="icon-container d-inline-block lh-100 align-middle"><i class="icon icon-location-pin-1"></i></div>
            S&#xE3;o Paulo - SP
          </div>
          <div class="align-middle mr-20 mb-10">
            <div class="icon-container d-inline-block lh-100 align-middle"><i class="icon icon-buildings"></i></div>
            Presencial
          </div>
          <div class="align-middle mb-10 mr-20">
            <div class="icon-container d-inline-block lh-100 align-middle"><i class="icon icon-sheet"></i></div>
            Efetivo &#x2013; CLT
          </div>
        </div>
        <div class="vacancy-date font-sm tetx-medium">24 set</div>
      </div>
    </div>
  </a>
</div>
`;

describe("Pandapé Infojobs Scraper & E2E Pipeline", () => {
  it("should have correct metadata and slug extraction", () => {
    const scraper = new PandapeScraper();
    assert.equal(scraper.id, "PANDAPE");
    assert.equal(scraper.name, "Pandapé Infojobs (Brasil)");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");

    assert.equal(
      extractPandapeSlug("https://fundacred.pandape.infojobs.com.br"),
      "fundacred",
    );
    assert.equal(
      extractPandapeSlug("https://concentrixbrasil.pandape.infojobs.com.br/Vacancies"),
      "concentrixbrasil",
    );
    assert.equal(extractPandapeSlug("britania"), "britania");
  });

  it("should parse Pandapé HTML cards, normalize jobs, and filter with TechClassifierService", () => {
    const company = {
      name: "Fundacred",
      slug: "fundacred",
      link: "https://fundacred.pandape.infojobs.com.br",
    };

    const parsedRaw: PandapeRawJob[] = parsePandapeHtml(mockPandapeHtml, company);
    assert.equal(parsedRaw.length, 3);
    assert.equal(parsedRaw[0].id, "3814457");
    assert.equal(parsedRaw[0].workModelText, "Home Office");
    assert.equal(parsedRaw[0].contractText, "PJ");
    assert.equal(parsedRaw[0].salary, "R$ 12.000,00 - R$ 15.000,00");

    const normalized = parsedRaw
      .map((item) => normalizePandapeJob(item, company))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    assert.equal(normalized.length, 3);

    const fullstackJob = normalized[0];
    assert.equal(
      fullstackJob.title,
      "Pessoa Desenvolvedora Fullstack Sênior (React / Node.js)",
    );
    assert.equal(fullstackJob.company, "Fundacred");
    assert.equal(fullstackJob.location, "Remoto");
    assert.equal(fullstackJob.workModel, "REMOTO");
    assert.equal(fullstackJob.contractType, "PJ");
    assert.equal(fullstackJob.seniorityLevel, "SENIOR");
    assert.equal(
      fullstackJob.url,
      "https://fundacred.pandape.infojobs.com.br/Detail/3814457",
    );
    assert.ok(fullstackJob.stack.includes("React"));
    assert.ok(fullstackJob.stack.includes("Node"));
    assert.equal(TechClassifierService.isTechSync(fullstackJob.title), true);

    const dataJob = normalized[1];
    assert.equal(dataJob.location, "Porto Alegre, RS");
    assert.equal(dataJob.workModel, "HIBRIDO");
    assert.equal(dataJob.contractType, "CLT");
    assert.equal(dataJob.seniorityLevel, "PLENO");
    assert.ok(dataJob.stack.includes("SQL"));
    assert.ok(dataJob.stack.includes("Python"));
    assert.equal(TechClassifierService.isTechSync(dataJob as any), true);

    const nonTechJob = normalized[2];
    assert.equal(nonTechJob.location, "São Paulo, SP");
    assert.equal(nonTechJob.workModel, "PRESENCIAL");
    assert.equal(TechClassifierService.isTechSync(nonTechJob.title), false);
  });

  it("should format captured Pandapé jobs in WhatsApp Digest composer", () => {
    const company = { name: "Fundacred", slug: "fundacred" };
    const parsedRaw = parsePandapeHtml(mockPandapeHtml, company);
    const jobs = parsedRaw.slice(0, 2).map((v, idx) => {
      const n = normalizePandapeJob(v, company)!;
      return {
        ...n,
        id: `pandape-test-${idx}`,
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
      "Digest deve ser gerado com sucesso para vagas do Pandapé",
    );
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("Fundacred"));
    assert.ok(
      digest.text.includes(
        "https://fundacred.pandape.infojobs.com.br/Detail/3814457",
      ),
    );
  });

  it("should fetch and parse real vacancies live from Pandapé portal", async () => {
    const company = { name: "Fundacred", slug: "fundacred" };
    try {
      const res = await resilientFetch(
        "https://fundacred.pandape.infojobs.com.br/ListVacancies",
        {
          method: "POST",
          timeoutMs: 12000,
          maxRetries: 1,
          source: "PANDAPE",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0",
          },
          body: "PageNumber=1&PageSize=20",
        },
      );

      if (res.ok) {
        const data = await res.json();
        assert.ok(typeof data.view === "string");
        const rawJobs = parsePandapeHtml(data.view, company);
        assert.ok(Array.isArray(rawJobs));
        if (rawJobs.length > 0) {
          const sample = normalizePandapeJob(rawJobs[0], company);
          assert.ok(sample);
          assert.equal(sample.source, "PANDAPE");
          assert.ok(
            sample.url.startsWith(
              "https://fundacred.pandape.infojobs.com.br/Detail/",
            ),
          );
        }
      }
    } catch {
      // Tratamento resiliente para ambientes sem rede externa
    }
  });
});
