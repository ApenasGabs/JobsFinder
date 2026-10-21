import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { StorageService } from "../server/services/storage.js";
import { Job } from "../server/types.js";

describe("StorageService", () => {
  before(() => {
    StorageService.initialize();
  });

  it("should upsert a job and generate a unique id", () => {
    const jobData: Omit<Job, "id"> = {
      title: "Test InHire Vacancy",
      company: "Venturus",
      location: "Campinas, SP",
      workModel: "HIBRIDO",
      contractType: "CLT",
      seniorityLevel: "PLENO",
      url: "https://venturus.inhire.app/vagas/test-uuid-1",
      source: "INHIRE",
      stack: ["React", "Node"],
    };

    const { job, isNew } = StorageService.upsertJob(jobData);
    assert.ok(job.id);
    assert.equal(job.company, "Venturus");
    assert.equal(job.source, "INHIRE");
    assert.equal(typeof isNew, "boolean");
  });

  it("should filter jobs accurately by source (e.g. INHIRE and LEVER)", () => {
    // Insere vagas de teste de diferentes fontes
    StorageService.upsertJob({
      title: "Desenvolvedor InHire Teste",
      company: "Venturus",
      location: "Campinas",
      workModel: "REMOTO",
      contractType: "CLT",
      seniorityLevel: "SENIOR",
      url: "https://venturus.inhire.app/vagas/unit-test-inhire",
      source: "INHIRE",
      stack: ["Python"],
    });

    StorageService.upsertJob({
      title: "Desenvolvedor Lever Teste",
      company: "Aleph",
      location: "São Paulo",
      workModel: "REMOTO",
      contractType: "CLT",
      seniorityLevel: "SENIOR",
      url: "https://jobs.lever.co/aleph/unit-test-lever",
      source: "LEVER",
      stack: ["Java"],
    });

    const inhireResult = StorageService.getJobs({
      source: "INHIRE",
      pageSize: 100,
    });
    assert.ok(inhireResult.jobs.length > 0);
    assert.ok(
      inhireResult.jobs.every((j) => j.source === "INHIRE"),
      "Todas as vagas devem ter source INHIRE",
    );

    const leverResult = StorageService.getJobs({
      source: "LEVER",
      pageSize: 100,
    });
    assert.ok(leverResult.jobs.length > 0);
    assert.ok(
      leverResult.jobs.every((j) => j.source === "LEVER"),
      "Todas as vagas devem ter source LEVER",
    );
  });

  it("should search jobs by text across title, company, stack", () => {
    const searchResult = StorageService.getJobs({
      search: "Venturus",
      pageSize: 10,
    });
    assert.ok(searchResult.jobs.length > 0);
    assert.ok(searchResult.jobs.some((j) => j.company === "Venturus"));
  });

  it("should paginate correctly with total count and page slice", () => {
    const page1 = StorageService.getJobs({ pageSize: 5, page: 1 });
    assert.equal(page1.jobs.length, 5);
    assert.equal(page1.page, 1);
    assert.equal(page1.pageSize, 5);
    assert.ok(page1.total >= 5);
  });

  it("should return isNew === true on first insert and isNew === false on re-ingestion", () => {
    const testJob: Omit<Job, "id"> = {
      title: "Engenheiro de Dados Snowflake",
      company: "DataCorp Test",
      location: "Remoto",
      workModel: "REMOTO",
      contractType: "CLT",
      seniorityLevel: "SENIOR",
      url: "https://datacorp.test/jobs/snowflake-senior",
      source: "LEVER",
      stack: ["Snowflake", "SQL", "Python"],
    };

    const first = StorageService.upsertJob(testJob);
    assert.equal(first.isNew, true, "Primeira inserção deve retornar isNew === true");

    const second = StorageService.upsertJob(testJob);
    assert.equal(second.isNew, false, "Reingestão da mesma vaga deve retornar isNew === false");
    assert.equal(second.job.id, first.job.id, "ID deve ser idêntico");
  });

  it("should discard non-tech jobs returning isNew === false and isTech === false", () => {
    const nonTechJob: Omit<Job, "id"> = {
      title: "Auxiliar de Limpeza Hospitalar",
      company: "Hospital Saúde",
      location: "São Paulo, SP",
      workModel: "PRESENCIAL",
      contractType: "CLT",
      seniorityLevel: "NAO_INFORMADO",
      url: "https://hospital.test/vagas/limpeza-1",
      source: "GUPY",
      stack: [],
    };

    const result = StorageService.upsertJob(nonTechJob);
    assert.equal(result.isNew, false, "Vaga não-tech não deve ser considerada nova");
    assert.equal(result.job.isTech, false, "Vaga não-tech deve ter isTech === false");
  });

  it("should accurately collect and deduplicate new tech jobs in scheduler simulation", () => {
    // Simula eventos de varredura emitidos pelo Crawler
    const newJobsMap = new Map<string, Job>();

    const jobA: Job = {
      id: "job-tech-uuid-a",
      title: "Desenvolvedor Backend Node.js",
      company: "Tech Solutions",
      location: "Remoto",
      workModel: "REMOTO",
      contractType: "CLT",
      seniorityLevel: "PLENO",
      url: "https://tech.test/job/a",
      source: "GUPY",
      stack: ["Node.js", "TypeScript"],
      scrapedAt: new Date().toISOString(),
      isTech: true,
    };

    const jobB: Job = {
      id: "job-tech-uuid-b",
      title: "Engenheiro Frontend React",
      company: "WebCorp",
      location: "Remoto",
      workModel: "REMOTO",
      contractType: "PJ",
      seniorityLevel: "JUNIOR",
      url: "https://web.test/job/b",
      source: "ASHBY",
      stack: ["React"],
      scrapedAt: new Date().toISOString(),
      isTech: true,
    };

    const jobNonTech: Job = {
      id: "job-nontech-uuid",
      title: "Analista Financeiro Contábil",
      company: "FinCorp",
      location: "São Paulo",
      workModel: "PRESENCIAL",
      contractType: "CLT",
      seniorityLevel: "PLENO",
      url: "https://fin.test/job/c",
      source: "GUPY",
      stack: [],
      scrapedAt: new Date().toISOString(),
      isTech: false,
    };

    const simulatedEvents = [
      // 1. Vaga A encontrada pela primeira vez sob termo "node" (nova)
      { type: "job", job: jobA, isNew: true },
      // 2. Vaga A reencontrada sob termo "backend" (mesmo ID, isNew false)
      { type: "job", job: jobA, isNew: false },
      // 3. Vaga B encontrada pela primeira vez (nova)
      { type: "job", job: jobB, isNew: true },
      // 4. Vaga B reencontrada sob outro termo com isNew true por duplicate emitter
      { type: "job", job: jobB, isNew: true },
      // 5. Vaga Não-Tech
      { type: "job", job: jobNonTech, isNew: false },
    ];

    for (const event of simulatedEvents) {
      if (event.type === "job" && event.job && event.isNew) {
        if (event.job.isTech !== false) {
          newJobsMap.set(event.job.id, event.job);
        }
      }
    }

    const collected = Array.from(newJobsMap.values());
    assert.equal(collected.length, 2, "Apenas as 2 vagas de TI únicas devem ser coletadas");
    assert.deepEqual(collected.map((j) => j.id).sort(), ["job-tech-uuid-a", "job-tech-uuid-b"].sort());
  });
});
