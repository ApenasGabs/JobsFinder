import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WhatsAppBot } from "../server/bot/whatsapp.js";
import { Job } from "../server/types.js";

describe("WhatsApp Message Formatter (Digest Format)", () => {
  const sampleJobs: Job[] = [
    {
      id: "job-1",
      title: "Estágio em Engenharia de Software",
      company: "Cogna",
      location: "Macapá, AP, BR",
      workModel: "PRESENCIAL",
      contractType: "ESTAGIO",
      seniorityLevel: "ESTAGIO",
      url: "https://cogna.gupy.io/jobs/12213699",
      source: "GUPY",
      stack: ["Geral"],
      scrapedAt: new Date().toISOString(),
    },
    {
      id: "job-2",
      title: "Pessoa Desenvolvedora Fullstack Jr (React/Python)",
      company: "Venturus",
      location: "Manaus, AM, BR",
      workModel: "HIBRIDO",
      contractType: "CLT",
      seniorityLevel: "JUNIOR",
      url: "https://venturus.inhire.app/vagas/4682629d/fullstack",
      source: "INHIRE",
      stack: ["React", "Python"],
      scrapedAt: new Date().toISOString(),
    },
    {
      id: "job-3",
      title: "Analista de Desenvolvimento Back-end Java Jr",
      company: "Venturus",
      location: "Brasil",
      workModel: "REMOTO",
      contractType: "CLT",
      seniorityLevel: "JUNIOR",
      url: "https://venturus.inhire.app/vagas/70bb36c1/java",
      source: "INHIRE",
      stack: ["Java"],
      scrapedAt: new Date().toISOString(),
    },
    {
      id: "job-4",
      title: "Pessoa Desenvolvedora Android Jr",
      company: "Venturus",
      location: "São Paulo, SP",
      workModel: "REMOTO",
      contractType: "CLT",
      seniorityLevel: "JUNIOR",
      url: "https://venturus.inhire.app/vagas/0b43dbe8/android",
      source: "INHIRE",
      stack: ["Android"],
      scrapedAt: new Date().toISOString(),
    },
  ];

  it("should format a batch of jobs into the new clean digest format grouped by section", () => {
    const text = WhatsAppBot.formatBatchJobMessage(sampleJobs, "ESTAGIO");

    // Cabeçalho do digest de entrada
    assert.ok(text.includes("🎓 *ESTÁGIO, TRAINEE E JÚNIOR*"));
    assert.ok(text.includes("4 vagas novas"));

    // CTA comunitário no topo e no rodapé
    assert.ok(
      text.includes("🙋 *Mais empresas no radar = mais vagas pra todo mundo!*"),
    );
    assert.ok(text.includes("➕ Ajude a mapear empresas (leva 10 segundos):"));

    // Seções Remoto e Presencial / Híbrido
    assert.ok(text.includes("🏠 *Remoto*"));
    assert.ok(text.includes("📍 *Presencial / Híbrido*"));

    // Vagas formatadas com tag específica e sem [Geral]
    assert.ok(
      text.includes(
        "• Analista de Desenvolvimento Back-end Java Jr [Java] — Venturus",
      ),
    );
    assert.ok(
      text.includes(
        "• Pessoa Desenvolvedora Fullstack Jr (React/Python) [React] — Venturus · Manaus, AM (híbrido)",
      ),
    );
    assert.ok(!text.includes("[Geral]"));

    // Sem assinatura antiga e sem NAO_INFORMADO
    assert.ok(!text.includes("QueroVagas Crawler"));
    assert.ok(!text.includes("NAO_INFORMADO"));
  });

  it("should format a single job cleanly when called directly via formatBatchJobMessage", () => {
    const text = WhatsAppBot.formatBatchJobMessage([sampleJobs[0]], "ESTAGIO");
    assert.ok(text.includes("1 vaga nova"));
    assert.ok(
      text.includes("• Estágio em Engenharia de Software — Cogna · Macapá, AP"),
    );
    assert.ok(text.includes("https://cogna.gupy.io/jobs/12213699"));
  });
});
