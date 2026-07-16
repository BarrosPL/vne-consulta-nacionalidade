FROM mcr.microsoft.com/playwright:v1.61.0-noble

WORKDIR /app

COPY --chown=pwuser:pwuser package*.json ./
RUN npm ci --omit=dev

COPY --chown=pwuser:pwuser . .

ENV NODE_ENV=production \
    TZ=America/Sao_Paulo

USER pwuser

CMD ["npm", "run", "scheduler"]
