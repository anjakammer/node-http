FROM node:9-slim
ENV PORT 8080
EXPOSE 8080

RUN chown -R node:node /home/node
WORKDIR /home/node/app
COPY . .

USER node

RUN npm install
CMD ["npm", "start"]
