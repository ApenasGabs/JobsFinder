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
});
