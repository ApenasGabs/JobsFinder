import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AutoUpdaterService } from "../server/utils/autoUpdater.js";

const BUILD_SHA_FILE = path.resolve(process.cwd(), "dist/.build-sha");

describe("AutoUpdaterService - BUILD_SHA fallback", () => {
  let originalEnvSha: string | undefined;
  let hadBuildShaFile = false;
  let originalBuildShaContent = "";

  beforeEach(() => {
    originalEnvSha = process.env.APP_BUILD_SHA;
    hadBuildShaFile = fs.existsSync(BUILD_SHA_FILE);
    if (hadBuildShaFile) {
      originalBuildShaContent = fs.readFileSync(BUILD_SHA_FILE, "utf-8");
      fs.unlinkSync(BUILD_SHA_FILE);
    }
  });

  afterEach(() => {
    if (originalEnvSha !== undefined) {
      process.env.APP_BUILD_SHA = originalEnvSha;
    } else {
      delete process.env.APP_BUILD_SHA;
    }

    if (hadBuildShaFile) {
      fs.mkdirSync(path.dirname(BUILD_SHA_FILE), { recursive: true });
      fs.writeFileSync(BUILD_SHA_FILE, originalBuildShaContent, "utf-8");
    } else if (fs.existsSync(BUILD_SHA_FILE)) {
      fs.unlinkSync(BUILD_SHA_FILE);
    }
  });

  it("should fall back to APP_BUILD_SHA when dist/.build-sha does not exist", () => {
    process.env.APP_BUILD_SHA = "abc1234567890def";
    assert.equal(AutoUpdaterService.getBuiltSha(), "abc1234567890def");
  });

  it("should ignore 'unknown' or empty APP_BUILD_SHA and return null", () => {
    process.env.APP_BUILD_SHA = "unknown";
    assert.equal(AutoUpdaterService.getBuiltSha(), null);

    process.env.APP_BUILD_SHA = "   ";
    assert.equal(AutoUpdaterService.getBuiltSha(), null);
  });

  it("should prioritize dist/.build-sha written by writeBuiltSha over APP_BUILD_SHA", () => {
    process.env.APP_BUILD_SHA = "env-sha-fallback";
    AutoUpdaterService.writeBuiltSha("file-sha-1234567\n");
    assert.equal(AutoUpdaterService.getBuiltSha(), "file-sha-1234567");
  });

  it("should return a valid currentSha when inside a git repository", () => {
    const sha = AutoUpdaterService.getCurrentSha();
    assert.match(sha, /^[0-9a-f]{40}$/);
  });
});
