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
      assert.equal(CompanyAuditorService.normalizeAts("totvs"), "TOTVS");
    });

    it("should return null for unsupported ATS platforms", () => {
      assert.equal(CompanyAuditorService.normalizeAts("unknown-ats"), null);
      assert.equal(CompanyAuditorService.normalizeAts(""), null);
    });
  });

  describe("getEndpoint", () => {
    it("should format correct TOTVS portal endpoint", () => {
      const ep1 = CompanyAuditorService.getEndpoint("TOTVS", "vempratotvs");
      assert.equal(ep1.url, "https://atracaodetalentos.totvs.app/vempratotvs");
      assert.equal(ep1.method, "GET");

      const ep2 = CompanyAuditorService.getEndpoint(
        "TOTVS",
        "estuda",
        "https://atracaodetalentos.totvs.app/estuda/",
      );
      assert.equal(ep2.url, "https://atracaodetalentos.totvs.app/estuda");
    });
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

  describe("TOTVS redirect 404 & auditAll coverage", () => {
    it("should treat TOTVS HTTP 200 redirected to ?status=404 as 404 / BROKEN in verifySingle and auditCompany", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        const res = new Response("<html>Not found</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
        Object.defineProperty(res, "url", {
          value: "https://atracaodetalentos.totvs.app/?status=404",
        });
        return res;
      };

      try {
        const verifyRes = await CompanyAuditorService.verifySingle(
          "TOTVS",
          "nonexistent-slug-12345",
        );
        assert.equal(verifyRes.ok, false);
        assert.equal(verifyRes.httpStatus, 404);
        assert.ok(verifyRes.error?.includes("404"));

        const auditRes = await CompanyAuditorService.auditCompany("TOTVS", {
          name: "Inexistente",
          slug: "nonexistent-slug-12345",
          link: "https://atracaodetalentos.totvs.app/nonexistent-slug-12345",
          enabled: true,
        });
        assert.equal(auditRes.status, "BROKEN");
        assert.equal(auditRes.httpStatus, 404);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should include TOTVS companies when auditAll is invoked without ats filter", async () => {
      const originalFetch = globalThis.fetch;
      const originalGetConfig = ConfigService.getConfig;
      const originalUpdateConfig = ConfigService.updateConfig;
      const checkedUrls: string[] = [];

      ConfigService.getConfig = () => ({
        searchTerms: [],
        seniorityLevels: [],
        contractTypes: [],
        sources: [],
        gupyCompanies: [],
        greenhouseCompanies: [],
        leverCompanies: [],
        ashbyCompanies: [],
        workableCompanies: [],
        inhireCompanies: [],
        solidesCompanies: [],
        quickinCompanies: [],
        smartrecruitersCompanies: [],
        totvsCompanies: [
          {
            name: "TOTVS",
            slug: "vempratotvs",
            link: "https://atracaodetalentos.totvs.app/vempratotvs",
            enabled: true,
          },
        ],
      });
      ConfigService.updateConfig = (patch) => ({
        ...ConfigService.getConfig(),
        ...patch,
      });
      globalThis.fetch = async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        checkedUrls.push(url);
        const res = new Response("<html>OK</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
        Object.defineProperty(res, "url", { value: url });
        return res;
      };

      try {
        const report = await CompanyAuditorService.auditAll();
        assert.equal(report.totalChecked, 1);
        assert.equal(report.healthyCount, 1);
        assert.equal(report.results[0].ats, "TOTVS");
        assert.equal(report.results[0].slug, "vempratotvs");
        assert.ok(
          checkedUrls.includes("https://atracaodetalentos.totvs.app/vempratotvs"),
        );
      } finally {
        globalThis.fetch = originalFetch;
        ConfigService.getConfig = originalGetConfig;
        ConfigService.updateConfig = originalUpdateConfig;
      }
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
