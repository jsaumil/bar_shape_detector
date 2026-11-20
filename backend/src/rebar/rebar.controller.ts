import { BadRequestException, Body, Controller, Get, Logger, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { type AnalyzeOptions, RebarService } from './rebar.service';

@Controller('api')
export class RebarController {
  private readonly logger = new Logger('Rebar');

  constructor(private readonly rebar: RebarService) {}

  // multipart form: file=<pdf>, optional mmPerPt, scale, verticalRatio, pages
  @Post('analyze')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  analyze(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: AnalyzeOptions) {
    if (!file) {
      this.logger.warn('analyze rejected: no file uploaded');
      throw new BadRequestException('Upload a PDF as "file"');
    }
    if (!file.buffer.subarray(0, 5).toString().startsWith('%PDF')) {
      this.logger.warn(`analyze rejected: "${file.originalname}" is not a PDF`);
      throw new BadRequestException('Not a PDF');
    }
    return this.rebar.analyze(file.buffer, body, file.originalname);
  }

  @Get('jobs/:id/shapes/:file')
  shapeImage(@Param('id') id: string, @Param('file') file: string, @Res() res: Response) {
    res.sendFile(this.rebar.filePath(id, 'shapes', file));
  }

  @Get('jobs/:id/:file')
  jobFile(@Param('id') id: string, @Param('file') file: string, @Res() res: Response) {
    res.sendFile(this.rebar.filePath(id, file));
  }
}
