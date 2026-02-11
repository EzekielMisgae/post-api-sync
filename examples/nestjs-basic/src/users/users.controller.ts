import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateUserDto } from './create-user.dto';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID' })
  getUser(@Param('id') id: string, @Query('include') include?: string) {
    return { id, include };
  }

  @Post()
  @ApiOperation({ summary: 'Create user' })
  createUser(@Body() dto: CreateUserDto) {
    return dto;
  }
}
