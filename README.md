# 🚀 S-Job-Crawler

Agregador e Web Crawler de vagas de alta performance, unificando a cobertura de **134 empresas da Gupy**, plataformas **CLT e Freelancer** (RemoteOK, Programathor, 99Freelas, GeekHunter), agendador 24/7 autônomo e **robô do WhatsApp via Baileys com envio para grupo específico**.

Projetado especificamente para rodar com **baixo consumo de recursos (CPU e RAM)**, ideal para servidores locais, PCs antigos rodando **ZimaOS** ou qualquer distribuição Linux via Docker.

---

## ⚡ Diferenciais de Performance e Arquitetura

- **Zero Sobrecarga de Navegador:** Para ~80% das fontes (incluindo as 134 empresas da Gupy e RemoteOK), o crawler consulta diretamente endpoints públicos e dados de hidratação SSR (`__NEXT_DATA__`) via HTTP assíncrono com pool de concorrência. Varre 110+ empresas em ~9 segundos.
- **Consumo de Memória Ultrabaixo:** O servidor backend e o banco em memória ocupam **menos de 50 MB de RAM**. O navegador Lightpanda consome apenas ~30 MB de RAM.
- **Deduplicação Rigorosa e Cold-Start:**
  - **Identificador Canônico Imutável:** Vagas recebem hash MD5 determinístico baseado na fonte e ID de origem (`gupy:banco-inter:123456`).
  - **Detecção de Novidades:** Apenas vagas nunca antes vistas recebem `isNew: true`.
  - **Cold-Start Anti-Spam:** Ao ligar o sistema pela primeira vez ou recarregar um banco existente, todas as vagas já salvas são marcadas com `notifiedAt`, garantindo que o bot do WhatsApp **nunca dispare centenas de vagas antigas** ao iniciar.
- **Bot WhatsApp (Baileys) Direcionado para Grupos:**
  - Pareamento fácil via QR Code na interface web.
  - Seleção de grupo de destino através de menu dropdown com listagem dinâmica de grupos.
  - Fila inteligente com delay de 3 segundos entre envios para evitar ban/bloqueio pelo WhatsApp.
  - Resumo em lote caso surjam mais de 5 vagas simultaneamente.
- **Streaming em Tempo Real (SSE):** As vagas aparecem na tela no mesmo instante em que são coletadas, sem esperas bloqueantes.
- **Persistência Assíncrona com Debounce:** Gravações no disco rígido do PC antigo são enfileiradas e agrupadas, poupando I/O.

---

## ⚡ Deploy Automático com 1 Comando (ZimaOS / Linux)

Se você estiver no terminal SSH do ZimaOS (ou qualquer servidor Linux), você pode rodar **um único comando** que baixa automaticamente o repositório se ele não existir, atualiza se já existir, configura os diretórios e sobe tudo no Docker:

```bash
curl -fsSL https://raw.githubusercontent.com/ApenasGabs/JobsFinder-client/main/deploy.sh | bash
```

> **Nota:** Se você renomear ou trocar a URL do repositório no futuro, basta passar a variável `REPO_URL`:
> ```bash
> REPO_URL="https://github.com/SEU_USUARIO/NOVO_REPO.git" bash -c "$(curl -fsSL https://raw.githubusercontent.com/.../deploy.sh)"
---

## 🖥️ Instalação Direta no ZimaOS via Interface Web (Add Custom App)

Se você não quer usar terminal/SSH e quer apenas colar um YAML no ZimaOS:

1. No seu **ZimaOS**, abra a **App Store** (ou clique no botão **`+`** na tela inicial).
2. Clique no canto superior em **"Custom Install"** (ou **"Import"**).
3. Cole o conteúdo do arquivo [docker-compose.zimaos.yml](file:///home/gabs/projetos/busca-vagas/S-Job-Crawler/docker-compose.zimaos.yml) (disponível abaixo).
4. Clique em **"Install"** / **"Submit"**.
5. **O container baixará automaticamente o repositório**, preparará o ambiente e criará o ícone do **S-Job-Crawler** direto na tela inicial do seu ZimaOS!

---

### 1. Iniciar Tudo no ZimaOS (Aplicação + Lightpanda local)

Caso prefira clonar manualmente:

```bash
git clone https://github.com/ApenasGabs/JobsFinder-client.git S-Job-Crawler
cd S-Job-Crawler
docker compose up -d --build
```

Acesse no seu navegador:
👉 **`http://<IP_DO_ZIMAOS>:3001`**

### 2. Volumes Persistentes no Docker
- `./data` ➔ Armazena `jobs.json` (banco de vagas salvas e status de notificação).
- `./config` ➔ Armazena `search.config.json` (termos de busca, empresas ativas, ID do grupo do WhatsApp).
- `./auth_baileys` ➔ Armazena as chaves de sessão do WhatsApp. **Você só precisa escanear o QR Code uma vez**; ao reiniciar o container, a conexão é restaurada automaticamente.

---

## 📲 Configuração do Bot do WhatsApp (Grupo Específico)

1. Acesse o painel web em `http://<IP_DO_ZIMAOS>:3001`.
2. No card do **Bot WhatsApp**, clique em **"Conectar WhatsApp"**.
3. Um modal abrirá exibindo o **QR Code**. Abra o WhatsApp no seu celular, vá em **Aparelhos Conectados** > **Conectar um aparelho** e escaneie o código.
4. Assim que conectar, o status mudará para **Conectado**.
5. No campo **Grupo de Destino**, selecione o grupo desejado da lista (os grupos em que seu número participa são detectados automaticamente).
6. Clique em **"Testar Envio"** para confirmar que o bot tem permissão de enviar mensagens no grupo selecionado.
7. Pronto! A cada ciclo do agendador (padrão a cada 30 minutos), todas as **vagas novas** serão enviadas formatadas diretamente no grupo.

---

## 🔍 Termos de Busca e Contagem Exata de Novas Vagas (Scheduler)

### Recomendações para `searchTerms` (`config/search.config.json`)
- **Termos Específicos Recomendados:** `java`, `react`, `node`, `typescript`, `fullstack`, `frontend`, `backend`, `python`, `devops`, `estagio`, `junior`.
- **Termos a Evitar ou Usar com Cautela:** Termos muito genéricos como `software`, `ux`, `designer` costumam retornar grande volume de vagas administrativas, comerciais ou de engenharia civil/industrial (ex: "Engenheiro de Software Embarcado em Trator", "Designer de Interiores", "Consultor Comercial de Software").
- **Garantia de Qualidade e Contagem de Vagas Novas:**
  - O Scheduler avalia cada vaga através do `TechClassifierService` com whitelist/blacklist para garantir que apenas vagas legítimas de Tecnologia/TI sejam processadas.
  - A contagem `"Varredura concluída: X vagas no total, Y novas"` baseia-se exclusivamente em vagas **genuinamente inéditas** (`isNew: true`), nunca antes salvas no banco de dados, descartando reingestões e deduplicando termos que cruzam as mesmas vagas em paralelo.
  - Ao despachar para o WhatsApp, o Scheduler registra com transparência exatamente quantas vagas foram aceitas pelos filtros de categoria do grupo.

---

## 🖥️ Arquitetura Flexível: Movendo o Navegador para Outra Máquina (Ubuntu Server)

Caso você queira rodar o crawler no ZimaOS e transferir a carga do navegador headless para uma máquina mais potente com **Ubuntu Server**, o sistema já vem preparado:

### No Ubuntu Server (Máquina potente):
Rode apenas o container do Lightpanda:
```bash
docker run -d \
  --name lightpanda \
  --restart unless-stopped \
  -p 9222:9222 \
  lightpanda/browser:nightly \
  serve --host 0.0.0.0 --port 9222
```

### No ZimaOS (`docker-compose.yml`):
1. Comente ou remova o bloco do serviço `lightpanda`.
2. Altere as variáveis de ambiente do `s-job-crawler`:
```yaml
environment:
  - LIGHTPANDA_HTTP=http://<IP_DO_UBUNTU_SERVER>:9222
  - LIGHTPANDA_WS=ws://<IP_DO_UBUNTU_SERVER>:9222
```
3. Reinicie com `docker compose up -d`. O crawler se comunicará via rede com o navegador na outra máquina sem nenhuma alteração no código.

---

## ⚙️ Configuração Centralizada de Stacks e Buscas

Você pode gerenciar as palavras-chave e empresas ativas tanto pela interface web (botão **Configurações**) quanto pelo arquivo `config/search.config.json`:

```json
{
  "searchTerms": [
    "java", "react", "node", "typescript", "fullstack", "frontend", "backend", "python", "devops", "estagio", "junior"
  ],
  "sources": [
    { "id": "GUPY", "name": "Gupy (134 Empresas)", "enabled": true },
    { "id": "REMOTEOK", "name": "RemoteOK (Global)", "enabled": true },
    { "id": "PROGRAMATHOR", "name": "Programathor", "enabled": true },
    { "id": "FREELAS_99", "name": "99Freelas", "enabled": true },
    { "id": "GEEKHUNTER", "name": "GeekHunter", "enabled": true }
  ],
  "whatsapp": {
    "enabled": true,
    "targetGroupId": "1203630XXXXXXXXX@g.us",
    "targetGroupName": "Vagas Tech TI"
  },
  "scheduler": {
    "enabled": true,
    "cronExpression": "*/30 * * * *"
  }
}
```

---

## 📡 Endpoints da API

| Método | Endpoint | Descrição |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Status da aplicação e consumo real de memória em MB |
| `GET` | `/api/config` | Retorna a configuração de busca, empresas e WhatsApp |
| `PUT` | `/api/config` | Atualiza termos, empresas ativas ou grupo do WhatsApp |
| `GET` | `/api/jobs` | Consulta vagas salvas com paginação e filtros |
| `GET` | `/api/stats` | Estatísticas agregadas por fonte e modalidade |
| `GET` | `/api/scrape/stream` | **Server-Sent Events (SSE)** disparando a varredura em tempo real |
| `GET` | `/api/whatsapp/status` | Status da conexão Baileys e QR Code atual |
| `GET` | `/api/whatsapp/groups` | Lista grupos participantes do WhatsApp |
| `POST` | `/api/whatsapp/config` | Salva grupo alvo selecionado |
| `POST` | `/api/whatsapp/test` | Envia mensagem de teste para o grupo |
| `POST` | `/api/scheduler/trigger` | Força execução imediata do ciclo de busca e notificação |
| `DELETE` | `/api/jobs` | Limpa o banco de vagas local |
