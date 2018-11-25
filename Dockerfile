FROM node:9-slim
ENV PORT 8080
EXPOSE 8080
WORKDIR /home/node/app
COPY . .
USER node
RUN npm --unsafe-perm install
CMD ["npm", "start"]
