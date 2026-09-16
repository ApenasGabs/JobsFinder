import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WhatsAppBot } from "../server/bot/whatsapp.js";
import { Job } from "../server/types.js";

describe("WhatsApp Message Formatter", () => {
  const sampleJobs: Job[] = [
    {
      id: "job-1",
      title: "Monitor(a) de Estágio – Enfermagem",
      company: "Cogna",
      location: "Macapá, AP, BR",
      workModel: "PRESENCIAL",
      contractType: "CLT",
      seniorityLevel: "ESTAGIO",
      url: "https://cogna.gupy.io/jobs/12213699",
      source: "GUPY",
      stack: ["Enfermagem"],
      scrapedAt: new Date().toISOString(),
    },
    {
      id: "job-2",
      title: "Pessoa Desenvolvedora Fullstack Pl (React/Python)",
      company: "Venturus",
      location: "Manaus, AM, BR",
      workModel: "HIBRIDO",
      contractType: "CLT",
      seniorityLevel: "ESTAGIO",
      url: "https://venturus.inhire.app/vagas/4682629d/fullstack",
      source: "INHIRE",
      stack: ["React", "Python"],
      scrapedAt: new Date().toISOString(),
    },
    {
      id: "job-3",
      title: "Analista de Desenvolvimento Back-end Java Pl (Remoto)",
      company: "Venturus",
      location: "Brasil",
      workModel: "REMOTO",
      contractType: "CLT",
      seniorityLevel: "ESTAGIO",
      url: "https://venturus.inhire.app/vagas/70bb36c1/java",
      source: "INHIRE",
      stack: ["Java"],
      scrapedAt: new Date().toISOString(),
    },
    {
      id: "job-4",
      title: "Pessoa Desenvolvedora Android Sr",
      company: "Venturus",
      location: "São Paulo, SP",
      workModel: "REMOTO",
      contractType: "CLT",
      seniorityLevel: "ESTAGIO",
      url: "https://venturus.inhire.app/vagas/0b43dbe8/android",
      source: "INHIRE",
      stack: ["Android"],
      scrapedAt: new Date().toISOString(),
    },
  ];

  it("should format a batch of 4 jobs into a single consolidated message", () => {
    const text = WhatsAppBot.formatBatchJobMessage(sampleJobs, "ESTAGIO");

    // Deve ter cabeçalho de lote
    assert.ok(text.includes("4 NOVAS VAGAS — ESTAGIO"));

    // Deve ter numeração por emoji
    assert.ok(text.includes("1️⃣ *Monitor(a) de Estágio – Enfermagem*"));
    assert.ok(
      text.includes("2️⃣ *Pessoa Desenvolvedora Fullstack Pl (React/Python)*"),
    );
    assert.ok(
      text.includes(
        "3️⃣ *Analista de Desenvolvimento Back-end Java Pl (Remoto)*",
      ),
    );
    assert.ok(text.includes("4️⃣ *Pessoa Desenvolvedora Android Sr*"));

    // Links diretos
    assert.ok(text.includes("🔗 https://cogna.gupy.io/jobs/12213699"));
    assert.ok(
      text.includes("🔗 https://venturus.inhire.app/vagas/4682629d/fullstack"),
    );

    // Destaques / skim rápido no topo
    assert.ok(text.includes("📌 *Foco:*"));
    assert.ok(text.includes("📍 *Locais:*"));

    // Rodapé único consolidado
    assert.ok(text.includes("QueroVagas Crawler"));
    assert.ok(text.includes("GUPY, INHIRE") || text.includes("INHIRE"));

    // Não deve conter traços repetidos por vaga
    const dashesCount = (text.match(/───/g) || []).length;
    assert.equal(
      dashesCount,
      0,
      "Não deve conter separadores de traço poluídos",
    );
  });

  it("should format a single job cleanly when batch size is 1", () => {
    const text = WhatsAppBot.formatBatchJobMessage([sampleJobs[0]], "ESTAGIO");
    assert.ok(text.includes("1 NOVA VAGA — ESTAGIO"));
    assert.ok(text.includes("1️⃣ *Monitor(a) de Estágio – Enfermagem*"));
    assert.ok(text.includes("🔗 https://cogna.gupy.io/jobs/12213699"));
  });
});
