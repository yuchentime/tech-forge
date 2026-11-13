import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/** Query for the classroom landing list: active and ended lessons share one endpoint. */
export class ListLessonsQueryDto {
  @IsOptional()
  @IsIn(['active', 'ended'])
  status?: 'active' | 'ended';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** One teacher message for a classroom turn; the agent appends it and one student reply. */
export class SendLessonTurnDto {
  @IsString()
  @Length(1, 20_000)
  text!: string;
}
