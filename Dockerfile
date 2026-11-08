FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY scripts ./scripts
COPY public ./public
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "server.js"]
