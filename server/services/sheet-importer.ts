import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";
import {
  extractAtsFromUrl,
  findCompanyAts,
  normalizeString,
  AtsMatch,
  SupportedAts,
} from "./company-finder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.resolve(__dirname, "../../config/search.config.json");
const REPORT_FILE = path.resolve(__dirname, "../../data/sheet_import_report.json");

export interface SheetImportOptions {
  source: string; // URL do Google Sheets ou caminho local para .xlsx
  dryRun?: boolean; // Se true, não altera o search.config.json
  probe?: boolean; // Se true, sonda slugs para empresas sem link ATS direto
  limitTabs?: number; // Limite de abas a inspecionar (opcional)
  outputPath?: string; // Caminho alternativo para o relatório
}

export interface DiscoveredCompany {
  name: string;
  website?: string;
  atsMatch?: AtsMatch | null;
  status: "new" | "already_exists" | "unresolved";
  sampleJobTitle?: string;
  sampleLink?: string;
  tabOrSource?: string;
  mentionsCount: number;
}

export interface SheetImportResult {
  source: string;
  totalTabs: number;
  totalRowsProcessed: number;
  totalUniqueCompanies: number;
  matchedCount: number;
  newAddedCount: number;
  alreadyExistingCount: number;
  unresolvedCount: number;
  byAts: Record<SupportedAts, { new: number; existing: number }>;
  companies: DiscoveredCompany[];
  timestamp: string;
}

/**
 * Extrai o ID de uma URL de planilha do Google Sheets
 */
export function extractGoogleSheetId(url: string): string | null {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

/**
 * Converte qualquer valor de célula do ExcelJS em texto limpo e link extraído
 */
function extractCellContent(cell: ExcelJS.Cell): { text: string; link: string } {
  const val = cell.value;
  if (val === null || val === undefined) return { text: "", link: "" };

  let text = "";
  let link = "";

  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
    text = String(val).trim();
  } else if (typeof val === "object") {
    // Objeto de hiperlink do ExcelJS: { text: '...', hyperlink: 'https://...' }
    if ("hyperlink" in val && typeof (val as any).hyperlink === "string") {
      link = (val as any).hyperlink.trim();
      text = String((val as any).text || "").trim();
    } else if ("richText" in val && Array.isArray((val as any).richText)) {
      text = (val as any).richText.map((rt: any) => rt.text || "").join("").trim();
    } else if ("formula" in val) {
      const formula = String((val as any).formula);
      // Ex: HYPERLINK("https://...", "Clique aqui")
      const m = formula.match(/HYPERLINK\(\s*["']([^"']+)["']\s*,\s*["']?([^"')]+)?["']?\s*\)/i);
      if (m) {
        link = m[1].trim();
        text = (m[2] || "").trim();
      } else {
        text = String((val as any).result || "");
      }
    }
  }

  // Se não extraiu o link do objeto mas o texto é uma URL
  if (!link && (text.startsWith("http://") || text.startsWith("https://"))) {
    link = text;
  }

  return { text, link };
}

export class SheetImporterService {
  /**
   * Baixa ou lê o arquivo de planilha em memória
   */
  static async loadWorkbook(source: string): Promise<ExcelJS.Workbook> {
    const workbook = new ExcelJS.Workbook();

    if (source.startsWith("http://") || source.startsWith("https://")) {
      const sheetId = extractGoogleSheetId(source);
      let downloadUrl = source;
      if (sheetId) {
        downloadUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
      }

      const res = await fetch(downloadUrl);
      if (!res.ok) {
        throw new Error(`Erro ao baixar planilha HTTP (${res.status} ${res.statusText}): ${downloadUrl}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      await workbook.xlsx.load(Buffer.from(arrayBuffer));
    } else {
      const resolved = path.isAbsolute(source) ? source : path.resolve(process.cwd(), source);
      if (!fs.existsSync(resolved)) {
        throw new Error(`Arquivo de planilha não encontrado: ${resolved}`);
      }
      await workbook.xlsx.readFile(resolved);
    }

    return workbook;
  }

  /**
   * Processa a planilha completa, identifica as empresas e mapeia para o JobsFinder
   */
  static async import(options: SheetImportOptions): Promise<SheetImportResult> {
    const workbook = await this.loadWorkbook(options.source);
    const tabsToProcess = options.limitTabs
      ? workbook.worksheets.slice(0, options.limitTabs)
      : workbook.worksheets;

    let totalRowsProcessed = 0;
    const companyMap = new Map<string, {
      name: string;
      website?: string;
      sampleJobTitle?: string;
      sampleLink?: string;
      tabOrSource?: string;
      directAtsMatch?: AtsMatch;
      mentionsCount: number;
    }>();

    for (const sheet of tabsToProcess) {
      if (sheet.rowCount === 0) continue;

      const sheetNameLower = sheet.name.toLowerCase();
      // Ignora abas que não contenham lista de empresas (resumos, métricas, notas, etc.)
      if (
        sheetNameLower.includes("resumo") ||
        sheetNameLower.includes("métrica") ||
        sheetNameLower.includes("metrica") ||
        sheetNameLower.includes("notas") ||
        sheetNameLower.includes("readme") ||
        sheetNameLower.includes("dashboard")
      ) {
        continue;
      }

      // 1. Detectar cabeçalho nas primeiras 10 linhas
      let headerRowIndex = -1;
      let colCompany = -1;
      let colTitle = -1;
      let colCategory = -1;
      let colLink = -1;
      let colWebsite = -1;
      let colMentions = -1;
      let isCompanyDirectory = false;

      for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
        const row = sheet.getRow(r);
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const { text } = extractCellContent(cell);
          const lower = text.toLowerCase();

          if (lower.includes("empresa") && !lower.includes("tóxica") && !lower.includes("métrica")) {
            headerRowIndex = r;
            colCompany = colNumber;
          } else if (
            lower.includes("página de carreira") ||
            lower.includes("pagina de carreira") ||
            lower.includes("carreira principal") ||
            lower.includes("portal de vagas")
          ) {
            colLink = colNumber;
          } else if (lower.includes("site") || lower.includes("website")) {
            colWebsite = colNumber;
          } else if (lower.includes("link") || lower.includes("candidatura") || lower.includes("url")) {
            if (colLink === -1) colLink = colNumber;
          } else if (lower.includes("menções") || lower.includes("mencoes") || lower.includes("quantidade") || lower.includes("total vagas")) {
            colMentions = colNumber;
          } else if (lower.includes("vaga") || lower.includes("título") || lower.includes("nome da vaga")) {
            if (colTitle === -1) colTitle = colNumber;
          } else if (lower.includes("categoria") || lower.includes("área")) {
            colCategory = colNumber;
          }
        });

        if (colCompany !== -1 && (colTitle !== -1 || colLink !== -1 || colWebsite !== -1 || colMentions !== -1)) {
          if (colWebsite !== -1 || colMentions !== -1 || colLink !== -1) {
            isCompanyDirectory = true;
          }
          break;
        }
      }

      // Se não achou cabeçalho padrão, assume formato convencional da planilha de vagas (B=Empresa, C=Vaga, D=Categoria, E=Link)
      if (colCompany === -1) {
        if (sheet.columnCount >= 4) {
          colCompany = 2; // B
          colTitle = 3;   // C
          colCategory = 4;// D
          colLink = 5;    // E
          headerRowIndex = 4;
        } else {
          continue;
        }
      }

      const startRow = headerRowIndex > 0 ? headerRowIndex + 1 : 1;

      for (let r = startRow; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const cellComp = row.getCell(colCompany);
        const { text: companyNameRaw, link: companyLink } = extractCellContent(cellComp);

        let companyName = companyNameRaw.trim();
        // Ignora cabeçalhos repetidos ou linhas vazias
        if (!companyName || companyName.toLowerCase().includes("planilhão") || companyName.toLowerCase() === "empresa") {
          continue;
        }

        totalRowsProcessed++;

        let jobTitle = "";
        let link = "";
        let website = "";
        let mentions = 1;

        if (colTitle > 0) {
          const titleContent = extractCellContent(row.getCell(colTitle));
          jobTitle = titleContent.text;
          if (titleContent.link) link = titleContent.link;
        }

        if (colLink > 0) {
          const linkContent = extractCellContent(row.getCell(colLink));
          if (linkContent.link) link = linkContent.link;
          else if (linkContent.text.startsWith("http")) link = linkContent.text;
        }

        if (colWebsite > 0) {
          const webContent = extractCellContent(row.getCell(colWebsite));
          website = webContent.link || webContent.text;
        }

        if (colMentions > 0) {
          const countContent = extractCellContent(row.getCell(colMentions));
          const parsedCount = parseInt(countContent.text, 10);
          if (!isNaN(parsedCount) && parsedCount > 0) mentions = parsedCount;
        }

        // Se a empresa possui link em outra coluna ou no próprio nome
        if (!link && companyLink) link = companyLink;

        // Limpar nome da empresa de emojis ou prefixos
        companyName = companyName.replace(/^[🏢🏛️💼\s]+/, "").trim();

        const key = normalizeString(companyName);
        if (!key) continue;

        const directAts = link ? extractAtsFromUrl(link) : null;

        if (!companyMap.has(key)) {
          companyMap.set(key, {
            name: companyName,
            website,
            sampleJobTitle: jobTitle,
            sampleLink: link,
            tabOrSource: sheet.name,
            directAtsMatch: directAts || undefined,
            mentionsCount: mentions,
          });
        } else {
          const existing = companyMap.get(key)!;
          existing.mentionsCount += mentions;
          if (!existing.directAtsMatch && directAts) {
            existing.directAtsMatch = directAts;
          }
          if (!existing.website && website) existing.website = website;
          if (!existing.sampleLink && link) existing.sampleLink = link;
          if (!existing.sampleJobTitle && jobTitle) existing.sampleJobTitle = jobTitle;
        }
      }
    }

    // 2. Carregar configuração atual do JobsFinder
    const searchConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));

    const existingSlugs = {
      GUPY: new Set<string>((searchConfig.gupyCompanies || []).map((c: any) => c.slug.toLowerCase())),
      INHIRE: new Set<string>((searchConfig.inhireCompanies || []).map((c: any) => c.slug.toLowerCase())),
      GREENHOUSE: new Set<string>((searchConfig.greenhouseCompanies || []).map((c: any) => c.slug.toLowerCase())),
      LEVER: new Set<string>((searchConfig.leverCompanies || []).map((c: any) => c.slug.toLowerCase())),
      ASHBY: new Set<string>((searchConfig.ashbyCompanies || []).map((c: any) => c.slug.toLowerCase())),
      WORKABLE: new Set<string>((searchConfig.workableCompanies || []).map((c: any) => c.slug.toLowerCase())),
      SOLIDES: new Set<string>((searchConfig.solidesCompanies || []).map((c: any) => c.slug.toLowerCase())),
      WORKDAY: new Set<string>((searchConfig.workdayCompanies || []).map((c: any) => c.slug.toLowerCase())),
      QUICKIN: new Set<string>((searchConfig.quickinCompanies || []).map((c: any) => c.slug.toLowerCase())),
      CUSTOM_SITE: new Set<string>((searchConfig.customSiteCompanies || []).map((c: any) => c.slug.toLowerCase())),
      LINKEDIN: new Set<string>((searchConfig.linkedinCompanies || []).map((c: any) => c.slug.toLowerCase())),
    };

    const existingUrls = new Set<string>();
    for (const key of Object.keys(existingSlugs) as SupportedAts[]) {
      const prop = `${key.toLowerCase()}Companies` as keyof typeof searchConfig;
      for (const item of ((searchConfig as any)[prop] || [])) {
        if (item.link) {
          existingUrls.add(item.link.toLowerCase().trim().replace(/\/+$/, ""));
        }
      }
    }

    const discoveredCompanies: DiscoveredCompany[] = [];
    const byAts: Record<SupportedAts, { new: number; existing: number }> = {
      GUPY: { new: 0, existing: 0 },
      INHIRE: { new: 0, existing: 0 },
      GREENHOUSE: { new: 0, existing: 0 },
      LEVER: { new: 0, existing: 0 },
      ASHBY: { new: 0, existing: 0 },
      WORKABLE: { new: 0, existing: 0 },
      SOLIDES: { new: 0, existing: 0 },
      WORKDAY: { new: 0, existing: 0 },
      QUICKIN: { new: 0, existing: 0 },
      CUSTOM_SITE: { new: 0, existing: 0 },
      LINKEDIN: { new: 0, existing: 0 },
    };

    let matchedCount = 0;
    let newAddedCount = 0;
    let alreadyExistingCount = 0;
    let unresolvedCount = 0;

    const companiesToProcess = Array.from(companyMap.values()).sort(
      (a, b) => b.mentionsCount - a.mentionsCount
    );

    for (const comp of companiesToProcess) {
      let match: AtsMatch | null = comp.directAtsMatch || null;

      // Se não tem match direto e probe está habilitado, sonda os endpoints das ATSs
      if (!match && options.probe !== false) {
        match = await findCompanyAts(comp.name, comp.website);
      }

      // Se ainda não deu match, resolve para Site Próprio ou LinkedIn Search
      if (!match) {
        const candidateUrl = comp.sampleLink || comp.website;
        let isCustomSite = false;
        if (candidateUrl) {
          try {
            const p = new URL(candidateUrl.startsWith("http") ? candidateUrl : `https://${candidateUrl}`);
            if (/^(carreiras|careers|jobs|trabalheconosco|talentos)\./i.test(p.hostname) || p.pathname.includes("/carreira") || p.pathname.includes("/vagas") || p.pathname.includes("/jobs")) {
              isCustomSite = true;
            }
          } catch {}
        }

        if (isCustomSite && candidateUrl) {
          match = {
            ats: "CUSTOM_SITE",
            slug: normalizeString(comp.name),
            portalUrl: candidateUrl.startsWith("http") ? candidateUrl : `https://${candidateUrl}`,
            source: "direct_link",
            confidence: 0.85
          };
        } else {
          match = {
            ats: "LINKEDIN",
            slug: normalizeString(comp.name),
            portalUrl: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(comp.name)}&location=Brasil`,
            source: "direct_link",
            confidence: 0.8
          };
        }
      }

      if (match) {
        matchedCount++;
        const ats = match.ats;
        if (ats === "LINKEDIN" || ats === "CUSTOM_SITE") {
          match.slug = normalizeString(comp.name) || match.slug;
        }
        const slug = match.slug.toLowerCase();
        const normUrl = match.portalUrl.toLowerCase().trim().replace(/\/+$/, "");
        const isExisting = existingSlugs[ats].has(slug) || existingUrls.has(normUrl);

        if (isExisting) {
          alreadyExistingCount++;
          byAts[ats].existing++;
          discoveredCompanies.push({
            name: comp.name,
            website: comp.website,
            atsMatch: match,
            status: "already_exists",
            sampleJobTitle: comp.sampleJobTitle,
            sampleLink: comp.sampleLink,
            tabOrSource: comp.tabOrSource,
            mentionsCount: comp.mentionsCount,
          });
        } else {
          newAddedCount++;
          byAts[ats].new++;
          existingSlugs[ats].add(slug); // Evitar duplicar no mesmo lote
          existingUrls.add(normUrl);

          discoveredCompanies.push({
            name: comp.name,
            website: comp.website,
            atsMatch: match,
            status: "new",
            sampleJobTitle: comp.sampleJobTitle,
            sampleLink: comp.sampleLink,
            tabOrSource: comp.tabOrSource,
            mentionsCount: comp.mentionsCount,
          });

          // Adicionar à lista no searchConfig se não for dryRun
          if (!options.dryRun) {
            const companyEntry = {
              name: comp.name,
              slug: match.slug,
              link: match.portalUrl,
              enabled: true,
            };

            if (ats === "GUPY") {
              searchConfig.gupyCompanies = searchConfig.gupyCompanies || [];
              searchConfig.gupyCompanies.push(companyEntry);
            } else if (ats === "INHIRE") {
              searchConfig.inhireCompanies = searchConfig.inhireCompanies || [];
              searchConfig.inhireCompanies.push(companyEntry);
            } else if (ats === "GREENHOUSE") {
              searchConfig.greenhouseCompanies = searchConfig.greenhouseCompanies || [];
              searchConfig.greenhouseCompanies.push(companyEntry);
            } else if (ats === "LEVER") {
              searchConfig.leverCompanies = searchConfig.leverCompanies || [];
              searchConfig.leverCompanies.push(companyEntry);
            } else if (ats === "ASHBY") {
              searchConfig.ashbyCompanies = searchConfig.ashbyCompanies || [];
              searchConfig.ashbyCompanies.push(companyEntry);
            } else if (ats === "WORKABLE") {
              searchConfig.workableCompanies = searchConfig.workableCompanies || [];
              searchConfig.workableCompanies.push(companyEntry);
            } else if (ats === "SOLIDES") {
              searchConfig.solidesCompanies = searchConfig.solidesCompanies || [];
              searchConfig.solidesCompanies.push(companyEntry);
            } else if (ats === "WORKDAY") {
              searchConfig.workdayCompanies = searchConfig.workdayCompanies || [];
              searchConfig.workdayCompanies.push(companyEntry);
            } else if (ats === "QUICKIN") {
              searchConfig.quickinCompanies = searchConfig.quickinCompanies || [];
              searchConfig.quickinCompanies.push(companyEntry);
            } else if (ats === "CUSTOM_SITE") {
              searchConfig.customSiteCompanies = searchConfig.customSiteCompanies || [];
              searchConfig.customSiteCompanies.push(companyEntry);
            } else if (ats === "LINKEDIN") {
              searchConfig.linkedinCompanies = searchConfig.linkedinCompanies || [];
              searchConfig.linkedinCompanies.push(companyEntry);
            }
          }
        }
      } else {
        unresolvedCount++;
        discoveredCompanies.push({
          name: comp.name,
          website: comp.website,
          atsMatch: null,
          status: "unresolved",
          sampleJobTitle: comp.sampleJobTitle,
          sampleLink: comp.sampleLink,
          tabOrSource: comp.tabOrSource,
          mentionsCount: comp.mentionsCount,
        });
      }
    }

    // 3. Atualizar contadores das fontes se não for dryRun
    if (!options.dryRun && newAddedCount > 0) {
      // Ordenar alfabeticamente as empresas dentro de cada ATS
      const sortFn = (a: any, b: any) => a.name.localeCompare(b.name, "pt-BR");
      searchConfig.gupyCompanies?.sort(sortFn);
      searchConfig.inhireCompanies?.sort(sortFn);
      searchConfig.greenhouseCompanies?.sort(sortFn);
      searchConfig.leverCompanies?.sort(sortFn);
      searchConfig.ashbyCompanies?.sort(sortFn);
      searchConfig.workableCompanies?.sort(sortFn);

      // Atualizar contadores no array sources
      searchConfig.solidesCompanies?.sort(sortFn);
      searchConfig.workdayCompanies?.sort(sortFn);
      searchConfig.quickinCompanies?.sort(sortFn);
      searchConfig.customSiteCompanies?.sort(sortFn);
      searchConfig.linkedinCompanies?.sort(sortFn);

      const ensureSource = (id: string, name: string, count: number) => {
        searchConfig.sources = searchConfig.sources || [];
        const existing = searchConfig.sources.find((s: any) => s.id === id);
        if (existing) {
          existing.name = `${name} (${count} Empresas)`;
        } else {
          searchConfig.sources.push({
            id,
            name: `${name} (${count} Empresas)`,
            type: "CLT",
            enabled: true,
            fastMode: true,
          });
        }
      };

      ensureSource("GUPY", "Gupy", searchConfig.gupyCompanies?.length || 0);
      ensureSource("INHIRE", "InHire", searchConfig.inhireCompanies?.length || 0);
      ensureSource("GREENHOUSE", "Greenhouse", searchConfig.greenhouseCompanies?.length || 0);
      ensureSource("LEVER", "Lever", searchConfig.leverCompanies?.length || 0);
      ensureSource("ASHBY", "Ashby", searchConfig.ashbyCompanies?.length || 0);
      ensureSource("WORKABLE", "Workable", searchConfig.workableCompanies?.length || 0);
      ensureSource("SOLIDES", "Solides", searchConfig.solidesCompanies?.length || 0);
      ensureSource("WORKDAY", "Workday", searchConfig.workdayCompanies?.length || 0);
      ensureSource("QUICKIN", "Quickin", searchConfig.quickinCompanies?.length || 0);
      ensureSource("CUSTOM_SITE", "Sites Próprios", searchConfig.customSiteCompanies?.length || 0);
      ensureSource("LINKEDIN", "LinkedIn Jobs", searchConfig.linkedinCompanies?.length || 0);

      // Gravar configuração atualizada
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(searchConfig, null, 2) + "\n", "utf-8");
    }

    const result: SheetImportResult = {
      source: options.source,
      totalTabs: tabsToProcess.length,
      totalRowsProcessed,
      totalUniqueCompanies: companyMap.size,
      matchedCount,
      newAddedCount,
      alreadyExistingCount,
      unresolvedCount,
      byAts,
      companies: discoveredCompanies,
      timestamp: new Date().toISOString(),
    };

    // Salvar relatório em JSON
    const reportPath = options.outputPath || REPORT_FILE;
    const reportDir = path.dirname(reportPath);
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), "utf-8");

    return result;
  }
}
