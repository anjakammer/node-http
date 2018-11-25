FROM node:9-slim
ENV PORT 8080
EXPOSE 8080

WORKDIR /home/node/app
COPY . .
RUN chown -R node:node /home/node

USER node
ENV HOME /home/node

RUN npm --unsafe-perm install
CMD ["npm", "start"]
