import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RehearsalTurnEntity } from './rehearsal-turn.entity';
import { RehearsalEntity } from './rehearsal.entity';
import { RehearsalsService } from './rehearsals.service';

/** Registers rehearsal and rehearsal-turn persistence repositories. */
@Module({
  imports: [TypeOrmModule.forFeature([RehearsalEntity, RehearsalTurnEntity])],
  providers: [RehearsalsService],
})
export class RehearsalsModule {}
