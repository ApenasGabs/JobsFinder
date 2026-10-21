import assert from "node:assert/strict";
import http from "node:http";
import { describe, it, beforeEach, afterEach } from "node:test";
import { WhatsAppBot } from "../server/bot/whatsapp.js";
import { ConfigService } from "../server/services/config.js";
import { ScraperHealthService } from "../server/services/scraper-health.js";
import { StorageService } from "../server/services/storage.js";
import { resilientFetch } from "../server/utils/fetch.js";

describe("Scrapers Resilience, Circuit Breaker and System Health Alerts", () => {
  let initialConfig: any;

  beforeEach(() => {
    initialConfig = JSON.parse(JSON.stringify(ConfigService.getConfig()));
    ScraperHealthService.reset();
    StorageService.setMockSyncFailures(0);
    WhatsAppBot.setMockStatus("connected");
    WhatsAppBot.setMockDisconnectedSince(null);
  });

  afterEach(() => {
    if (initialConfig) {
      ConfigService.updateConfig(initialConfig);
    }
    ScraperHealthService.reset();
    StorageService.setMockSyncFailures(0);
    WhatsAppBot.setMockStatus("connected");
    WhatsAppBot.setMockDisconnectedSince(null);
  });

  describe("resilientFetch", () => {
    it("deve abortar com erro de timeout quando o servidor demorar mais que o limite", async () => {
      // Cria um servidor HTTP lento que demora 200ms para responder
      const server = http.createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }, 300);
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;
      const url = `http://127.0.0.1:${port}/slow`;

      try {
        await assert.rejects(
          async () => {
            await resilientFetch(url, {
              timeoutMs: 50,
              maxRetries: 0,
              source: "TEST_TIMEOUT",
            });
          },
          (err: any) => {
            return (
              err?.name === "AbortError" ||
              err?.message?.includes("aborted") ||
              err?.code === "ABORT_ERR"
            );
          },
        );
      } finally {
        server.close();
      }
    });

    it("deve aplicar retentativa automática quando receber HTTP 500", async () => {
      let callCount = 0;
      const server = http.createServer((_req, res) => {
        callCount++;
        if (callCount === 1) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Error");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        }
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;
      const url = `http://127.0.0.1:${port}/retry-test`;

      try {
        const response = await resilientFetch(url, {
          timeoutMs: 2000,
          maxRetries: 1,
          retryDelayMs: 50,
          source: "TEST_RETRY",
        });

        assert.equal(response.status, 200);
        assert.equal(callCount, 2, "Deveria ter feito 2 chamadas (1 falha + 1 retry)");
      } finally {
        server.close();
      }
    });

    it("não deve retentar respostas determinísticas de cliente como HTTP 403", async () => {
      let callCount = 0;
      const server = http.createServer((_req, res) => {
        callCount++;
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;
      const url = `http://127.0.0.1:${port}/forbidden`;

      try {
        const response = await resilientFetch(url, {
          timeoutMs: 2000,
          maxRetries: 2,
          retryDelayMs: 50,
          source: "TEST_403",
        });

        assert.equal(response.status, 403);
        assert.equal(callCount, 1, "Não deve retentar código 403");
      } finally {
        server.close();
      }
    });
  });

  describe("Circuit Breaker e Cooldown por Fonte", () => {
    it("deve acionar Circuit Breaker após 3 falhas consecutivas e aplicar cooldown", () => {
      assert.equal(ScraperHealthService.isCircuitOpen("PROGRAMATHOR"), false);

      ScraperHealthService.recordFailure("PROGRAMATHOR", "Timeout 10s");
      assert.equal(ScraperHealthService.isCircuitOpen("PROGRAMATHOR"), false);

      ScraperHealthService.recordFailure("PROGRAMATHOR", "Timeout 10s");
      assert.equal(ScraperHealthService.isCircuitOpen("PROGRAMATHOR"), false);

      ScraperHealthService.recordFailure("PROGRAMATHOR", "Timeout 10s");
      // Na 3ª falha consecutiva, o circuit breaker deve abrir!
      assert.equal(
        ScraperHealthService.isCircuitOpen("PROGRAMATHOR"),
        true,
        "Circuit Breaker deve estar aberto após 3 falhas consecutivas",
      );

      const healthList = ScraperHealthService.getAllScrapersHealth();
      const progHealth = healthList.find((s) => s.id === "PROGRAMATHOR");
      assert.ok(progHealth);
      assert.equal(progHealth?.circuitBreakerOpen, true);
      assert.equal(progHealth?.status, "CIRCUIT_OPEN");
      assert.ok(progHealth?.circuitBreakerCooldownUntil);
    });

    it("deve restabelecer status saudável ao registrar sucesso", () => {
      ScraperHealthService.recordCircuitBreak("GEEKHUNTER", "Bloqueio Cloudflare", 600000);
      assert.equal(ScraperHealthService.isCircuitOpen("GEEKHUNTER"), true);

      // Registra sucesso após recuperação
      ScraperHealthService.recordSuccess("GEEKHUNTER", 12, 1500);

      assert.equal(
        ScraperHealthService.isCircuitOpen("GEEKHUNTER"),
        false,
        "Circuit breaker deve fechar após sucesso",
      );

      const health = ScraperHealthService.getAllScrapersHealth().find((s) => s.id === "GEEKHUNTER");
      assert.equal(health?.status, "HEALTHY");
      assert.equal(health?.consecutiveFailures, 0);
      assert.equal(health?.lastJobsFound, 12);
    });
  });

  describe("Alertas do Sistema (3 Cenários da Issue #6)", () => {
    it("Cenário 1: deve disparar alerta quando o WhatsApp estiver desconectado há muito tempo", () => {
      // Simula configuração habilitada do WhatsApp e desconexão de 20 minutos (1200 segundos)
      const config = ConfigService.getConfig();
      ConfigService.updateConfig({
        whatsapp: {
          enabled: true,
          targetGroupJid: "12345@g.us",
        },
      });

      WhatsAppBot.setMockStatus("disconnected");
      WhatsAppBot.setMockDisconnectedSince(Date.now() - 1200 * 1000);

      const alerts = ScraperHealthService.getActiveAlerts();
      const waAlert = alerts.find((a) => a.code === "WHATSAPP_DISCONNECTED");

      assert.ok(waAlert, "Deve emitir alerta WHATSAPP_DISCONNECTED");
      assert.equal(waAlert?.severity, "critical", "Acima de 15 minutos de desconexão deve ser crítico");
    });

    it("Cenário 2: deve disparar alerta quando uma fonte estiver com Circuit Breaker ou sem vagas", () => {
      ScraperHealthService.recordCircuitBreak("FREELAS_99", "Muitos timeouts", 300000);

      const alerts = ScraperHealthService.getActiveAlerts();
      const sourceAlert = alerts.find(
        (a) => a.code === "SOURCE_CIRCUIT_OPEN" && a.source === "FREELAS_99",
      );

      assert.ok(sourceAlert, "Deve emitir alerta SOURCE_CIRCUIT_OPEN para FREELAS_99");
      assert.equal(sourceAlert?.severity, "warning");
    });

    it("Cenário 3: deve disparar alerta quando o Supabase acumular falhas repetidas", () => {
      // Simula 4 falhas consecutivas de sincronização
      StorageService.setMockSyncFailures(4);

      // Garante que Supabase esteja configurado no teste
      process.env.SUPABASE_URL = "https://example.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

      const alerts = ScraperHealthService.getActiveAlerts();
      const supaAlert = alerts.find((a) => a.code === "SUPABASE_SYNC_FAILING");

      assert.ok(supaAlert, "Deve emitir alerta SUPABASE_SYNC_FAILING");
      assert.equal(supaAlert?.severity, "warning");
    });

    it("deve refletir o status global e métricas completas no relatório de integridade (getHealthReport)", () => {
      const reportHealthy = ScraperHealthService.getHealthReport();
      assert.ok(["ok", "degraded"].includes(reportHealthy.status));
      assert.ok(reportHealthy.memoryUsageMB.rss > 0);
      assert.ok(reportHealthy.scrapers.total >= 10);
      assert.ok(Array.isArray(reportHealthy.scrapers.sources));
      assert.ok(Array.isArray(reportHealthy.alerts));
    });
  });
});
