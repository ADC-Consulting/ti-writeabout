FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .
COPY writeathon.html .
EXPOSE 3000
CMD ["node", "server.js"]
