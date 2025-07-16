FROM node:20-bookworm 

RUN apt-get update && apt-get install -y \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
    libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libxrender1 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN npm init -y && npm install playwright@latest @aws-sdk/client-s3

RUN npx playwright install --with-deps chromium

COPY executor.js .

CMD ["node", "executor.js"]