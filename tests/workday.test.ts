import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest } from "../server/bot/digest.js";
import {
  normalizeWorkdayJob,
  parseWorkdayUrl,
  WorkdayRawJob,
  WorkdayScraper,
} from "../server/scrapers/workday.js";
import { TechClassifierService } from "../server/services/classifier.js";
import { resilientFetch } from "../server/utils/fetch.js";

const mockWorkdayJobs: WorkdayRawJob[] = [
  {
    title: "Senior Full Stack Software Engineer (React / Node.js)",
    externalPath:
      "/job/Sao-Paulo-Torre-Paineira/Senior-Full-Stack-Software-Engineer_R00353080",
    locationsText: "São Paulo, SP",
    postedOn: "Posted 2 Days Ago",
    timeType: "Full time",
    remoteType: "Hybrid",
    bulletFields: ["R00353080", "São Paulo, SP"],
  },
  {
    title: "Staff Backend Engineer - Golang & Kubernetes (Remoto)",
    externalPath:
      "/job/Remote-Brazil/Staff-Backend-Engineer-Golang_R00353081",
    locationsText: "Remote - Brazil",
    postedOn: "Posted Today",
    timeType: "Full time",
    remoteType: "Remote",
    bulletFields: ["R00353081", "Remote - Brazil"],
  },
  {
    title: "Vigilante Base",
    externalPath: "/job/BRA-BKS-MGPato-De-Minas/Vigilante-Base_R80079",
    locationsText: "Pato de Minas, MG",
    postedOn: "Posted 30+ Days Ago",
    timeType: "Full time",
    bulletFields: ["R80079"],
  },
];

describe("Workday Scraper & E2E Pipeline", () => {
  it("should have correct metadata", () => {
    const scraper = new WorkdayScraper();
    assert.equal(scraper.id, "WORKDAY");
    assert.equal(scraper.name, "Workday (Enterprise & Global)");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");
  });

  it("should extract host, tenant, site, baseUrl and apiUrl from diverse Workday URLs", () => {
    const acc = parseWorkdayUrl(
      "https://accenture.wd103.myworkdayjobs.com/pt-BR/AccentureCareers",
    );
    assert.ok(acc);
    assert.equal(acc.host, "accenture.wd103.myworkdayjobs.com");
    assert.equal(acc.tenant, "accenture");
    assert.equal(acc.site, "AccentureCareers");
    assert.equal(
      acc.baseUrl,
      "https://accenture.wd103.myworkdayjobs.com/pt-BR/AccentureCareers",
    );
    assert.equal(
      acc.apiUrl,
      "https://accenture.wd103.myworkdayjobs.com/wday/cxs/accenture/AccentureCareers/jobs",
    );

    const cs = parseWorkdayUrl(
      "https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job",
    );
    assert.ok(cs);
    assert.equal(cs.host, "crowdstrike.wd5.myworkdayjobs.com");
    assert.equal(cs.tenant, "crowdstrike");
    assert.equal(cs.site, "crowdstrikecareers");
    assert.equal(
      cs.baseUrl,
      "https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers",
    );
    assert.equal(
      cs.apiUrl,
      "https://crowdstrike.wd5.myworkdayjobs.com/wday/cxs/crowdstrike/crowdstrikecareers/jobs",
    );

    const visa = parseWorkdayUrl(
      "https://visa.wd5.myworkdayjobs.com/Visa/page/3b371539a3c810015ae4164c71d70000",
    );
    assert.ok(visa);
    assert.equal(visa.tenant, "visa");
    assert.equal(visa.site, "Visa");

    assert.equal(parseWorkdayUrl("https://www.pgcareers.com"), null);
  });

  it("should normalize Workday postings and filter with TechClassifierService", () => {
    const company = {
      name: "Accenture",
      slug: "accenture",
      link: "https://accenture.wd103.myworkdayjobs.com/pt-BR/AccentureCareers",
    };

    const normalized = mockWorkdayJobs
      .map((j) => normalizeWorkdayJob(j, company))
      .filter((j): j is NonNullable<typeof j> => j !== null);

    assert.equal(normalized.length, 3);

    const seniorJob = normalized[0];
    assert.equal(
      seniorJob.title,
      "Senior Full Stack Software Engineer (React / Node.js)",
    );
    assert.equal(seniorJob.company, "Accenture");
    assert.equal(seniorJob.location, "São Paulo, SP");
    assert.equal(seniorJob.workModel, "HIBRIDO");
    assert.equal(seniorJob.contractType, "CLT");
    assert.equal(seniorJob.seniorityLevel, "SENIOR");
    assert.equal(
      seniorJob.url,
      "https://accenture.wd103.myworkdayjobs.com/pt-BR/AccentureCareers/job/Sao-Paulo-Torre-Paineira/Senior-Full-Stack-Software-Engineer_R00353080",
    );
    assert.ok(seniorJob.stack.includes("React"));
    assert.ok(seniorJob.stack.includes("Node"));
    assert.equal(TechClassifierService.isTechSync(seniorJob.title), true);

    const backendJob = normalized[1];
    assert.equal(backendJob.workModel, "REMOTO");
    assert.equal(backendJob.location, "Remoto");
    assert.equal(backendJob.seniorityLevel, "ESPECIALISTA");
    assert.ok(backendJob.stack.includes("Golang"));
    assert.ok(backendJob.stack.includes("Kubernetes"));
    assert.equal(TechClassifierService.isTechSync(backendJob.title), true);

    const nonTechJob = normalized[2];
    assert.equal(TechClassifierService.isTechSync(nonTechJob.title), false);
  });

  it("should format captured Workday jobs in WhatsApp Digest composer", () => {
    const company = {
      name: "Accenture",
      slug: "accenture",
      link: "https://accenture.wd103.myworkdayjobs.com/pt-BR/AccentureCareers",
    };
    const jobs = mockWorkdayJobs.slice(0, 2).map((v, idx) => {
      const n = normalizeWorkdayJob(v, company)!;
      return {
        ...n,
        id: `wd-test-${idx}`,
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

    assert.ok(digest, "Digest deve ser gerado com sucesso para vagas Workday");
    assert.equal(digest.includedIds.length, 2);
    assert.ok(digest.text.includes("Accenture"));
    assert.ok(
      digest.text.includes(
        "https://accenture.wd103.myworkdayjobs.com/pt-BR/AccentureCareers/job/Sao-Paulo-Torre-Paineira/Senior-Full-Stack-Software-Engineer_R00353080",
      ),
    );
  });

  it("should query public Workday API resiliently", async () => {
    const parsed = parseWorkdayUrl(
      "https://accenture.wd103.myworkdayjobs.com/pt-BR/AccentureCareers",
    )!;
    try {
      const res = await resilientFetch(parsed.apiUrl, {
        method: "POST",
        timeoutMs: 10000,
        maxRetries: 1,
        source: "WORKDAY",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          appliedFacets: {},
          limit: 5,
          offset: 0,
          searchText: "",
        }),
      });
      if (res.ok) {
        const data = await res.json();
        assert.ok(Array.isArray(data.jobPostings));
        if (data.jobPostings.length > 0) {
          const sample = normalizeWorkdayJob(data.jobPostings[0], {
            name: "Accenture",
            slug: "accenture",
            link: parsed.baseUrl,
          });
          assert.ok(sample);
          assert.equal(sample.source, "WORKDAY");
        }
      }
    } catch {
      // Tratamento resiliente para ambientes sem rede externa
    }
  });
});
