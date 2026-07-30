FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .
ENV UPLOAD_DIR=/data/sop-uploads
EXPOSE 3000
CMD ["node", "server.js"]
