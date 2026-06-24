import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

export interface RideOfferPayload {
  rideId: string;
  pickupLatitude: number;
  pickupLongitude: number;
  batchIndex: number;
  expiresAt: string;
}

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/drivers',
})
export class DriverGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(DriverGateway.name);
  private readonly driverSockets = new Map<string, Set<string>>();

  handleConnection(client: Socket): void {
    const driverId = client.handshake.query.driverId;
    if (typeof driverId !== 'string' || !driverId) {
      this.logger.warn(`Client ${client.id} connected without driverId`);
      return;
    }

    client.join(`driver:${driverId}`);

    if (!this.driverSockets.has(driverId)) {
      this.driverSockets.set(driverId, new Set());
    }
    this.driverSockets.get(driverId)!.add(client.id);
    this.logger.log(`Driver ${driverId} connected (socket ${client.id})`);
  }

  handleDisconnect(client: Socket): void {
    for (const [driverId, sockets] of this.driverSockets.entries()) {
      if (sockets.delete(client.id) && sockets.size === 0) {
        this.driverSockets.delete(driverId);
      }
    }
  }

  /**
   * Notifies all drivers in a batch simultaneously via Socket.IO rooms.
   * Each driver joins room `driver:{driverId}` on connect for targeted delivery.
   */
  notifyDriversBatch(driverIds: string[], payload: RideOfferPayload): void {
    for (const driverId of driverIds) {
      this.server.to(`driver:${driverId}`).emit('ride:offer', payload);
    }
    this.logger.log(
      `Notified ${driverIds.length} drivers for ride ${payload.rideId} (batch ${payload.batchIndex})`,
    );
  }
}
