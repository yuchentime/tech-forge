import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDatabaseOptions } from './database/database.options';
import { CoursesModule } from './courses/courses.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }),
    HealthModule,
    CoursesModule,
  ],
})
export class AppModule {}
