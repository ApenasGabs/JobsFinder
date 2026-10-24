import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDigest,
  buildWeeklySummary,
  DEFAULT_RADAR_URL,
  DIGESTS,
  DigestJob,
  groupDuplicates,
  isBrazil,
  isExcludedFromDigest,
} from "../server/bot/digest.js";

describe("Digest Builder (digest.ts)", () => {
  const fixedNow = new Date("2026-10-23T15:00:00.000Z"); // 23/10 em America/Sao_Paulo

  function makeJob(overrides: Partial<DigestJob> & { id: string }): DigestJob {
    return {
      title: "Desenvolvedor(a) Fullstack Júnior",
      company: "Confitec",
      location: "São Paulo, SP",
      workModel: "REMOTO",
      seniority: "JUNIOR",
      seniorityLevel: "JUNIOR",
      stack: ["Java"],
      url: `https://example.gupy.io/jobs/${overrides.id}`,
      source: "GUPY",
      collectedAt: new Date("2026-10-23T12:00:00.000Z"),
      ...overrides,
    };
  }

  it("retorna null quando a quantidade de vagas elegíveis está abaixo de minJobs (regra do silêncio)", () => {
    const jobs = [
      makeJob({ id: "j1", title: "Dev Backend Jr", company: "Empresa A" }),
      makeJob({ id: "j2", title: "Dev Frontend Jr", company: "Empresa B" }),
    ];

    const res = buildDigest(jobs, {
      ...DIGESTS.entry.options,
      minJobs: 3,
      now: fixedNow,
    });

    assert.equal(res, null);
  });

  it("agrupa duplicatas da mesma empresa e título em diferentes cidades e inclui todos os IDs em includedIds", () => {
    const jobs = [
      makeJob({
        id: "palantir-sp",
        title: "Software Engineer",
        company: "Palantir",
        location: "São Paulo, SP",
        workModel: "PRESENCIAL",
      }),
      makeJob({
        id: "palantir-rj",
        title: "Software Engineer",
        company: "Palantir",
        location: "Rio de Janeiro, RJ",
        workModel: "PRESENCIAL",
      }),
      makeJob({
        id: "itau-1",
        title: "Analista de Dados Jr",
        company: "Itaú",
        location: "São Paulo, SP",
        workModel: "HIBRIDO",
      }),
      makeJob({
        id: "nubank-1",
        title: "Engenheiro de Software Jr",
        company: "Nubank",
        location: "Remoto",
        workModel: "REMOTO",
      }),
    ];

    const grouped = groupDuplicates(jobs);
    assert.equal(grouped.length, 3, "As 2 vagas da Palantir devem virar 1 grupo");

    const res = buildDigest(jobs, {
      ...DIGESTS.entry.options,
      minJobs: 3,
      now: fixedNow,
    });

    assert.ok(res, "Deve gerar digest pois há 3 grupos distintos");
    assert.ok(
      res.text.includes("São Paulo, SP / Rio de Janeiro, RJ"),
      "Deve exibir as duas localidades na mesma linha",
    );
    assert.ok(res.includedIds.includes("palantir-sp"));
    assert.ok(res.includedIds.includes("palantir-rj"));
    assert.equal(res.includedIds.length, 4);
  });

  it("exclui vagas de Empresa Confidencial / Confidential do digest", () => {
    const jobs = [
      makeJob({ id: "c1", company: "Empresa Confidencial", title: "Dev Java" }),
      makeJob({ id: "c2", company: "Confidential", title: "Dev Python" }),
      makeJob({ id: "ok1", company: "Creditas", title: "Dev Kotlin" }),
      makeJob({ id: "ok2", company: "Mercado Livre", title: "Dev Go" }),
    ];

    assert.equal(isExcludedFromDigest(jobs[0]), true);
    assert.equal(isExcludedFromDigest(jobs[1]), true);
    assert.equal(isExcludedFromDigest(jobs[2]), false);

    // Só restam 2 vagas válidas (< minJobs=3), então deve retornar null
    const resNull = buildDigest(jobs, {
      ...DIGESTS.entry.options,
      minJobs: 3,
      now: fixedNow,
    });
    assert.equal(resNull, null);

    // Adicionando uma 3ª vaga válida, gera o digest sem nenhuma menção a Confidencial
    const resOk = buildDigest(
      [...jobs, makeJob({ id: "ok3", company: "iFood", title: "Dev Node" })],
      {
        ...DIGESTS.entry.options,
        minJobs: 3,
        now: fixedNow,
      },
    );
    assert.ok(resOk);
    assert.ok(!/confidencial|confidential/i.test(resOk.text));
    assert.deepEqual(resOk.includedIds.sort(), ["ok1", "ok2", "ok3"]);
  });

  it("respeita truncamento por maxChars, mantém excedentes fora de includedIds e indica quantas ficam para o próximo envio", () => {
    const jobs: DigestJob[] = [];
    for (let i = 1; i <= 10; i++) {
      jobs.push(
        makeJob({
          id: `job-${i}`,
          title: `Pessoa Desenvolvedora Backend Stack #${i}`,
          company: `Empresa Tech ${i}`,
          url: `https://empresatech${i}.gupy.io/jobs/1000${i}`,
          collectedAt: new Date(fixedNow.getTime() - i * 60_000),
        }),
      );
    }

    const maxChars = 650;
    const res = buildDigest(jobs, {
      ...DIGESTS.entry.options,
      minJobs: 3,
      maxChars,
      now: fixedNow,
    });

    assert.ok(res, "Deve gerar digest truncado dentro do orçamento");
    assert.ok(
      res.text.length <= maxChars,
      `Texto gerado (${res.text.length} chars) não pode exceder maxChars (${maxChars})`,
    );
    assert.ok(res.includedIds.length > 0 && res.includedIds.length < 10);
    assert.equal(res.omitted, 10 - res.includedIds.length);
    assert.ok(
      res.text.includes(`⏭️ +${res.omitted} vagas ficam para o próximo envio`),
    );

    // As excedentes NÃO podem estar em includedIds
    for (let i = res.includedIds.length + 1; i <= 10; i++) {
      assert.ok(
        !res.includedIds.includes(`job-${i}`),
        `job-${i} excedente não deve entrar em includedIds`,
      );
    }
  });

  it("separa vagas expiradas (> maxAgeDays) em expiredIds e não as inclui no texto nem em includedIds", () => {
    const sixDaysAgo = new Date(fixedNow.getTime() - 6 * 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(fixedNow.getTime() - 2 * 24 * 60 * 60 * 1000);

    const jobs = [
      makeJob({
        id: "expired-1",
        company: "Velha Corp",
        title: "Dev Cobol",
        collectedAt: sixDaysAgo,
      }),
      makeJob({
        id: "expired-2",
        company: "Antiga SA",
        title: "Dev Delphi",
        scrapedAt: sixDaysAgo.toISOString(),
        collectedAt: undefined,
      }),
      makeJob({
        id: "fresh-1",
        company: "Nova 1",
        title: "Dev TypeScript",
        collectedAt: twoDaysAgo,
      }),
      makeJob({
        id: "fresh-2",
        company: "Nova 2",
        title: "Dev Python",
        collectedAt: fixedNow,
      }),
      makeJob({
        id: "fresh-3",
        company: "Nova 3",
        title: "Dev Go",
        collectedAt: fixedNow,
      }),
    ];

    const res = buildDigest(jobs, {
      ...DIGESTS.entry.options,
      minJobs: 3,
      maxAgeDays: 5,
      now: fixedNow,
    });

    assert.ok(res);
    assert.deepEqual(res.expiredIds.sort(), ["expired-1", "expired-2"]);
    assert.ok(!res.includedIds.includes("expired-1"));
    assert.ok(!res.includedIds.includes("expired-2"));
    assert.ok(!res.text.includes("Velha Corp"));
    assert.ok(!res.text.includes("Antiga SA"));
  });

  it("exibe CTA no topo e no rodapé, nunca contém NAO_INFORMADO e nunca convida a ver vagas no portal", () => {
    const jobs = [
      makeJob({
        id: "n1",
        title: "Desenvolvedor(a) Backend NAO_INFORMADO",
        company: "Totvs",
        location: "NAO_INFORMADO",
        workModel: "NAO_INFORMADO",
        seniority: "NAO_INFORMADO",
        stack: ["Geral", "NAO_INFORMADO"],
      }),
      makeJob({
        id: "n2",
        title: "Analista de Dados",
        company: "Itaú",
        location: "São Paulo, SP, BR",
        workModel: "HIBRIDO",
        stack: ["Python"],
      }),
      makeJob({
        id: "n3",
        title: "Engenheiro(a) Frontend",
        company: "B3",
        location: "Remoto",
        workModel: "REMOTO",
        stack: null,
      }),
    ];

    const res = buildDigest(jobs, {
      ...DIGESTS.entry.options,
      radarUrl: DEFAULT_RADAR_URL,
      minJobs: 3,
      now: fixedNow,
    });

    assert.ok(res);

    // 1. CTA no topo (antes das seções de vagas) e no rodapé
    const topCtaIndex = res.text.indexOf(
      "🙋 *Mais empresas no radar = mais vagas pra todo mundo!*",
    );
    const firstSectionIndex = res.text.indexOf("🏠 *Remoto*");
    const bottomCtaIndex = res.text.indexOf(
      "➕ Ajude a mapear empresas (leva 10 segundos):",
    );

    assert.ok(topCtaIndex > 0, "CTA do topo deve estar presente");
    assert.ok(
      topCtaIndex < firstSectionIndex,
      "CTA do topo deve aparecer antes da lista de vagas",
    );
    assert.ok(
      bottomCtaIndex > firstSectionIndex,
      "CTA do rodapé deve aparecer no final da mensagem",
    );

    // 2. Higiene estrita: nunca contém NAO_INFORMADO, [Geral] ou assinatura antiga
    assert.ok(
      !/NAO_INFORMADO/i.test(res.text),
      "Nunca deve conter NAO_INFORMADO",
    );
    assert.ok(!/\[Geral\]/i.test(res.text), "Nunca deve exibir tag [Geral]");
    assert.ok(
      !/QueroVagas Crawler/i.test(res.text),
      "Nunca deve conter assinatura QueroVagas Crawler",
    );

    // 3. Regra de produto: NUNCA convidar a ver vagas no portal / filtros / vitrine
    assert.ok(
      !/ver mais vagas|mais vagas no portal|acesse as vagas|filtros no portal|vitrine|dashboard web/i.test(
        res.text,
      ),
      "Nunca deve mandar o usuário ver vagas no portal",
    );

    // 4. Formatação de híbrido e tag específica
    assert.ok(res.text.includes("• Analista de Dados [Python] — Itaú · São Paulo, SP (híbrido)"));
  });

  it("insere uma linha em branco (\\n\\n) entre uma vaga e outra dentro da mesma seção", () => {
    const jobs = [
      makeJob({
        id: "r1",
        title: "Desenvolvedor Backend Java",
        company: "Empresa Um",
        workModel: "REMOTO",
        stack: ["Java"],
        url: "https://empresa1.gupy.io/jobs/1",
      }),
      makeJob({
        id: "r2",
        title: "Desenvolvedor Frontend React",
        company: "Empresa Dois",
        workModel: "REMOTO",
        stack: ["React"],
        url: "https://empresa2.gupy.io/jobs/2",
      }),
      makeJob({
        id: "r3",
        title: "Engenheiro DevOps",
        company: "Empresa Três",
        workModel: "REMOTO",
        stack: ["AWS"],
        url: "https://empresa3.gupy.io/jobs/3",
      }),
    ];

    const res = buildDigest(jobs, {
      ...DIGESTS.entry.options,
      minJobs: 1,
      now: fixedNow,
    });

    assert.ok(res);
    assert.ok(
      res.text.includes(
        "https://empresa1.gupy.io/jobs/1\n\n• Desenvolvedor Frontend React",
      ) ||
        res.text.includes(
          "https://empresa2.gupy.io/jobs/2\n\n• Desenvolvedor Backend Java",
        ),
      "Deve haver uma linha em branco (\\n\\n) separando uma vaga da seguinte",
    );
  });

  it("classifica corretamente localidades no Brasil vs Exterior (isBrazil)", () => {
    assert.equal(isBrazil("São Paulo, SP"), true);
    assert.equal(isBrazil("Macapá, AP, BR"), true);
    assert.equal(isBrazil("Remoto"), true);
    assert.equal(isBrazil("Brasil"), true);
    assert.equal(isBrazil("London, United Kingdom"), false);
    assert.equal(isBrazil("New York, NY"), false);
  });

  it("gera o resumo semanal de domingo omitindo itens sem dados confiáveis e agradecendo quem sugeriu", () => {
    const text = buildWeeklySummary({
      monitoredCompaniesCount: 312,
      weeklyTechJobsCount: 84,
      newSuggestions: [
        { name: "Azion", suggestedBy: "@gabriel" },
        { name: "Cora", suggestedBy: "Membro da Comunidade" },
      ],
      topVotedSuggestions: [
        { name: "Brex", votesCount: 9 },
        { name: "Stripe", votesCount: 15 },
        { name: "Vercel", votesCount: 4 },
        { name: "Quarta Empresa", votesCount: 2 },
      ],
      radarUrl: DEFAULT_RADAR_URL,
      now: fixedNow,
    });

    assert.ok(text);
    assert.ok(text.includes("312"));
    assert.ok(text.includes("84"));
    assert.ok(text.includes("• Azion _(sugerida por @gabriel — valeu! 🙌)_"));
    assert.ok(
      text.includes("• Cora\n") || text.endsWith("• Cora"),
      "Não deve agradecer placeholder genérico 'Membro da Comunidade'",
    );
    // Top 3 ordenadas por votos (Stripe 15, Brex 9, Vercel 4)
    assert.ok(text.includes("🥇 Stripe — *15 votos*"));
    assert.ok(text.includes("🥈 Brex — *9 votos*"));
    assert.ok(text.includes("🥉 Vercel — *4 votos*"));
    assert.ok(!text.includes("Quarta Empresa"));
    assert.ok(!/NAO_INFORMADO/i.test(text));
    assert.ok(!/ver mais vagas/i.test(text));

    // Quando não há nenhum dado confiável, retorna null
    const empty = buildWeeklySummary({
      monitoredCompaniesCount: 0,
      weeklyTechJobsCount: null,
      newSuggestions: [],
      topVotedSuggestions: [],
    });
    assert.equal(empty, null);
  });
});
