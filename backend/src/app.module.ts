import { Module } from '@nestjs/common';
import { RebarController } from './rebar/rebar.controller';
import { RebarService } from './rebar/rebar.service';

@Module({
  controllers: [RebarController],
  providers: [RebarService],
})
export class AppModule {}
