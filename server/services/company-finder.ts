import { resilientFetch } from "../utils/fetch.js";

export type SupportedAts = "GUPY" | "GREENHOUSE" | "LEVER" | "ASHBY" | "INHIRE" | "WORKABLE";

export interface AtsMatch {
  ats: SupportedAts;
  slug: string;
  portalUrl: string;
  source: "direct_link" | "probed";
  companyName?: string;
  confidence: number;
}

/**
 * Normaliza strings para comparação (remove acentos, pontuação e caixa alta)
 */
export function normalizeString(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/**
 * Gera variações de slug limpas a partir do nome da empresa e domínio
 */
export function generateCandidateSlugs(companyName: string, website?: string): string[] {
  const slugs = new Set<string>();

  // 1. Limpeza básica do nome
  const raw = companyName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

  // Versão sem sufixos corporativos comuns (ex: S.A., LTDA, etc.)
  const strippedCorporate = raw
    .replace(/\b(s\.a\.?|sa|ltda|brasil|br|group|grupo|tecnologia|tech|sistemas|consultoria|solucoes|soluções|services|solutions|corp|inc|llc)\b/gi, "")
    .trim();

  const versions = [raw];
  if (strippedCorporate && strippedCorporate !== raw) {
    versions.push(strippedCorporate);
  }

  for (const ver of versions) {
    // Slug com hífen (ex: "Agenda Edu" -> "agenda-edu")
    const dashSlug = ver
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (dashSlug && dashSlug.length >= 2) slugs.add(dashSlug);

    // Slug contínuo com expansão de & (ex: "CI&T" -> "ciandt")
    const andExpanded = ver
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "");
    if (andExpanded && andExpanded.length >= 2) slugs.add(andExpanded);

    const cleanNoSpecial = ver.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (cleanNoSpecial && cleanNoSpecial.length >= 2) slugs.add(cleanNoSpecial);
  }

  // Se houver site oficial, extrair o domínio base (ex: "https://wisesystem.com.br" -> "wisesystem")
  if (website) {
    try {
      const parsed = new URL(website.startsWith("http") ? website : `https://${website}`);
      const hostParts = parsed.hostname.replace(/^www\./, "").split(".");
      const mainDomain = hostParts[0]?.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (mainDomain && mainDomain.length >= 2) {
        slugs.add(mainDomain);
      }
    } catch {}
  }

  // Prefixos e sufixos típicos brasileiros de carreiras
  const base = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (base && base.length >= 3 && base.length <= 15) {
    slugs.add(`vagas${base}`);
    slugs.add(`vemser${base}`);
    slugs.add(`${base}brasil`);
    slugs.add(`${base}br`);
  }

  // Ordenar priorizando slugs mais específicos e próximos do nome original
  return Array.from(slugs).sort((a, b) => {
    // Preferência para o slug que expande '&' para 'and' se o original tinha '&'
    if (companyName.includes("&") && a.includes("and")) return -1;
    if (companyName.includes("&") && b.includes("and")) return 1;
    // Preferência por slugs com tamanho razoável
    return b.length - a.length;
  });
}

/**
 * Extrai ATS e slug diretamente a partir de um link de vaga ou portal
 */
export function extractAtsFromUrl(url: string): AtsMatch | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    // 1. Gupy: https://{slug}.gupy.io...
    if (host.endsWith(".gupy.io")) {
      const slug = host.replace(/\.gupy\.io$/, "");
      if (slug && slug !== "www" && slug !== "login") {
        return {
          ats: "GUPY",
          slug,
          portalUrl: `https://${slug}.gupy.io`,
          source: "direct_link",
          confidence: 1.0,
        };
      }
    }

    // 2. InHire: https://{slug}.inhire.app... ou https://{domain}.inhire.app/{slug}
    if (host.endsWith(".inhire.app")) {
      const sub = host.replace(/\.inhire\.app$/, "");
      // Pode ser subdomínio direto
      let slug = sub;
      // Ou na rota /vagas/... ou /{slug}/vagas/...
      const pathParts = pathname.split("/").filter(Boolean);
      if (pathParts.length > 0 && pathParts[0] !== "vagas" && pathParts[0] !== "job") {
        slug = pathParts[0];
      }
      if (slug && slug !== "www" && slug !== "app") {
        return {
          ats: "INHIRE",
          slug,
          portalUrl: `https://${sub}.inhire.app`,
          source: "direct_link",
          confidence: 1.0,
        };
      }
    }

    // 3. Greenhouse: https://boards.greenhouse.io/{slug} ou https://job-boards.greenhouse.io/{slug}
    if (host.includes("greenhouse.io")) {
      const parts = pathname.split("/").filter(Boolean);
      const slug = parts[0] === "embed" ? parts[1] : parts[0];
      if (slug && slug !== "jobs") {
        return {
          ats: "GREENHOUSE",
          slug,
          portalUrl: `https://boards.greenhouse.io/${slug}`,
          source: "direct_link",
          confidence: 1.0,
        };
      }
    }

    // 4. Lever: https://jobs.lever.co/{slug}
    if (host === "jobs.lever.co") {
      const slug = pathname.split("/").filter(Boolean)[0];
      if (slug) {
        return {
          ats: "LEVER",
          slug,
          portalUrl: `https://jobs.lever.co/${slug}`,
          source: "direct_link",
          confidence: 1.0,
        };
      }
    }

    // 5. Ashby: https://jobs.ashbyhq.com/{slug}
    if (host === "jobs.ashbyhq.com") {
      const slug = pathname.split("/").filter(Boolean)[0];
      if (slug) {
        return {
          ats: "ASHBY",
          slug,
          portalUrl: `https://jobs.ashbyhq.com/${slug}`,
          source: "direct_link",
          confidence: 1.0,
        };
      }
    }

    // 6. Workable: https://apply.workable.com/{slug}
    if (host === "apply.workable.com") {
      const slug = pathname.split("/").filter(Boolean)[0];
      if (slug && slug !== "j" && slug !== "api") {
        return {
          ats: "WORKABLE",
          slug,
          portalUrl: `https://apply.workable.com/${slug}`,
          source: "direct_link",
          confidence: 1.0,
        };
      }
    }
  } catch {}

  return null;
}

/**
 * Sonda ativamente um slug em cada plataforma de ATS
 */
export async function probeSlug(
  slug: string,
  targetCompanyName?: string
): Promise<AtsMatch | null> {
  const normTarget = targetCompanyName ? normalizeString(targetCompanyName) : "";

  // 1. Greenhouse (API JSON direta e ultra-confiável)
  try {
    const res = await resilientFetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, {
      timeoutMs: 3500,
      maxRetries: 0,
      source: "GREENHOUSE",
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      return {
        ats: "GREENHOUSE",
        slug,
        portalUrl: `https://boards.greenhouse.io/${slug}`,
        source: "probed",
        confidence: 0.95,
      };
    }
  } catch {}

  // 2. Lever (API JSON com lista de postings)
  try {
    const res = await resilientFetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, {
      timeoutMs: 3500,
      maxRetries: 0,
      source: "LEVER",
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      return {
        ats: "LEVER",
        slug,
        portalUrl: `https://jobs.lever.co/${slug}`,
        source: "probed",
        confidence: 0.95,
      };
    }
  } catch {}

  // 3. Ashby (API oficial)
  try {
    const res = await resilientFetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, {
      timeoutMs: 3500,
      maxRetries: 0,
      source: "ASHBY",
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      return {
        ats: "ASHBY",
        slug,
        portalUrl: `https://jobs.ashbyhq.com/${slug}`,
        source: "probed",
        confidence: 0.95,
      };
    }
  } catch {}

  // 4. Gupy (Validação de NextData e HTML)
  try {
    const res = await resilientFetch(`https://${slug}.gupy.io`, {
      timeoutMs: 4000,
      maxRetries: 0,
      source: "GUPY",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        Accept: "text/html",
      },
    });
    if (res.ok) {
      const html = await res.text();
      if (html.includes("__NEXT_DATA__") || html.includes("gupy")) {
        return {
          ats: "GUPY",
          slug,
          portalUrl: `https://${slug}.gupy.io`,
          source: "probed",
          confidence: 0.95,
        };
      }
    }
  } catch {}

  // 5. InHire
  try {
    const res = await resilientFetch(`https://${slug}.inhire.app`, {
      timeoutMs: 4000,
      maxRetries: 0,
      source: "INHIRE",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        Accept: "text/html",
      },
    });
    if (res.ok) {
      const html = await res.text();
      if (!html.includes("Página não encontrada") && !html.includes("404")) {
        return {
          ats: "INHIRE",
          slug,
          portalUrl: `https://${slug}.inhire.app`,
          source: "probed",
          confidence: 0.9,
        };
      }
    }
  } catch {}

  // 6. Workable (com validação estrita do nome retornado para evitar colisões com siglas genéricas)
  try {
    const res = await resilientFetch(`https://apply.workable.com/api/v1/widget/accounts/${slug}`, {
      timeoutMs: 3500,
      maxRetries: 0,
      source: "WORKABLE",
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      const remoteName = data?.name || "";
      const normRemote = normalizeString(remoteName);

      // Só aceita Workable se o nome for compatível ou slug tiver pelo menos 4 caracteres
      if (!normTarget || normRemote.includes(normTarget) || normTarget.includes(normRemote) || slug.length >= 5) {
        return {
          ats: "WORKABLE",
          slug,
          portalUrl: `https://apply.workable.com/${slug}`,
          companyName: remoteName,
          source: "probed",
          confidence: 0.9,
        };
      }
    }
  } catch {}

  return null;
}

/**
 * Tenta resolver a ATS de uma empresa a partir do nome e website
 */
export async function findCompanyAts(
  companyName: string,
  website?: string
): Promise<AtsMatch | null> {
  const candidateSlugs = generateCandidateSlugs(companyName, website);

  for (const slug of candidateSlugs) {
    const match = await probeSlug(slug, companyName);
    if (match) return match;
  }

  return null;
}
