import fs from "fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "path";
import { fileURLToPath } from "url";
import {
  extractAtsFromUrl,
  generateCandidateSlugs,
  normalizeString,
} from "../server/services/company-finder.js";
import {
  extractGoogleSheetId,
  SheetImporterService,
} from "../server/services/sheet-importer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Sheet Importer & Company Finder - Unit Tests", () => {
  describe("extractGoogleSheetId", () => {
    it("should extract sheet ID from various Google Sheets URL formats", () => {
      const url1 = "https://docs.google.com/spreadsheets/d/1A1tjyeb_n5WuYfdA6GnNsFAFJwS95IWKRadz-Td9fQ0/edit?gid=1619215734#gid=1619215734";
      assert.equal(extractGoogleSheetId(url1), "1A1tjyeb_n5WuYfdA6GnNsFAFJwS95IWKRadz-Td9fQ0");

      const url2 = "https://docs.google.com/spreadsheets/d/abc-123_XYZ/export?format=xlsx";
      assert.equal(extractGoogleSheetId(url2), "abc-123_XYZ");
    });

    it("should return null for non-Google Sheets URLs", () => {
      assert.equal(extractGoogleSheetId("https://example.com/sheet.xlsx"), null);
      assert.equal(extractGoogleSheetId(""), null);
    });
  });

  describe("extractAtsFromUrl", () => {
    it("should detect Gupy URLs and extract slug", () => {
      const match = extractAtsFromUrl("https://vagasagendalovers.gupy.io/job/eyJqb2JJZCI6MTE1MDIyOTUsInNvdXJjZSI6ImxpbmtlZGluIn0=?jobBoardSource=linkedin");
      assert.ok(match);
      assert.equal(match.ats, "GUPY");
      assert.equal(match.slug, "vagasagendalovers");
      assert.equal(match.portalUrl, "https://vagasagendalovers.gupy.io");
    });

    it("should detect InHire URLs and extract slug", () => {
      const match1 = extractAtsFromUrl("https://nuvemshop-tiendanube.inhire.app/vagas/545d7f40-70d9-4050-b14a-aa274210294e/executivo-de-vendas");
      assert.ok(match1);
      assert.equal(match1.ats, "INHIRE");
      assert.equal(match1.slug, "nuvemshop-tiendanube");

      const match2 = extractAtsFromUrl("https://grupogopwr.inhire.app/huggy/vagas/4085dbd0-e5fc-4554-8816-faf3ebffe0a1");
      assert.ok(match2);
      assert.equal(match2.ats, "INHIRE");
      assert.equal(match2.slug, "huggy");
    });

    it("should detect Greenhouse URLs and extract slug", () => {
      const match = extractAtsFromUrl("https://job-boards.greenhouse.io/arcoeducacao/jobs/5614480004");
      assert.ok(match);
      assert.equal(match.ats, "GREENHOUSE");
      assert.equal(match.slug, "arcoeducacao");
      assert.equal(match.portalUrl, "https://boards.greenhouse.io/arcoeducacao");
    });

    it("should detect Lever URLs and extract slug", () => {
      const match = extractAtsFromUrl("https://jobs.lever.co/ciandt/a1b2c3d4");
      assert.ok(match);
      assert.equal(match.ats, "LEVER");
      assert.equal(match.slug, "ciandt");
      assert.equal(match.portalUrl, "https://jobs.lever.co/ciandt");
    });

    it("should detect Ashby URLs and extract slug", () => {
      const match = extractAtsFromUrl("https://jobs.ashbyhq.com/sierra-studio/3b117a75-f1b6-48e0-8809-4ba3c6edae59");
      assert.ok(match);
      assert.equal(match.ats, "ASHBY");
      assert.equal(match.slug, "sierra-studio");
      assert.equal(match.portalUrl, "https://jobs.ashbyhq.com/sierra-studio");
    });

    it("should detect Workable URLs and extract slug", () => {
      const match = extractAtsFromUrl("https://apply.workable.com/futureplc/j/12345");
      assert.ok(match);
      assert.equal(match.ats, "WORKABLE");
      assert.equal(match.slug, "futureplc");
      assert.equal(match.portalUrl, "https://apply.workable.com/futureplc");
    });

    it("should detect Solides URLs and extract slug", () => {
      const match = extractAtsFromUrl("https://pontotel.vagas.solides.com.br/vaga/123");
      assert.ok(match);
      assert.equal(match.ats, "SOLIDES");
      assert.equal(match.slug, "pontotel");
      assert.equal(match.portalUrl, "https://pontotel.vagas.solides.com.br");
    });

    it("should detect Quickin URLs and extract slug", () => {
      const match = extractAtsFromUrl("https://jobs.quickin.io/ipm/jobs/123");
      assert.ok(match);
      assert.equal(match.ats, "QUICKIN");
      assert.equal(match.slug, "ipm");
    });

    it("should detect Workday URLs", () => {
      const match = extractAtsFromUrl("https://thomsonreuters.wd5.myworkdayjobs.com/External_Career_Site");
      assert.ok(match);
      assert.equal(match.ats, "WORKDAY");
    });

    it("should detect Custom Site and LinkedIn URLs", () => {
      const matchLi = extractAtsFromUrl("https://www.linkedin.com/jobs/view/12345");
      assert.ok(matchLi);
      assert.equal(matchLi.ats, "LINKEDIN");

      const matchCustom = extractAtsFromUrl("https://carreiras.ifood.com.br");
      assert.ok(matchCustom);
      assert.equal(matchCustom.ats, "CUSTOM_SITE");
    });

    it("should return null for non-job and non-career links", () => {
      assert.equal(extractAtsFromUrl("https://www.google.com/search?q=teste"), null);
      assert.equal(extractAtsFromUrl("https://facebook.com/feed"), null);
      assert.equal(extractAtsFromUrl(""), null);
    });
  });

  describe("generateCandidateSlugs", () => {
    it("should normalize accents, expand '&' and remove corporate suffixes", () => {
      const slugs = generateCandidateSlugs("CI&T S.A.");
      assert.ok(slugs.includes("ciandt"));
      assert.ok(slugs.includes("cit"));

      const slugs2 = generateCandidateSlugs("Grão de Gente Tecnologia", "https://graodegente.com.br");
      assert.ok(slugs2.includes("graodegente"));
    });
  });

  describe("SheetImporterService Dry Run", () => {
    it("should parse the local spreadsheet in dry-run mode without modifying config", async () => {
      const candidates = [
        "/workspace/busca-vagas/empresas para conferir.xlsx",
        path.resolve(__dirname, "../../empresas_toxicas_lista.xlsx"),
        path.resolve(__dirname, "../../empresas para conferir.xlsx"),
        path.resolve(__dirname, "../empresas_toxicas_lista.xlsx"),
      ];
      const localFile = candidates.find((f) => fs.existsSync(f)) || candidates[0];
      const result = await SheetImporterService.import({
        source: localFile,
        dryRun: true,
        probe: false, // Sem probe de rede nos testes unitários rápidos
        limitTabs: 1,
      });

      assert.ok(result.totalUniqueCompanies > 0);
      assert.ok(result.totalRowsProcessed > 0);
      assert.ok(result.newAddedCount >= 0); // dry-run reports candidate count
    });

    it("should parse the centralized spreadsheet correctly ignoring summary tabs", async () => {
      const candidates = [
        "/workspace/busca-vagas/empresas_carreiras_centralizadas.xlsx",
        path.resolve(__dirname, "../../empresas_carreiras_centralizadas.xlsx"),
        path.resolve(__dirname, "../empresas_carreiras_centralizadas.xlsx"),
      ];
      const centralizedFile = candidates.find((f) => fs.existsSync(f)) || candidates[0];
      const result = await SheetImporterService.import({
        source: centralizedFile,
        dryRun: true,
        probe: false,
      });

      assert.ok(result.totalUniqueCompanies > 2000);
      assert.ok(result.totalRowsProcessed > 2000);
      assert.ok(result.matchedCount > 500);
    });
  });
});
