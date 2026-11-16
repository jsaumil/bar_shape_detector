# Rebar finder API (NestJS + the finder in finder/), run directly by Bun
FROM oven/bun:1.3.14

# tesseract: OCR of dimension numbers when they are not in the PDF text
# fonts: the length labels drawn in the shape images
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng fonts-dejavu-core fontconfig \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Packages first, so this layer is cached until package.json or bun.lock change
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# Uploads and results (mount a volume here to keep them)
RUN mkdir -p /app/jobs && chown -R bun:bun /app/jobs
USER bun

ENV NODE_ENV=production PORT=8001 JOBS_DIR=/app/jobs
EXPOSE 8001
CMD ["bun", "src/main.ts"]
