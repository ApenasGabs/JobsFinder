# JobsFinder

Um web crawler automatizado para ajudar na busca de vagas de emprego.

## 📋 Descrição

JobsFinder é uma ferramenta que automatiza a busca de vagas de emprego em diversas empresas. Ele utiliza Puppeteer para navegar nos sites de empregos, realizar buscas com termos específicos e coletar informações sobre as vagas disponíveis.

## 🚀 Instalação

1. Clone o repositório:

```bash
git clone https://github.com/seu-usuario/JobsFinder.git
cd JobsFinder
```

2. Instale as dependências:

```bash
npm install
# ou
yarn
```

## ⚙️ Configuração

O projeto utiliza um arquivo `link.js` na raiz para definir as empresas e URLs onde o crawler irá buscar vagas. Exemplo de estrutura:

```javascript
export const urlList = [
  {
    name: "Nome da Empresa",
    link: "https://site-de-vagas-da-empresa.com"
  },
  // Adicione mais empresas conforme necessário
];
```

## 🔍 Como usar

### Buscar vagas

Para executar a pesquisa de vagas:

```bash
npm run search-jobs
# ou
yarn search-jobs
```

Este comando irá:

- Iniciar um navegador Chrome através do Puppeteer
- Acessar cada site de empresa configurado
- Buscar por vagas usando os termos definidos
- Salvar os resultados em `src/utils/jobResults.json`

### Personalizar a busca

Os termos de busca podem ser configurados em `src/utils/searchJobs.js` modificando o array `ListSearch`.

### Iniciar o servidor (em desenvolvimento)

Para iniciar o servidor de desenvolvimento:

```bash
npm start
# ou
yarn start
```

## 🛠️ Tecnologias utilizadas

- Node.js
- Express
- Puppeteer
- ESLint (Airbnb style guide)

## 📄 Licença

Este projeto está sob a licença MIT - veja o arquivo [LICENSE](LICENSE) para detalhes.
