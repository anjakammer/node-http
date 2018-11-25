FROM node:9-slim
ENV PORT 8080
EXPOSE 8080
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
WORKDIR /home/node/app
COPY . .
USER node
RUN npm --unsafe-perm install
CMD ["npm", "start"]
