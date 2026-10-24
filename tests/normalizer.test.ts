import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectContractType,
  detectSeniority,
  detectWorkModel,
  extractStack,
  slugifyInHire,
} from "../server/utils/normalizer.js";

describe("Normalizer Utility", () => {
  describe("detectWorkModel", () => {
    it("should detect REMOTE correctly", () => {
      assert.equal(detectWorkModel("Desenvolvedor Remoto Fullstack"), "REMOTO");
      assert.equal(
        detectWorkModel("Senior Software Engineer (Remote - Brasil)"),
        "REMOTO",
      );
      assert.equal(
        detectWorkModel("Trabalho Home Office / Anywhere"),
        "REMOTO",
      );
      assert.equal(detectWorkModel("Teletrabalho Brasil"), "REMOTO");
    });

    it("should detect HIBRIDO correctly", () => {
      assert.equal(
        detectWorkModel("Engenheiro de Software Híbrido Campinas"),
        "HIBRIDO",
      );
      assert.equal(
        detectWorkModel("Product Designer (Hybrid - SP)"),
        "HIBRIDO",
      );
    });

    it("should detect PRESENCIAL correctly", () => {
      assert.equal(
        detectWorkModel("Analista de Suporte Presencial São Paulo"),
        "PRESENCIAL",
      );
      assert.equal(
        detectWorkModel("Desenvolvedor On-site Manaus"),
        "PRESENCIAL",
      );
      assert.equal(detectWorkModel("Técnico no local"), "PRESENCIAL");
    });

    it("should return NAO_INFORMADO for ambiguous strings", () => {
      assert.equal(
        detectWorkModel("Pessoa Desenvolvedora Java"),
        "NAO_INFORMADO",
      );
    });
  });

  describe("detectSeniority", () => {
    it("should detect ESTAGIO correctly", () => {
      assert.equal(
        detectSeniority("Estágio em Desenvolvimento de Software"),
        "ESTAGIO",
      );
      assert.equal(detectSeniority("Intern - Software Engineering"), "ESTAGIO");
      assert.equal(detectSeniority("Programa de Estagiário 2026"), "ESTAGIO");
    });

    it("should detect JUNIOR correctly", () => {
      assert.equal(detectSeniority("Desenvolvedor Frontend Júnior"), "JUNIOR");
      assert.equal(detectSeniority("Junior Backend Developer"), "JUNIOR");
      assert.equal(detectSeniority("Dev Jr (Node.js)"), "JUNIOR");
    });

    it("should detect PLENO correctly (including default when unspecified)", () => {
      assert.equal(detectSeniority("Desenvolvedor Fullstack Pleno"), "PLENO");
      assert.equal(detectSeniority("Mid-level React Engineer"), "PLENO");
      assert.equal(detectSeniority("Intermediate Python Developer"), "PLENO");
      assert.equal(detectSeniority("Software Engineer II"), "PLENO");
      assert.equal(
        detectSeniority(
          "[1201] Pessoa Desenvolvedora Fullstack Pl (React/Python)",
        ),
        "PLENO",
      );
      // Sem senioridade explícita deve assumir PLENO
      assert.equal(detectSeniority("Software Engineer (Backend)"), "PLENO");
      assert.equal(detectSeniority("Product Designer"), "PLENO");
    });

    it("should detect SENIOR correctly", () => {
      assert.equal(
        detectSeniority(
          "Pessoa Desenvolvedora Android Sr - Meios de pagamento",
        ),
        "SENIOR",
      );
      assert.equal(detectSeniority("Senior Java Architect"), "SENIOR");
      assert.equal(detectSeniority("Tech Lead / Senior Engineer"), "SENIOR");
      assert.equal(detectSeniority("Software Engineer III"), "SENIOR");
    });

    it("should detect ESPECIALISTA correctly", () => {
      assert.equal(
        detectSeniority("[1164] Especialista em IA Generativa (AWS/Azure)"),
        "ESPECIALISTA",
      );
      assert.equal(
        detectSeniority("Staff Engineer / Principal Specialist"),
        "ESPECIALISTA",
      );
    });
  });

  describe("detectContractType", () => {
    it("should detect ESTAGIO contract without false-positiving internal/international", () => {
      assert.equal(detectContractType("Vaga de Estágio em TI"), "ESTAGIO");
      assert.equal(detectContractType("Internship 2026"), "ESTAGIO");
      assert.equal(detectContractType("Software Engineering Intern"), "ESTAGIO");
      assert.equal(
        detectContractType("Senior Internal Tools Engineer", "CLT"),
        "CLT",
      );
      assert.equal(
        detectContractType("International Backend Developer", "CLT"),
        "CLT",
      );
      assert.equal(
        detectContractType("Internet Banking Software Engineer", "CLT"),
        "CLT",
      );
    });

    it("should detect PJ contract", () => {
      assert.equal(
        detectContractType("Desenvolvedor Node (Contrato PJ)"),
        "PJ",
      );
      assert.equal(detectContractType("Consultor TI - Pessoa Jurídica"), "PJ");
    });

    it("should detect FREELANCER contract", () => {
      assert.equal(detectContractType("Freelance UI Designer"), "FREELANCER");
      assert.equal(
        detectContractType("Job Freelancer de 3 meses"),
        "FREELANCER",
      );
    });

    it("should default to fallback (CLT)", () => {
      assert.equal(
        detectContractType("Desenvolvedor Backend Java", "CLT"),
        "CLT",
      );
    });
  });

  describe("extractStack", () => {
    it("should extract multiple tech stacks from title and description", () => {
      const text =
        "[1201] Pessoa Desenvolvedora Fullstack Pl (React/Python) com Docker e AWS";
      const stack = extractStack(text);
      assert.ok(stack.includes("React"));
      assert.ok(stack.includes("Python"));
      assert.ok(stack.includes("Docker"));
      assert.ok(stack.includes("AWS"));
    });

    it("should extract .NET and C#", () => {
      const text = "[1298] Pessoa Desenvolvedora Backend .NET MVC Sr (Remoto)";
      const stack = extractStack(text);
      assert.ok(stack.includes(".NET"));
    });

    it("should extract Java without false-positiving JavaScript", () => {
      const text = "Analista de Desenvolvimento Back-end Java Pl (Remoto)";
      const stack = extractStack(text);
      assert.ok(stack.includes("Java"));
      assert.ok(!stack.includes("JavaScript"));
    });
  });

  describe("slugifyInHire", () => {
    const cases = [
      [
        "Banco de Talentos Exclusivo para Diversidade",
        "banco-de-talentos-exclusivo-para-diversidade",
      ],
      [
        "Não encontrou uma vaga? Cadastre-se aqui!",
        "nao-encontrou-uma-vaga-cadastre-se-aqui",
      ],
      [
        "[1164] Especialista em IA Generativa (AWS/Azure/Copilot Studio) (Híbrido - São Paulo)",
        "1164-especialista-em-ia-generativa-awsazurecopilot-studio-hibrido-sao-paulo",
      ],
      [
        "[1201-1202] Pessoa Desenvolvedora Fullstack Pl (React/Python)",
        "1201-1202-pessoa-desenvolvedora-fullstack-pl-reactpython",
      ],
      [
        "[1203-1204] Analista de Machine Learning PL",
        "1203-1204-analista-de-machine-learning-pl",
      ],
      [
        "[1206] Analista de Desenvolvimento Back-end Java Pl (Remoto)",
        "1206-analista-de-desenvolvimento-back-end-java-pl-remoto",
      ],
      [
        "[1281] UI/UX Designer (Híbrido - Campinas)",
        "1281-uiux-designer-hibrido-campinas",
      ],
      [
        "[1285] Pessoa Desenvolvedora Fullstack Pl",
        "1285-pessoa-desenvolvedora-fullstack-pl",
      ],
      [
        "[1288] Pessoa Desenvolvedora Fullstack Pl (Python | React/Angular) (Remoto)",
        "1288-pessoa-desenvolvedora-fullstack-pl-python-or-reactangular-remoto",
      ],
      [
        "[1290] Pessoa Desenvolvedora Android Sr - Meios de pagamento (Remoto)",
        "1290-pessoa-desenvolvedora-android-sr-meios-de-pagamento-remoto",
      ],
      [
        "[1291] Analista de FP&A Pl (Híbrido - Manaus)",
        "1291-analista-de-fpanda-pl-hibrido-manaus",
      ],
      [
        "[1293] Pessoa Desenvolvedora Front-end React Sr (Remoto)",
        "1293-pessoa-desenvolvedora-front-end-react-sr-remoto",
      ],
      [
        "[1294] Pessoa Desenvolvedora Fullstack IA Generativa Sr (Remoto)",
        "1294-pessoa-desenvolvedora-fullstack-ia-generativa-sr-remoto",
      ],
      [
        "[1298] Pessoa Desenvolvedora Backend .NET MVC Sr (Remoto)",
        "1298-pessoa-desenvolvedora-backend-net-mvc-sr-remoto",
      ],
    ];

    for (const [input, expected] of cases) {
      it(`should correctly slugify: "${input}"`, () => {
        assert.equal(slugifyInHire(input), expected);
      });
    }
  });
});
