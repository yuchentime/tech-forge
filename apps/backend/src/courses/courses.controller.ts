import { Body, Controller, Get, Post } from '@nestjs/common';
import { CourseEntity } from './course.entity';
import { CoursesService } from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';

@Controller('courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  list(): Promise<CourseEntity[]> {
    return this.courses.list();
  }

  @Post()
  create(@Body() input: CreateCourseDto): Promise<CourseEntity> {
    return this.courses.create(input);
  }
}
