import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // No CORS: the browser reaches this API only through the frontend's /api proxy
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 8001;
  await app.listen(port);
  console.log(`Backend on http://localhost:${port}`);
}
void bootstrap();
