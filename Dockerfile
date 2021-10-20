FROM node:17-slim
ENV PORT 8080
EXPOSE 8080

WORKDIR /home/node/app
COPY . .

RUN chown -R node:node /home/node
USER node

RUN npm install
CMD ["npm", "start"]
