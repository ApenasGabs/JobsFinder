import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { urlList } from "../../link";

/**
 * Utilitário para pausar a execução por um determinado tempo em milissegundos
 * Descomente essa função se precisar implementar atrasos entre ações
 */
// const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Função principal que automatiza a busca por vagas de emprego em diferentes empresas
 * Utiliza puppeteer para acessar os sites das empresas, realizar buscas e extrair informações
 * @returns {Promise<void>}
 */
async function searchJobs() {
  // Inicia uma instância do navegador Chrome usando puppeteer
  // headless: false - abre uma janela visível do navegador
  // defaultViewport: null - usa o tamanho padrão da janela
  // userDataDir - salva a sessão para reuso
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    userDataDir: "/tmp/myChromeSession",
  });

  // Array que armazenará os resultados da busca
  const newJobs = [];
  try {
    // Abre uma nova página no navegador
    const page = await browser.newPage();

    // Lista de termos para busca de vagas
    // Os termos comentados podem ser descomentados conforme necessidade
    const ListSearch = [
      // "front",
      // "back",
      // "fullstack",
      // "devops",
      // "mobile",
      // "junior",
      "java",
      "jr",
    ];

    // Loop através de cada URL de empresa definida no arquivo link.js
    for (const url of urlList) {
      // Objeto para armazenar as vagas de uma empresa específica
      const companyJobs = { empresa: url.name, vagas: [] };

      // Loop através de cada termo de busca
      for (const query of ListSearch) {
        try {
          // Navega para a URL da empresa e aguarda até que a rede esteja ociosa
          await page.goto(url.link, { waitUntil: "networkidle0" });

          // Verifica a quantidade de vagas disponíveis
          const amount = await page.evaluate(() => {
            const amount = document.querySelector(
              "p[data-testid=\"job-list-amount\"]",
            )?.innerText;
            return amount;
          });

          // Se houver mais de 10 vagas, tenta aumentar o número de itens por página
          if (amount > 10) {
            console.log("amount: ", amount);
            const itemPorPag = document.querySelector(
              "input[name=\"items-por-pagina\"]",
            );
            if (itemPorPag) {
              itemPorPag.value = "50";
            }
          }

          // Localiza o campo de busca, clica nele, digita o termo de busca e pressiona Enter
          const inputSelector = "[data-testid=\"job-search\"]";
          await page.waitForSelector(inputSelector);
          await page.click(inputSelector);
          await page.type(inputSelector, query);
          await page.keyboard.press("Enter");

          // Extrai informações das vagas encontradas na página
          const vagas = await page.evaluate(() => {
            // Seleciona todos os itens da lista de vagas
            const itens = Array.from(
              document.querySelectorAll("ul[data-testid=\"job-list__list\"] > li"),
            );

            // Mapeia cada item para extrair informações relevantes
            return itens.map((li) => {
              // Extrai o nome da vaga
              const nomeVaga = li.querySelector(
                "div> div:nth-child(1)",
              )?.innerText;

              // Extrai o modelo de trabalho (ex: Remoto, Presencial, Híbrido)
              const modeloVaga = li.querySelector(
                "div> div:nth-child(2)",
              )?.innerText;

              // Extrai o link para a página detalhada da vaga
              const linkVaga = li.querySelector(
                "a[data-testid=\"job-list__listitem-href\"]",
              )?.href;

              // Registra a data de coleta da informação
              const data = new Date().toISOString();

              return {
                nomeVaga,
                linkVaga,
                modeloVaga,
                data,
              };
            });
          });

          // Poderia adicionar um delay aqui se necessário
          // await delay(6000);

          // Adiciona as vagas encontradas ao objeto da empresa atual
          companyJobs.vagas.push(...vagas);
        } catch (err) {
          // Registra erros específicos para cada URL/empresa
          console.error(
            `Erro ao processar a URL ${url.link} da ${url.name}: ${err}`,
          );
        }
      }

      // Adiciona as vagas da empresa atual ao array de resultados
      newJobs.push(companyJobs);
    }
  } catch (err) {
    // Captura e registra erros gerais que podem ocorrer durante o processo
    console.error(`Erro geral: ${err}`);
  } finally {
    // Fecha o navegador após concluir todas as operações
    await browser.close();

    // Obtém o diretório do arquivo atual para salvar os resultados
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const filePath = path.join(dir, "jobResults.json");

    // Lê o arquivo de resultados existente, se houver
    fs.readFile(filePath, (err, data) => {
      // Se o arquivo não existir ou houver erro na leitura, inicializa um array vazio
      const existingJobs = err ? [] : JSON.parse(data.toString());

      // Processa cada nova empresa/vaga encontrada
      for (const newJob of newJobs) {
        // Verifica se a empresa já existe no arquivo de resultados
        const existingCompany = existingJobs.find(
          (job) => job.empresa === newJob.empresa,
        );

        if (existingCompany) {
          // Se a empresa já existe, verifica cada vaga para evitar duplicatas
          for (const newVaga of newJob.vagas) {
            const vagaExists = existingCompany.vagas.some(
              (vaga) => vaga.nomeVaga === newVaga.nomeVaga
                && vaga.linkVaga === newVaga.linkVaga,
            );
            // Adiciona apenas vagas que ainda não existem
            if (!vagaExists) {
              existingCompany.vagas.push(newVaga);
            }
          }
        } else {
          // Se a empresa não existe, adiciona-a com todas as suas vagas
          existingJobs.push(newJob);
        }
      }

      // Salva o arquivo atualizado com as novas vagas
      fs.writeFile(filePath, JSON.stringify(existingJobs, null, 2), (err) => {
        if (err) {
          console.error("Erro ao salvar o arquivo:", err);
        } else {
          console.log("Dados atualizados salvos em jobResults.json");
        }
      });
    });
  }
}

// Executa a função quando o arquivo é importado
searchJobs();

// Exporta a função para uso em outros módulos
export default searchJobs;
