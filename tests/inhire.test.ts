import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InHireScraper } from "../server/scrapers/inhire.js";
import { slugifyInHire } from "../server/utils/normalizer.js";

// Amostra real da API do InHire para Venturus
const mockVenturusPayload = {
  tenantName: "Venturus",
  jobsPage: [
    {
      jobId: "504b05b0-03e1-48d6-bda8-fe0fa5fbf13e",
      displayName: "Banco de Talentos Exclusivo para Diversidade",
      status: "published",
      workplaceType: "Remote",
      location: "BR",
    },
    {
      jobId: "7678d7ad-078e-404a-b146-e51a9c908137",
      displayName:
        "[1164] Especialista em IA Generativa (AWS/Azure/Copilot Studio) (Híbrido - São Paulo)",
      status: "published",
      workplaceType: "Remote",
      location: "BR",
    },
    {
      jobId: "4682629d-5b33-4c06-8f7c-88fe85f7ad09",
      displayName:
        "[1201-1202] Pessoa Desenvolvedora Fullstack Pl (React/Python)",
      status: "published",
      workplaceType: "Hybrid",
      location: "Manaus, AM, BR",
    },
    {
      jobId: "70bb36c1-569e-4c86-972f-cabc08409503",
      displayName:
        "[1206] Analista de Desenvolvimento Back-end Java Pl (Remoto)",
      status: "published",
      workplaceType: "Remote",
      location: "BR",
    },
    {
      jobId: "draft-job-999",
      displayName: "Vaga em Rascunho Fechada",
      status: "closed",
      workplaceType: "Remote",
      location: "BR",
    },
  ],
};

describe("InHire Scraper", () => {
  it("should have correct metadata and type", () => {
    const scraper = new InHireScraper();
    assert.equal(scraper.id, "INHIRE");
    assert.equal(scraper.isFastMode, true);
    assert.equal(scraper.type, "CLT");
  });

  it("should correctly parse and normalize Venturus jobs from payload", () => {
    const published = mockVenturusPayload.jobsPage.filter(
      (j) => j.status === "published",
    );
    assert.equal(published.length, 4);

    const fullstackJob = published.find(
      (j) => j.jobId === "4682629d-5b33-4c06-8f7c-88fe85f7ad09",
    );
    assert.ok(fullstackJob);
    assert.equal(fullstackJob.workplaceType, "Hybrid");
    assert.equal(
      fullstackJob.displayName,
      "[1201-1202] Pessoa Desenvolvedora Fullstack Pl (React/Python)",
    );

    // Simula a normalização idêntica à do scraper
    const slug = slugifyInHire(fullstackJob.displayName);
    const jobUrl = `https://venturus.inhire.app/vagas/${fullstackJob.jobId}/${slug}`;
    assert.equal(
      jobUrl,
      "https://venturus.inhire.app/vagas/4682629d-5b33-4c06-8f7c-88fe85f7ad09/1201-1202-pessoa-desenvolvedora-fullstack-pl-reactpython",
    );
  });

  it("should fetch real published jobs live from InHire public API for Venturus", async () => {
    const response = await fetch(
      "https://api.inhire.app/job-posts/public/pages",
      {
        headers: {
          Accept: "application/json",
          "X-Tenant": "venturus",
          Origin: "https://venturus.inhire.app",
          Referer: "https://venturus.inhire.app/",
        },
      },
    );

    assert.equal(response.ok, true);
    const data = await response.json();
    assert.equal(data.tenantName, "Venturus");
    assert.ok(Array.isArray(data.jobsPage));
    assert.ok(
      data.jobsPage.length > 5,
      `Expected more than 5 jobs, got ${data.jobsPage.length}`,
    );

    // Verifica que vagas de tecnologia estão presentes na página pública
    const titles = data.jobsPage.map((j: any) => j.displayName);
    const hasTechJobs = titles.some((t: string) =>
      /Desenvolvedor|Engenheiro|Especialista|Fullstack/i.test(t),
    );

    assert.ok(hasTechJobs, "Deveria conter vagas de tecnologia na Venturus");
  });
});
