import { ContractType, SeniorityLevel, WorkModel } from "../types.js";

const KNOWN_STACKS = [
  "JavaScript",
  "TypeScript",
  "React",
  "Node",
  "Java",
  "Spring",
  "Python",
  "Django",
  "FastAPI",
  "C#",
  ".NET",
  "PHP",
  "Laravel",
  "Go",
  "Golang",
  "Rust",
  "Ruby",
  "Rails",
  "Vue",
  "Angular",
  "Next.js",
  "NestJS",
  "Docker",
  "Kubernetes",
  "AWS",
  "Azure",
  "GCP",
  "PostgreSQL",
  "MySQL",
  "MongoDB",
  "Redis",
  "GraphQL",
  "DevOps",
  "CI/CD",
  "Flutter",
  "React Native",
  "Kotlin",
  "Swift",
  "SQL",
  "Terraform",
  "Kafka",
];

export function canonicalizeTitle(title: string): string {
  if (!title) return "";
  let clean = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  // 1. Remove tags de colchetes ou parênteses de IDs/código interno (ex: [1201-1202], (Req 402))
  clean = clean.replace(/\[\s*[\d\-a-z]+\s*\]/gi, " ");
  clean = clean.replace(/req\s*#?\s*\d+/gi, " ");

  // 2. Remove tags afirmativas/diversidade comuns
  clean = clean.replace(
    /\(?\[?\b(afirmativ[ao]|exclusiv[ao]|pcd|mulheres|diversidade|negros?|lgbtqia\+?)\b[^\]\)]*\]?\)?/gi,
    " ",
  );

  // 3. Remove modelo de trabalho e localidades comuns
  clean = clean.replace(
    /\(?\[?\b(remoto|hibrido|presencial|home\s*office|brasil|brazil|sp|rj|mg|pr|sc|rs|campinas|sao paulo|rio de janeiro)\b\]?\)?/gi,
    " ",
  );

  // 4. Remove pontuação e caracteres especiais, mantendo apenas letras, números e espaços
  clean = clean.replace(/[^a-z0-9\s]/g, " ");
  return clean.replace(/\s+/g, " ").trim();
}

export function detectSeniority(text: string): SeniorityLevel {
  const t = text.toLowerCase();
  // Regex estrita com word boundary para estágio e exclusão de "internal", "international" ou "internet"
  if (
    /\b(est[aá]gio|estagi[aá]ri[ao]|intern|internship|trainee)\b/i.test(t) &&
    !/\b(internal|international|internet)\b/i.test(t)
  ) {
    return "ESTAGIO";
  }
  if (t.includes("júnior") || t.includes("junior") || /\bjr\b/i.test(t)) {
    return "JUNIOR";
  }
  if (
    t.includes("especialista") ||
    t.includes("principal") ||
    t.includes("staff")
  ) {
    return "ESPECIALISTA";
  }
  if (
    t.includes("sênior") ||
    t.includes("senior") ||
    /\bsr\b/i.test(t) ||
    /\blead\b/i.test(t) ||
    t.includes("tech lead") ||
    /\biii\b/i.test(t)
  ) {
    return "SENIOR";
  }
  if (
    t.includes("pleno") ||
    t.includes("mid-level") ||
    t.includes("mid level") ||
    t.includes("intermediate") ||
    /\bpl\b/i.test(t) ||
    /\bii\b/i.test(t)
  ) {
    return "PLENO";
  }
  // Regra de negócio: vagas sem senioridade explícita no título são tratadas como PLENO
  return "PLENO";
}

export function detectWorkModel(text: string): WorkModel {
  const t = text.toLowerCase();
  if (
    t.includes("remoto") ||
    t.includes("remote") ||
    t.includes("home office") ||
    t.includes("teletrabalho")
  ) {
    return "REMOTO";
  }
  if (t.includes("híbrido") || t.includes("hibrido") || t.includes("hybrid")) {
    return "HIBRIDO";
  }
  if (
    t.includes("presencial") ||
    t.includes("on-site") ||
    t.includes("onsite") ||
    t.includes("on site") ||
    t.includes("no local")
  ) {
    return "PRESENCIAL";
  }
  return "NAO_INFORMADO";
}

export function detectContractType(
  text: string,
  defaultType: ContractType = "CLT",
): ContractType {
  const t = text.toLowerCase();
  if (
    t.includes("freelance") ||
    t.includes("freelancer") ||
    t.includes("projeto") ||
    t.includes("temporário")
  ) {
    return "FREELANCER";
  }
  if (
    t.includes("pj") ||
    t.includes("pessoa jurídica") ||
    t.includes("prestador de serviços")
  ) {
    return "PJ";
  }
  if (
    /\b(est[aá]gio|estagi[aá]ri[ao]|intern|internship|trainee)\b/i.test(t) &&
    !/\b(internal|international|internet)\b/i.test(t)
  ) {
    return "ESTAGIO";
  }
  if (t.includes("clt") || t.includes("efetivo")) {
    return "CLT";
  }
  return defaultType;
}

export function extractStack(text: string): string[] {
  const t = ` ${text.toLowerCase()} `;
  const found: string[] = [];

  for (const tech of KNOWN_STACKS) {
    const techLower = tech.toLowerCase();
    // Verifica palavra exata para evitar falsos positivos
    const regex = new RegExp(
      `[\\s,./+()\\-_#]${techLower.replace(".", "\\.")}[\\s,./+()\\-_#]`,
      "i",
    );
    if (regex.test(t) || t.includes(` ${techLower} `)) {
      found.push(tech);
    }
  }

  return Array.from(new Set(found));
}

const INHIRE_CHAR_MAP: Record<string, string> = {
  "&": "and",
  "|": "or",
  "%": "percent",
  "<": "less",
  ">": "greater",
  $: "dollar",
  À: "A",
  Á: "A",
  Â: "A",
  Ã: "A",
  Ä: "A",
  Å: "A",
  Æ: "AE",
  Ç: "C",
  È: "E",
  É: "E",
  Ê: "E",
  Ë: "E",
  Ì: "I",
  Í: "I",
  Î: "I",
  Ï: "I",
  Ñ: "N",
  Ò: "O",
  Ó: "O",
  Ô: "O",
  Õ: "O",
  Ö: "O",
  Ù: "U",
  Ú: "U",
  Û: "U",
  Ü: "U",
  Ý: "Y",
  à: "a",
  á: "a",
  â: "a",
  ã: "a",
  ä: "a",
  å: "a",
  æ: "ae",
  ç: "c",
  è: "e",
  é: "e",
  ê: "e",
  ë: "e",
  ì: "i",
  í: "i",
  î: "i",
  ï: "i",
  ñ: "n",
  ò: "o",
  ó: "o",
  ô: "o",
  õ: "o",
  ö: "o",
  ù: "u",
  ú: "u",
  û: "u",
  ü: "u",
  ý: "y",
  ÿ: "y",
};

/**
 * Gera o slug compatível com a rota do InHire (/vagas/:jobId/:jobSlug).
 * Emula com precisão idêntica a biblioteca de slug utilizada no frontend do InHire.
 */
export function slugifyInHire(text: string): string {
  const removeRegex = /[^a-zA-Z0-9 ]/g;
  let slug = "";
  for (const ch of text.normalize()) {
    let appendChar =
      INHIRE_CHAR_MAP[ch] !== undefined ? INHIRE_CHAR_MAP[ch] : ch;
    if (appendChar === "-") appendChar = " ";
    slug += appendChar.replace(removeRegex, "");
  }
  return slug.trim().replace(/\s+/g, "-").toLowerCase();
}
