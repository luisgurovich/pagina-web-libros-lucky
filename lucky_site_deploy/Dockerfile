FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p /app/data /app/private/books \
    && chown -R node:node /app

USER node
EXPOSE 3000

CMD ["npm", "start"]
