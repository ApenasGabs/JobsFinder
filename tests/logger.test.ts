import assert from "node:assert";
import { describe, it } from "node:test";
import { LoggerService } from "../server/services/logger.js";

describe("LoggerService Unit Tests", () => {
  it("should record an INFO log entry in the ring buffer", () => {
    const entry = LoggerService.info(
      "CLASSIFIER",
      "TEST_JOB_ACCEPTED",
      "Vaga de Engenharia de Software aprovada",
      { title: "Engenheiro de Software", company: "TechCorp" },
    );

    assert.strictEqual(entry.category, "CLASSIFIER");
    assert.strictEqual(entry.level, "INFO");
    assert.strictEqual(entry.event, "TEST_JOB_ACCEPTED");
    assert.strictEqual(
      entry.message,
      "Vaga de Engenharia de Software aprovada",
    );
    assert.deepStrictEqual(entry.details, {
      title: "Engenheiro de Software",
      company: "TechCorp",
    });
  });

  it("should filter logs by category correctly", () => {
    LoggerService.info(
      "WHATSAPP",
      "WA_BATCH_TEST",
      "Disparo de teste WhatsApp",
    );
    LoggerService.warn(
      "CRAWLER",
      "CRAWL_WARN_TEST",
      "Aviso de teste no crawler",
    );

    const waLogs = LoggerService.getLogs({ category: "WHATSAPP", limit: 10 });
    assert.ok(waLogs.length > 0);
    assert.ok(waLogs.every((l) => l.category === "WHATSAPP"));
  });

  it("should filter logs by level and search term", () => {
    LoggerService.error(
      "SYSTEM",
      "TEST_ERROR",
      "Falha crítica simulada para teste",
      { code: 500 },
    );

    const errorLogs = LoggerService.getLogs({
      level: "ERROR",
      search: "simulada",
    });
    assert.ok(errorLogs.length >= 1);
    assert.strictEqual(errorLogs[0].level, "ERROR");
    assert.ok(errorLogs[0].message.includes("simulada"));
  });

  it("should provide accurate stats summary", () => {
    const stats = LoggerService.getStats();
    assert.ok(typeof stats.total === "number");
    assert.ok(typeof stats.errors === "number");
    assert.ok(typeof stats.warnings === "number");
    assert.ok(typeof stats.byCategory === "object");
    assert.ok(stats.retentionDays >= 7);
  });

  it("should redact sensitive keys in details", () => {
    const log = LoggerService.info(
      "SYSTEM",
      "AUTH_EVENT",
      "Evento com dados sensiveis",
      {
        user: "admin",
        token: "super_secret_token_123",
        password: "mypassword",
      },
    );

    assert.strictEqual(log.details?.token, "***REDACTED***");
    assert.strictEqual(log.details?.password, "***REDACTED***");
    assert.strictEqual(log.details?.user, "admin");
  });
});
