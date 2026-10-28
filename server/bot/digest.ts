/**
 * digest.ts — Formata um digest de vagas por categoria e o resumo semanal para o WhatsApp.
 *
 * Função pura: recebe vagas/estatísticas, devolve texto. Não envia nada, não toca no banco.
 *
 * IMPORTANTE (produto): o QueroVagas NÃO exibe vagas publicamente. O portal mostra
 * apenas o Radar de Empresas (empresas monitoradas + sugestão + votos). As vagas
 * chegam às pessoas pelo WhatsApp (e por distribuição autorizada a grupos/faculdades).
 * Por isso o texto NUNCA manda "ver mais vagas no portal": o portal serve para
 * AJUDAR A MAPEAR EMPRESAS, e é só isso que o CTA pede.
 */

import type {
  ContractType,
  SeniorityLevel,
  WorkModel as InternalWorkModel,
} from "../types.js";
import { detectSeniority } from "../utils/normalizer.js";

export type Seniority = SeniorityLevel;
export type WorkModel = InternalWorkModel;

export interface DigestJob {
  id: string;
  title: string;
  company: string;
  location: string; // "São Paulo, SP", "Brazil", "London, United Kingdom", "Remoto"
  workModel: WorkModel;
  /** Suporta tanto `seniority` (referência) quanto `seniorityLevel` (JobsFinder) */
  seniority?: Seniority;
  seniorityLevel?: SeniorityLevel;
  contractType?: ContractType;
  /** Suporta `string[]` (JobsFinder) ou `string | null` (referência) */
  stack?: string[] | string | null;
  url: string;
  source: string; // GUPY, LEVER...
  /** Suporta `collectedAt: Date` (referência) ou `scrapedAt: string` (JobsFinder) */
  collectedAt?: Date | string;
  scrapedAt?: string;
  isTech?: boolean;
}

export type Job = DigestJob;

export interface DigestOptions {
  /** Título da mensagem, ex.: "ESTÁGIO, TRAINEE E JÚNIOR" */
  title: string;
  /** Emoji do cabeçalho */
  emoji: string;
  /** Link do Radar de Empresas (QueroVagas) */
  radarUrl: string;
  /** Máximo de vagas por seção */
  maxPerSection?: number;
  /** Máximo de vagas na mensagem inteira */
  maxTotal?: number;
  /** Orçamento de caracteres da mensagem (default ~4000, configurável) */
  maxChars?: number;
  /** Incluir seção "Exterior"? Para estágio/júnior costuma ser melhor false. */
  includeAbroad?: boolean;
  /** Abaixo disso, não gera mensagem (retorna null) */
  minJobs?: number;
  /** Vagas coletadas há mais dias que isso são descartadas do digest */
  maxAgeDays?: number;
  now?: Date;
}

const BR_UF = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
  "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

const BR_STATES_NORMALIZED = [
  "distrito federal",
  "espirito santo",
  "mato grosso do sul",
  "mato grosso",
  "minas gerais",
  "rio de janeiro",
  "rio grande do norte",
  "rio grande do sul",
  "santa catarina",
  "sao paulo",
  "acre",
  "alagoas",
  "amapa",
  "amazonas",
  "bahia",
  "ceara",
  "goias",
  "maranhao",
  "paraiba",
  "parana",
  "para",
  "pernambuco",
  "piaui",
  "rondonia",
  "roraima",
  "sergipe",
  "tocantins",
];

const HIDDEN_COMPANIES = [
  /confidencial/i,
  /confidential/i,
  /^empresa n[aã]o informada$/i,
  /^nao[_\s]?informado$/i,
];

/* ------------------------------ helpers ------------------------------ */

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isBrazil(location: string): boolean {
  const loc = (location || "").trim();
  if (!loc) return true;
  if (/brasil|brazil|remoto|remote|diversos|nao[_\s]?informado/i.test(loc)) {
    return true;
  }
  // Se for código ou nome do país isolado
  if (/^(?:br|bra|brasil|brazil)$/i.test(loc)) {
    return true;
  }
  // Se termina com ", BR", "- BR", "/ BR", ", Brasil", etc.
  if (/(?:,|-|\/)\s*(?:BR|Brasil)$/i.test(loc)) {
    const withoutCountry = loc.replace(/(?:,|-|\/)\s*(?:BR|Brasil)$/i, "").trim();
    const mCountry = withoutCountry.match(/(?:,|-|\/)\s*([A-Z]{2})$/);
    if (mCountry) return BR_UF.has(mCountry[1]);
    return true;
  }
  // Sigla UF de 2 letras maiúsculas: "Belo Horizonte, MG" ou "São Paulo - SP"
  const m = loc.match(/(?:,|-|\/)\s*([A-Z]{2})$/);
  if (m && BR_UF.has(m[1])) return true;

  // Reconhece estados brasileiros por extenso e capital Brasília
  const nLoc = norm(loc);
  if (/\bbrasilia\b/i.test(nLoc)) {
    return true;
  }
  for (const state of BR_STATES_NORMALIZED) {
    const re = new RegExp(`(^|\\s)${state}(\\s|$)`, "i");
    if (re.test(nLoc)) {
      return true;
    }
  }

  return false;
}

/** Vagas que não devem ir ao grupo (dado ruim / sem empresa identificável). Continuam no banco. */
export function isExcludedFromDigest(job: DigestJob): boolean {
  const company = (job.company || "").trim();
  if (!company) return true;
  return HIDDEN_COMPANIES.some((r) => r.test(company));
}

type Section = "REMOTO" | "PRESENCIAL" | "EXTERIOR";

function sectionOf(job: DigestJob): Section {
  if (!isBrazil(job.location)) return "EXTERIOR";
  if (job.workModel === "REMOTO") return "REMOTO";
  return "PRESENCIAL"; // híbrido, presencial ou não informado com cidade
}

export interface Grouped {
  job: DigestJob; // representante
  locations: string[]; // todas as localidades do grupo
  ids: string[]; // todos os ids do grupo (marcados como enviados juntos)
}

function sanitizeLocation(loc: string): string {
  const cleaned = (loc || "")
    .replace(/\bNAO_INFORMADO\b/gi, "")
    .replace(/,\s*(?:BR|Brasil)$/i, "")
    .trim();
  if (!cleaned || norm(cleaned) === "nao informado") return "";
  return cleaned;
}

/** Une a mesma vaga em várias cidades (ex.: Palantir London + New York). */
export function groupDuplicates(jobs: DigestJob[]): Grouped[] {
  const map = new Map<string, Grouped>();
  for (const job of jobs) {
    const key = `${norm(job.company)}|${norm(job.title)}`;
    const loc = sanitizeLocation(job.location);
    const g = map.get(key);
    if (!g) {
      map.set(key, {
        job,
        locations: loc ? [loc] : [],
        ids: [job.id],
      });
    } else {
      if (loc && !g.locations.includes(loc)) g.locations.push(loc);
      if (!g.ids.includes(job.id)) g.ids.push(job.id);
    }
  }
  return [...map.values()];
}

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(d);
}

function cleanTitle(title: string): string {
  return (title || "")
    .replace(/\bNAO_INFORMADO\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[|\s]+$/g, "")
    .trim();
}

function resolvePrimaryStack(stack?: string[] | string | null): string | null {
  if (!stack) return null;
  if (Array.isArray(stack)) {
    for (const item of stack) {
      const s = (item || "").trim();
      if (s && norm(s) !== "geral" && norm(s) !== "nao informado") {
        return s;
      }
    }
    return null;
  }
  const s = stack.trim();
  if (!s || norm(s) === "geral" || norm(s) === "nao informado") return null;
  return s;
}

function formatItem(g: Grouped, section: Section): string {
  const { job, locations } = g;
  const primaryStack = resolvePrimaryStack(job.stack);
  const tag = primaryStack ? ` [${primaryStack}]` : "";
  const validLocations = locations.filter(
    (l) => l && norm(l) !== "nao informado" && norm(l) !== "remoto",
  );
  const where =
    section === "REMOTO" || validLocations.length === 0
      ? ""
      : ` · ${validLocations.slice(0, 2).join(" / ")}${validLocations.length > 2 ? ` +${validLocations.length - 2}` : ""}`;
  const model =
    section === "PRESENCIAL" && job.workModel === "HIBRIDO" ? " (híbrido)" : "";
  const cleanCompany = (job.company || "").replace(/\bNAO_INFORMADO\b/gi, "").trim();
  return `• ${cleanTitle(job.title)}${tag} — ${cleanCompany}${where}${model}\n  ${job.url}`;
}

const SECTION_HEADER: Record<Section, string> = {
  REMOTO: "🏠 *Remoto*",
  PRESENCIAL: "📍 *Presencial / Híbrido*",
  EXTERIOR: "🌎 *Exterior*",
};

/* ------------------------------ CTA ------------------------------ */

/**
 * CTA logo no topo: no WhatsApp, mensagens longas aparecem cortadas ("Ler mais"),
 * então só as primeiras linhas são vistas por todo mundo. O pedido de ajuda fica ali.
 */
function topCta(radarUrl: string): string {
  return [
    "🙋 *Mais empresas no radar = mais vagas pra todo mundo!*",
    `Faltou a sua? Cole o link de carreiras e o bot passa a vigiar: ${radarUrl}`,
  ].join("\n");
}

/** Reforço curto no fim, para quem leu tudo. */
function bottomCta(radarUrl: string): string {
  return `─────────────\n➕ Ajude a mapear empresas (leva 10 segundos): ${radarUrl}`;
}

function getJobTimestamp(job: DigestJob): number | null {
  if (job.collectedAt instanceof Date) {
    const t = job.collectedAt.getTime();
    return Number.isNaN(t) ? null : t;
  }
  const raw =
    typeof job.collectedAt === "string" ? job.collectedAt : job.scrapedAt;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? null : t;
}

/* ------------------------------ principal ------------------------------ */

export interface DigestResult {
  text: string;
  /** IDs das vagas que entraram na mensagem (marque como enviadas SÓ estas) */
  includedIds: string[];
  /** Quantas ficaram de fora (continuam pendentes para o próximo envio) */
  omitted: number;
  /** IDs expirados (mais velhos que maxAgeDays): pode marcar como descartados */
  expiredIds: string[];
}

function composeDigestText(params: {
  emoji: string;
  title: string;
  now: Date;
  used: number;
  top: string;
  blocks: string[];
  omitted: number;
  bottom: string;
}): string {
  const { emoji, title, now, used, top, blocks, omitted, bottom } = params;
  const header = `${emoji} *${title}* — ${formatDate(now)}\n${used} ${used === 1 ? "vaga nova" : "vagas novas"}`;
  const more =
    omitted > 0
      ? `\n\n⏭️ +${omitted} ${omitted === 1 ? "vaga fica" : "vagas ficam"} para o próximo envio`
      : "";
  return `${header}\n\n${top}\n\n${blocks.join("\n\n")}${more}\n\n${bottom}`;
}

export function buildDigest(
  jobs: DigestJob[],
  opts: DigestOptions,
): DigestResult | null {
  const {
    title,
    emoji,
    radarUrl,
    maxPerSection = 15,
    maxTotal = 25,
    maxChars = 4000,
    includeAbroad = false,
    minJobs = 3,
    maxAgeDays = 5,
    now = new Date(),
  } = opts;

  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const expiredIds: string[] = [];
  const fresh = jobs.filter((j) => {
    const ts = getJobTimestamp(j);
    if (ts !== null && ts < cutoff) {
      expiredIds.push(j.id);
      return false;
    }
    return true;
  });

  // Mais recentes primeiro
  fresh.sort((a, b) => (getJobTimestamp(b) ?? 0) - (getJobTimestamp(a) ?? 0));

  const eligible = fresh.filter((j) => !isExcludedFromDigest(j));
  const grouped = groupDuplicates(eligible);

  const bySection: Record<Section, Grouped[]> = {
    REMOTO: [],
    PRESENCIAL: [],
    EXTERIOR: [],
  };
  for (const g of grouped) bySection[sectionOf(g.job)].push(g);

  const sections: Section[] = [
    "REMOTO",
    "PRESENCIAL",
    ...(includeAbroad ? (["EXTERIOR"] as const) : []),
  ];
  const totalCandidates = sections.reduce((n, s) => n + bySection[s].length, 0);
  if (totalCandidates < minJobs) return null;

  const top = topCta(radarUrl);
  const bottom = bottomCta(radarUrl);

  const included: string[] = [];
  const blocks: string[] = [];
  let used = 0;

  for (const s of sections) {
    const lines: string[] = [];
    for (const g of bySection[s].slice(0, maxPerSection)) {
      if (used >= maxTotal) break;
      const item = formatItem(g, s);
      const nextUsed = used + 1;
      const nextOmitted = totalCandidates - nextUsed;
      const candidateSectionBlock = `${SECTION_HEADER[s]}\n${[...lines, item].join("\n\n")}`;
      const candidateBlocks = [...blocks, candidateSectionBlock];
      const candidateText = composeDigestText({
        emoji,
        title,
        now,
        used: nextUsed,
        top,
        blocks: candidateBlocks,
        omitted: nextOmitted,
        bottom,
      });

      if (candidateText.length > maxChars) break;

      lines.push(item);
      used = nextUsed;
      included.push(...g.ids);
    }
    if (lines.length) {
      blocks.push(`${SECTION_HEADER[s]}\n${lines.join("\n\n")}`);
    }
  }

  if (used === 0) return null;

  const omitted = totalCandidates - used;
  const text = composeDigestText({
    emoji,
    title,
    now,
    used,
    top,
    blocks,
    omitted,
    bottom,
  });

  return {
    text,
    includedIds: [...new Set(included)],
    omitted,
    expiredIds,
  };
}

/* ------------------------------ resumo semanal ------------------------------ */

export interface WeeklySuggestionItem {
  name: string;
  suggestedBy?: string | null;
  votesCount?: number | null;
  createdAt?: string | Date | null;
}

export interface WeeklySummaryOptions {
  /** Nº de empresas vigiadas no radar */
  monitoredCompaniesCount?: number | null;
  /** Nº de vagas de TI encontradas na semana */
  weeklyTechJobsCount?: number | null;
  /** Empresas novas sugeridas pela comunidade na semana */
  newSuggestions?: WeeklySuggestionItem[];
  /** Sugestões comunitárias para ranking das top 3 mais votadas */
  topVotedSuggestions?: WeeklySuggestionItem[];
  /** Link do Radar de Empresas */
  radarUrl?: string;
  now?: Date;
  /** Vagas da semana para curadoria e compartilhamento */
  weeklyJobs?: DigestJob[];
  /** Limite máximo de vagas por categoria (padrão 5) */
  maxJobsPerCategory?: number;
  /** Limite máximo de caracteres da mensagem (padrão 4000) */
  maxChars?: number;
}

export interface WeeklySummaryResult {
  text: string;
  includedIds: string[];
}

const GENERIC_SUGGESTERS = new Set([
  "membro da comunidade",
  "comunidade",
  "anonimo",
  "anônimo",
  "nao informado",
  "nao_informado",
  "admin",
  "sistema",
]);

function isMeaningfulSuggester(suggestedBy?: string | null): string | null {
  if (!suggestedBy) return null;
  const trimmed = suggestedBy.replace(/\bNAO_INFORMADO\b/gi, "").trim();
  if (!trimmed) return null;
  if (GENERIC_SUGGESTERS.has(norm(trimmed))) return null;
  return trimmed;
}

function isEntryJob(job: DigestJob): boolean {
  const sen = (
    job.seniorityLevel ||
    job.seniority ||
    detectSeniority(job.title || "")
  ).toUpperCase();
  return sen === "ESTAGIO" || sen === "JUNIOR";
}

function formatWeeklyItem(g: Grouped): string {
  const { job, locations } = g;
  const primaryStack = resolvePrimaryStack(job.stack);
  const tag = primaryStack ? ` [${primaryStack}]` : "";
  const validLocations = locations.filter(
    (l) => l && norm(l) !== "nao informado" && norm(l) !== "remoto",
  );
  const cleanCompany = (job.company || "")
    .replace(/\bNAO_INFORMADO\b/gi, "")
    .trim();

  let where = "";
  if (job.workModel === "REMOTO" || !isBrazil(job.location)) {
    where = job.workModel === "REMOTO" ? " (Remoto)" : " (Exterior)";
  } else if (validLocations.length > 0) {
    const model = job.workModel === "HIBRIDO" ? " (híbrido)" : "";
    where = ` · ${validLocations.slice(0, 2).join(" / ")}${model}`;
  } else if (job.workModel === "HIBRIDO") {
    where = " (híbrido)";
  }

  return `• ${cleanTitle(job.title)}${tag} — ${cleanCompany}${where}\n  ${job.url}`;
}

function isGenericTalentPool(title: string): boolean {
  const normTitle = norm(title || "");
  if (!normTitle.includes("banco de talentos")) return false;
  return !/desenvolv|engenhe|software|backend|frontend|fullstack|dados|data|qa|devops|cloud|tech|programad|analista/i.test(
    normTitle,
  );
}

function pickDiverse(items: Grouped[], limit: number, maxPerCompany = 2): Grouped[] {
  const selected: Grouped[] = [];
  const companyCount = new Map<string, number>();
  const remaining: Grouped[] = [];

  for (const item of items) {
    const comp = norm(item.job.company);
    const count = companyCount.get(comp) || 0;
    if (count < maxPerCompany && selected.length < limit) {
      selected.push(item);
      companyCount.set(comp, count + 1);
    } else {
      remaining.push(item);
    }
  }

  while (selected.length < limit && remaining.length > 0) {
    selected.push(remaining.shift()!);
  }

  return selected;
}

/**
 * Monta o resumo semanal de domingo (~11h) retornando texto e IDs das vagas incluídas.
 */
export function buildWeeklySummaryResult(
  opts: WeeklySummaryOptions,
): WeeklySummaryResult | null {
  const {
    monitoredCompaniesCount,
    weeklyTechJobsCount,
    newSuggestions = [],
    topVotedSuggestions = [],
    radarUrl = DEFAULT_RADAR_URL,
    now = new Date(),
    weeklyJobs = [],
    maxJobsPerCategory = 5,
    maxChars = 4000,
  } = opts;

  const hasMonitored =
    typeof monitoredCompaniesCount === "number" && monitoredCompaniesCount > 0;
  const hasJobs =
    typeof weeklyTechJobsCount === "number" && weeklyTechJobsCount > 0;

  const validNewSuggestions = newSuggestions.filter(
    (s) =>
      s &&
      typeof s.name === "string" &&
      s.name.trim().length > 0 &&
      !HIDDEN_COMPANIES.some((r) => r.test(s.name)),
  );

  const validTopVoted = [...topVotedSuggestions]
    .filter(
      (s) =>
        s &&
        typeof s.name === "string" &&
        s.name.trim().length > 0 &&
        typeof s.votesCount === "number" &&
        s.votesCount > 0 &&
        !HIDDEN_COMPANIES.some((r) => r.test(s.name)),
    )
    .sort((a, b) => (b.votesCount || 0) - (a.votesCount || 0))
    .slice(0, 3);

  // Filtra e agrupa vagas da semana
  const eligibleWeekly = (weeklyJobs || []).filter(
    (j) => !isExcludedFromDigest(j) && !isGenericTalentPool(j.title),
  );
  const groupedWeekly = groupDuplicates(eligibleWeekly);

  const entryCandidates: Grouped[] = [];
  const seniorCandidates: Grouped[] = [];

  for (const g of groupedWeekly) {
    if (isEntryJob(g.job)) {
      entryCandidates.push(g);
    } else {
      seniorCandidates.push(g);
    }
  }

  const selectedEntry = pickDiverse(entryCandidates, maxJobsPerCategory);
  const selectedSenior = pickDiverse(seniorCandidates, maxJobsPerCategory);
  const hasAnyCuratedJobs =
    selectedEntry.length > 0 || selectedSenior.length > 0;

  if (
    !hasMonitored &&
    !hasJobs &&
    validNewSuggestions.length === 0 &&
    validTopVoted.length === 0 &&
    !hasAnyCuratedJobs
  ) {
    return null;
  }

  const sections: string[] = [
    `📊 *RADAR DA COMUNIDADE — RESUMO SEMANAL* (${formatDate(now)})`,
  ];

  const statsLines: string[] = [];
  if (hasMonitored) {
    statsLines.push(
      `🏢 *Empresas vigiadas pelo robô:* ${monitoredCompaniesCount}`,
    );
  }
  if (hasJobs) {
    statsLines.push(
      `💻 *Vagas de TI encontradas na semana:* ${weeklyTechJobsCount}`,
    );
  }
  if (statsLines.length > 0) {
    sections.push(statsLines.join("\n"));
  }

  const includedIds: string[] = [];

  if (hasAnyCuratedJobs) {
    const curatedBlocks: string[] = [
      "✨ *SELEÇÃO DA SEMANA — TOP VAGAS PARA COMPARTILHAR* 🔥",
    ];

    if (selectedEntry.length > 0) {
      const entryLines = selectedEntry.map(formatWeeklyItem).join("\n\n");
      curatedBlocks.push(`🎓 *Estágio, Trainee e Júnior:*\n${entryLines}`);
      for (const g of selectedEntry) includedIds.push(...g.ids);
    }

    if (selectedSenior.length > 0) {
      const seniorLines = selectedSenior.map(formatWeeklyItem).join("\n\n");
      curatedBlocks.push(`🚀 *Pleno e Sênior:*\n${seniorLines}`);
      for (const g of selectedSenior) includedIds.push(...g.ids);
    }

    curatedBlocks.push(
      "📢 *Curtiu essa seleção? Compartilhe com quem está buscando vagas de TI!*",
    );

    sections.push(curatedBlocks.join("\n\n"));
  }

  if (validNewSuggestions.length > 0) {
    const sugLines = validNewSuggestions.slice(0, 10).map((s) => {
      const cleanName = cleanTitle(s.name);
      const author = isMeaningfulSuggester(s.suggestedBy);
      return author
        ? `• ${cleanName} _(sugerida por ${author} — valeu! 🙌)_`
        : `• ${cleanName}`;
    });
    sections.push(
      `🌱 *Empresas sugeridas pela comunidade nesta semana (${validNewSuggestions.length}):*\n${sugLines.join("\n")}`,
    );
  }

  if (validTopVoted.length > 0) {
    const medals = ["🥇", "🥈", "🥉"];
    const voteLines = validTopVoted.map((s, idx) => {
      const cleanName = cleanTitle(s.name);
      const votes = s.votesCount || 0;
      const voteLabel = votes === 1 ? "1 voto" : `${votes} votos`;
      return `${medals[idx] || "•"} ${cleanName} — *${voteLabel}*`;
    });
    sections.push(
      `🗳️ *Top sugestões mais votadas para entrar no Radar:*\n${voteLines.join("\n")}`,
    );
  }

  sections.push(
    [
      "─────────────",
      "🙋 *Mais empresas no radar = mais vagas pra todo mundo!*",
      `Sugira uma empresa ou vote nas próximas da fila em: ${radarUrl}`,
    ].join("\n"),
  );

  let finalContent = sections.join("\n\n");

  // Se exceder o orçamento de caracteres, trunca preservando estrutura
  if (finalContent.length > maxChars && hasAnyCuratedJobs) {
    const trimmedEntry = selectedEntry.slice(0, 3);
    const trimmedSenior = selectedSenior.slice(0, 3);
    includedIds.length = 0;
    const trimmedBlocks: string[] = [
      "✨ *SELEÇÃO DA SEMANA — TOP VAGAS PARA COMPARTILHAR* 🔥",
    ];
    if (trimmedEntry.length > 0) {
      trimmedBlocks.push(
        `🎓 *Estágio, Trainee e Júnior:*\n${trimmedEntry.map(formatWeeklyItem).join("\n\n")}`,
      );
      for (const g of trimmedEntry) includedIds.push(...g.ids);
    }
    if (trimmedSenior.length > 0) {
      trimmedBlocks.push(
        `🚀 *Pleno e Sênior:*\n${trimmedSenior.map(formatWeeklyItem).join("\n\n")}`,
      );
      for (const g of trimmedSenior) includedIds.push(...g.ids);
    }
    trimmedBlocks.push(
      "📢 *Curtiu essa seleção? Compartilhe com quem está buscando vagas de TI!*",
    );
    const idx = sections.findIndex((s) =>
      s.includes("SELEÇÃO DA SEMANA — TOP VAGAS PARA COMPARTILHAR"),
    );
    if (idx !== -1) {
      sections[idx] = trimmedBlocks.join("\n\n");
    }
    finalContent = sections.join("\n\n");
  }

  return {
    text: finalContent,
    includedIds: [...new Set(includedIds)],
  };
}

/**
 * Monta o resumo semanal de domingo (~11h).
 * Se não houver dado confiável para algum item, omite o item em vez de inventar.
 * Se não houver nenhum dado confiável, retorna null.
 */
export function buildWeeklySummary(opts: WeeklySummaryOptions): string | null {
  return buildWeeklySummaryResult(opts)?.text ?? null;
}

/* ------------------------------ presets & env ------------------------------ */

export const DEFAULT_RADAR_URL = "https://querovagas.apenasgabs.dev/";

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnvBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export const DIGESTS = {
  entry: {
    seniorities: ["ESTAGIO", "JUNIOR"] as Seniority[],
    options: {
      title: "ESTÁGIO, TRAINEE E JÚNIOR",
      emoji: "🎓",
      radarUrl: DEFAULT_RADAR_URL,
      includeAbroad: false,
      minJobs: 3,
    },
  },
  senior: {
    seniorities: [
      "PLENO",
      "SENIOR",
      "ESPECIALISTA",
      "NAO_INFORMADO",
    ] as Seniority[],
    options: {
      title: "VAGAS PLENO E SÊNIOR",
      emoji: "🚀",
      radarUrl: DEFAULT_RADAR_URL,
      includeAbroad: false,
      minJobs: 4,
    },
  },
} as const;

export type DigestKind = keyof typeof DIGESTS;

export interface DigestRuntimeConfig {
  radarUrl: string;
  maxPerSection: number;
  maxTotal: number;
  maxChars: number;
  includeAbroad: boolean;
  entryMinJobs: number;
  seniorMinJobs: number;
  maxAgeDays: number;
  entryCron: string;
  seniorCron: string;
  weeklyCron: string;
  timezone: string;
  dryRun: boolean;
  groupJidOverride?: string;
}

export function getDigestRuntimeConfig(): DigestRuntimeConfig {
  return {
    radarUrl: process.env.RADAR_URL?.trim() || DEFAULT_RADAR_URL,
    maxPerSection: parseEnvInt(process.env.DIGEST_MAX_PER_SECTION, 15),
    maxTotal: parseEnvInt(process.env.DIGEST_MAX_TOTAL, 25),
    maxChars: parseEnvInt(process.env.DIGEST_MAX_CHARS, 4000),
    includeAbroad: parseEnvBool(process.env.DIGEST_INCLUDE_ABROAD, false),
    entryMinJobs: parseEnvInt(
      process.env.DIGEST_ENTRY_MIN_JOBS,
      DIGESTS.entry.options.minJobs,
    ),
    seniorMinJobs: parseEnvInt(
      process.env.DIGEST_SENIOR_MIN_JOBS,
      DIGESTS.senior.options.minJobs,
    ),
    maxAgeDays: parseEnvInt(process.env.DIGEST_MAX_AGE_DAYS, 5),
    entryCron: process.env.DIGEST_ENTRY_CRON?.trim() || "5 12 * * *",
    seniorCron: process.env.DIGEST_SENIOR_CRON?.trim() || "5 18 * * *",
    weeklyCron: process.env.DIGEST_WEEKLY_CRON?.trim() || "0 11 * * 0",
    timezone: process.env.DIGEST_TIMEZONE?.trim() || "America/Sao_Paulo",
    dryRun: parseEnvBool(process.env.DIGEST_DRY_RUN, false),
    groupJidOverride: process.env.WHATSAPP_GROUP_JID?.trim() || undefined,
  };
}

export function getDigestOptionsForKind(
  kind: DigestKind,
  now = new Date(),
): { seniorities: Seniority[]; options: DigestOptions } {
  const preset = DIGESTS[kind];
  const cfg = getDigestRuntimeConfig();
  return {
    seniorities: [...preset.seniorities],
    options: {
      title: preset.options.title,
      emoji: preset.options.emoji,
      radarUrl: cfg.radarUrl,
      maxPerSection: cfg.maxPerSection,
      maxTotal: cfg.maxTotal,
      maxChars: cfg.maxChars,
      includeAbroad: cfg.includeAbroad,
      minJobs: kind === "entry" ? cfg.entryMinJobs : cfg.seniorMinJobs,
      maxAgeDays: cfg.maxAgeDays,
      now,
    },
  };
}
