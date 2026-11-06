import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { CourseEntity } from './course.entity';
import { CreateCourseDto } from './dto/create-course.dto';

@Injectable()
export class CoursesService {
  constructor(
    @InjectRepository(CourseEntity)
    private readonly courses: Repository<CourseEntity>,
  ) {}

  list(): Promise<CourseEntity[]> {
    return this.courses.find({ order: { createdAt: 'DESC' } });
  }

  create(input: CreateCourseDto): Promise<CourseEntity> {
    const course = this.courses.create({
      id: randomUUID(),
      title: input.title.trim(),
      description: input.description?.trim() || null,
    });
    return this.courses.save(course);
  }
}
