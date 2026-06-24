import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { DriverModule } from './driver/driver.module';
import { RideModule } from './ride/ride.module';
import { WebsocketModule } from './websocket/websocket.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.example'],
    }),
    DatabaseModule,
    RedisModule,
    DriverModule,
    RideModule,
    WebsocketModule,
  ],
})
export class AppModule {}
