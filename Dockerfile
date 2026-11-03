# Estágio 1: Build do Frontend React/Vite
FROM node:22-alpine AS builder

WORKDIR /app

# Instala dependências
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile || yarn install

# Copia código fonte e compila o bundle estático do frontend
COPY . .
RUN yarn build

# Estágio 2: Imagem final de Produção ultra-leve
FROM node:22-alpine

WORKDIR /app

# Instala git para suporte ao AutoUpdater no boot/restart
RUN apk add --no-cache git

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
ENV AUTH_BAILEYS_DIR=/app/auth_baileys
ENV NODE_OPTIONS="--max-old-space-size=384"

# Copia package.json e instala dependências de produção
COPY package.json yarn.lock ./
RUN yarn install --production --ignore-scripts --prefer-offline || yarn install --production

# Adiciona tsx para execução direta de TypeScript no runtime do Node
RUN yarn add tsx

# Copia o backend, configurações e os arquivos estáticos gerados no estágio 1
COPY server ./server
COPY config ./config
COPY --from=builder /app/dist ./dist

# Garante a existência dos diretórios de persistência
RUN mkdir -p /app/data /app/auth_baileys

EXPOSE 3001

CMD ["npx", "tsx", "server/index.ts"]

