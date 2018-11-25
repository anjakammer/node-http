FROM node:9-slim
ENV PORT 8080
EXPOSE 8080
USER node
WORKDIR /home/node/app
COPY . .
RUN npm --unsafe-perm install
CMD ["npm", "start"]
