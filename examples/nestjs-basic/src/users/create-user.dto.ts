import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ example: 'Ada Lovelace' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'ada@example.com' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ example: 'engineering' })
  @IsOptional()
  @IsString()
  team?: string;
}
