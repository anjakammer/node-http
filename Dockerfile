FROM node:9-slim
ENV PORT 8080
EXPOSE 8080

WORKDIR /home/node/app
COPY . .

RUN chown -R node:node /home/node
USER node
<<<<<<< HEAD
RUN npm --unsafe-perm install
=======

RUN npm install
>>>>>>> 974b6e7cdcafbe48c674666e7643e5d02ddda007
CMD ["npm", "start"]
