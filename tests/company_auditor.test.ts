import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { CompanyAuditorService } from "../server/services/company-auditor.js";
import { ConfigService } from "../server/services/config.js";
import { CompanyConfig } from "../server/types.js";

describe("CompanyAuditorService - Unit Tests", () => {
  describe("normalizeAts", () => {
    it("should correctly normalize valid ATS platforms case-insensitively", () => {
      assert.equal(CompanyAuditorService.normalizeAts("gupy"), "GUPY");
      assert.equal(CompanyAuditorService.normalizeAts("GUPY"), "GUPY");
      assert.equal(CompanyAuditorService.normalizeAts("greenhouse"), "GREENHOUSE");
      assert.equal(CompanyAuditorService.normalizeAts("Lever"), "LEVER");
      assert.equal(CompanyAuditorService.normalizeAts("ASHBY"), "ASHBY");
      assert.equal(CompanyAuditorService.normalizeAts("workable"), "WORKABLE");
      assert.equal(CompanyAuditorService.normalizeAts("inhire"), "INHIRE");
    });

    it("should return null for unsupported ATS platforms", () => {
      assert.equal(CompanyAuditorService.normalizeAts("unknown-ats"), null);
      assert.equal(CompanyAuditorService.normalizeAts(""), null);
    });
  });

  describe("getEndpoint", () => {
    it("should format correct Greenhouse API endpoint", () => {
      const ep = CompanyAuditorService.getEndpoint("GREENHOUSE", "agibank");
      assert.equal(ep.url, "https://boards-api.greenhouse.io/v1/boards/agibank/jobs");
      assert.equal(ep.method, "GET");
    });

    it("should format correct Gupy portal endpoint with slug or custom link", () => {
      const ep1 = CompanyAuditorService.getEndpoint("GUPY", "agibank");
      assert.equal(ep1.url, "https://agibank.gupy.io");

      const ep2 = CompanyAuditorService.getEndpoint("GUPY", "custom", "https://carreiras.custom.com.br/");
      assert.equal(ep2.url, "https://carreiras.custom.com.br");
    });

    it("should format correct Lever API endpoint", () => {
      const ep = CompanyAuditorService.getEndpoint("LEVER", "nubank");
      assert.equal(ep.url, "https://api.lever.co/v0/postings/nubank?mode=json");
      assert.equal(ep.method, "GET");
    });

    it("should format correct Workable POST endpoint", () => {
      const ep = CompanyAuditorService.getEndpoint("WORKABLE", "moodle");
      assert.equal(ep.url, "https://apply.workable.com/api/v2/accounts/moodle/jobs");
      assert.equal(ep.method, "POST");
    });
  });

  describe("verifySingle & auditCompany (Live Case: Agibank)", () => {
    it("should verify Agibank successfully on Greenhouse with active jobs", async () => {
      const result = await CompanyAuditorService.verifySingle("GREENHOUSE", "agibank");
      assert.equal(result.ok, true);
      assert.equal(result.httpStatus, 200);
      assert.ok(typeof result.jobsCount === "number" && result.jobsCount > 0, "Deveria encontrar vagas no Greenhouse do Agibank");
    });

    it("should detect that Agibank on Gupy returns 404 (Migrated/Broken)", async () => {
      const result = await CompanyAuditorService.verifySingle("GUPY", "agibank");
      assert.equal(result.ok, false);
      assert.equal(result.httpStatus, 404);
      assert.ok(result.error?.includes("404"));
    });

    it("should audit an active Greenhouse company returning status OK", async () => {
      const comp: CompanyConfig = {
        name: "Agibank",
        slug: "agibank",
        link: "https://boards.greenhouse.io/agibank",
        enabled: true,
      };
      const audit = await CompanyAuditorService.auditCompany("GREENHOUSE", comp);
      assert.equal(audit.status, "OK");
      assert.equal(audit.httpStatus, 200);
      assert.equal(audit.slug, "agibank");
    });

    it("should audit a broken Gupy company returning status BROKEN", async () => {
      const comp: CompanyConfig = {
        name: "Agibank Antigo",
        slug: "agibank",
        link: "https://agibank.gupy.io",
        enabled: true,
      };
      const audit = await CompanyAuditorService.auditCompany("GUPY", comp);
      assert.equal(audit.status, "BROKEN");
      assert.equal(audit.httpStatus, 404);
    });
  });

  describe("Company Management CRUD", () => {
    const testSlug = "kraken-test-company";

    after(() => {
      // Cleanup pós teste
      CompanyAuditorService.deleteCompany("GREENHOUSE", testSlug);
    });

    it("should add a new company to config", () => {
      const addRes = CompanyAuditorService.addCompany("GREENHOUSE", {
        name: "Kraken Test Co",
        slug: testSlug,
        link: `https://boards.greenhouse.io/${testSlug}`,
        enabled: true,
      });

      assert.equal(addRes.success, true);
      assert.equal(addRes.company?.slug, testSlug);

      const config = ConfigService.getConfig();
      const found = (config.greenhouseCompanies || []).find((c) => c.slug === testSlug);
      assert.ok(found, "Empresa deve estar persistida na configuração");
    });

    it("should prevent duplicate company registration for same slug and ATS", () => {
      const dupRes = CompanyAuditorService.addCompany("GREENHOUSE", {
        name: "Kraken Test Duplicate",
        slug: testSlug,
      });

      assert.equal(dupRes.success, false);
      assert.ok(dupRes.error?.includes("já está cadastrada"));
    });

    it("should update company status or attributes", () => {
      const updateRes = CompanyAuditorService.updateCompany("GREENHOUSE", testSlug, {
        enabled: false,
        status: "broken_link",
      });

      assert.equal(updateRes.success, true);
      assert.equal(updateRes.company?.enabled, false);
      assert.equal(updateRes.company?.status, "broken_link");
    });

    it("should delete company from config", () => {
      const delRes = CompanyAuditorService.deleteCompany("GREENHOUSE", testSlug);
      assert.equal(delRes.success, true);

      const config = ConfigService.getConfig();
      const found = (config.greenhouseCompanies || []).find((c) => c.slug === testSlug);
      assert.equal(found, undefined, "Empresa deve ser removida da lista");
    });
  });
});
