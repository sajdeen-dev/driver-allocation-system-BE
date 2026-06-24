# Real-Time Driver Allocation System — Technical Write-Up

**Candidate submission for vybe cabs — Backend Engineering Assignment**

---

## 1. What I Built — System Overview

I implemented a **Real-Time Driver Allocation System** that simulates the core ride-matching workflow of a ride-hailing platform. When a passenger requests a ride, the system discovers nearby available drivers, notifies multiple drivers at once, and assigns the ride to exactly **one** driver — the first to accept successfully.

### Architecture at a glance

```
Passenger API  →  NestJS Backend  →  PostgreSQL (source of truth)
                       ↓
                    Redis (GEO, locks, cache, idempotency)
                       ↓
                 WebSocket Gateway  →  Driver apps (Socket.IO)
```

### Core components

| Component | Responsibility |
|-----------|----------------|
| **Driver Module** | Register drivers, update GPS location, toggle online/offline |
| **Ride Module** | Create rides, orchestrate search batches, handle acceptance |
| **Redis Layer** | GEO indexing, ride state cache, atomic assignment via Lua |
| **WebSocket Gateway** | Push `ride:offer` events to drivers in real time |
| **PostgreSQL** | Persistent storage for drivers, rides, and assignments |

### API surface

- `POST /drivers` — register a driver
- `PATCH /drivers/:id/location` — update position (synced to Redis GEO)
- `PATCH /drivers/:id/status` — set ONLINE / OFFLINE
- `POST /rides` — request a ride (triggers geo search + notifications)
- `POST /rides/:rideId/accept` — driver accepts (with optional `Idempotency-Key` header)
- `GET /rides/:rideId` — inspect ride state and assignment

### Ride lifecycle states

| State | Meaning |
|-------|---------|
| `REQUESTED` | Ride record created in PostgreSQL |
| `SEARCHING` | Nearest drivers found; batch notification in progress |
| `ASSIGNED` | One driver won the atomic claim |
| `TIMEOUT` | No driver accepted after all batches exhausted |
| `COMPLETED` / `CANCELLED` | Extended states for future ride completion flows |

### End-to-end flow

1. Passenger calls `POST /rides`.
2. Ride is saved as `REQUESTED`, then immediately moved to `SEARCHING`.
3. Redis `GEOSEARCH` finds the nearest **5 online drivers** within a configurable radius (default 50 km).
4. All 5 drivers receive a simultaneous WebSocket `ride:offer` event.
5. A 30-second batch timer starts. If no one accepts, the system selects the **next 5 nearest drivers** (excluding already-notified ones) and repeats.
6. When a driver calls accept, a **Redis Lua script** atomically decides the winner.
7. Only after Redis confirms success does the backend persist the assignment in PostgreSQL.

This separation — **Redis decides, PostgreSQL persists** — is intentional and central to the concurrency design.

---

## 2. Design Choices

### Why Redis GEO for driver discovery?

Driver locations change frequently. Storing coordinates only in PostgreSQL would require expensive spatial queries on every ride request. Redis GEO commands (`GEOADD`, `GEOSEARCH`) provide:

- **Sub-millisecond proximity search** sorted by distance
- **Automatic index updates** when a driver moves (`PATCH /drivers/:id/location`)
- **Online filtering** via a companion Redis set (`drivers:online`) so offline drivers are excluded

When a driver goes offline, their entry is removed from both the GEO index and the online set. When they come back online, their last known coordinates are re-indexed.

### Why Redis Lua for assignment (not application-level locks)?

The critical requirement is: *multiple drivers accept at the same time; only one wins.*

An application-level approach (read state → check → write) fails under concurrency because two HTTP requests can both read "unassigned" before either writes. Even PostgreSQL row locks would work but add latency and couple assignment logic to the DB layer.

**Redis Lua scripts execute atomically on the Redis server** — no other command interleaves mid-script. The accept script performs, in one atomic unit:

1. Idempotency key lookup (return cached response if replay)
2. Check if ride already assigned (same driver → idempotent success; different driver → conflict)
3. Validate ride state is `SEARCHING`
4. Validate batch window is still active (TTL key exists)
5. **`SET NX`** on the assignment key — only the first writer succeeds
6. Update cached state to `ASSIGNED`
7. Store idempotency response

This is the industry-standard pattern for high-concurrency resource claiming (similar to ticket booking, inventory deduction, etc.).

### Why WebSocket (Socket.IO) for driver notification?

The assignment brief allows WebSockets, SSE, polling, or simulated logs. I chose **WebSocket via Socket.IO** because:

| Approach | Pros | Cons |
|----------|------|------|
| **WebSocket** ✅ | Real-time, bidirectional, low latency, native fit for driver apps | Requires connection management |
| SSE | Simple, one-way push | No bidirectional; less common in mobile driver apps |
| Polling | Easy to implement | High latency, wasted requests, poor UX under load |
| Log simulation | Good for testing | Not representative of production driver experience |

Drivers connect to namespace `/drivers?driverId=<uuid>` and join a per-driver room. When a batch is dispatched, the gateway emits `ride:offer` to all selected drivers **simultaneously** — matching the "notify multiple drivers at once" requirement.

For a production vybe cabs deployment, WebSocket also enables future features: driver ACK, live location streaming, and ride cancellation push.

### Batch timeout and retry logic

Rather than notifying all drivers in a city at once (noisy and wasteful), the system uses **batched escalation**:

- **Batch size:** 5 drivers (configurable via `RIDE_SEARCH_BATCH_SIZE`)
- **Window:** 30 seconds per batch (`RIDE_SEARCH_TIMEOUT_MS`)
- **Retry:** If batch expires with no acceptance, select the next 5 nearest drivers not yet notified
- **Terminal state:** If no drivers remain, mark ride `TIMEOUT`

The active batch is represented in Redis as `ride:{id}:batch:active` with a TTL matching the window. The Lua accept script checks this key — if it has expired, the accept fails with `BATCH_EXPIRED` even if the HTTP request arrives milliseconds after the timeout. This handles the edge case of **late acceptance after timeout**.

Before advancing to the next batch, the service re-checks that the ride is still `SEARCHING` and not already assigned — preventing duplicate batch dispatch if a driver accepted during the final milliseconds of a window.

---

## 3. Concurrency — How Race Conditions Are Handled

This was the most critical evaluation parameter. Here is exactly how races are prevented at each layer.

### Layer 1: Redis Lua — atomic claim (primary guarantee)

```
20 drivers → POST /rides/:id/accept (simultaneous)
                    ↓
            Redis EVALSHA (single-threaded per Redis instance)
                    ↓
         Driver A: SET NX assignment → OK  ✅ winner
         Driver B: SET NX assignment → FAIL ❌ LOST_RACE
         Driver C–T: same → FAIL
```

The `SET NX` (set if not exists) on `ride:{rideId}:assignment` ensures exactly one writer succeeds. All others receive a structured failure code (`LOST_RACE`, `ALREADY_CLAIMED`).

### Layer 2: Idempotency keys

Duplicate accepts from the **same driver** (network retry, double-tap, client bug) are handled via the `Idempotency-Key` HTTP header:

- First request: script runs, result stored at `idempotency:{rideId}:{driverId}:{key}`
- Retry with same key: script returns cached JSON — same success response, no duplicate assignment
- Same driver without key but assignment exists: returns `ALREADY_ASSIGNED` (idempotent success)

This satisfies the requirement that retried requests never produce inconsistent state.

### Layer 3: PostgreSQL defense in depth

After Redis confirms the winner, the service writes to PostgreSQL:

- Updates `rides.state`, `assigned_driver_id`, `assignment_time`
- Inserts one row into `ride_assignments` with a **UNIQUE constraint on `ride_id`**

If two application instances somehow both attempted persistence (extremely unlikely after Redis), the unique constraint prevents duplicate assignment rows.

### Layer 4: Automated verification

The concurrency test (`npm run test:concurrency`) is runnable by reviewers:

1. Creates 20 online drivers near the pickup point
2. Creates one ride
3. Fires 20 simultaneous accept requests via `Promise.all()`
4. Asserts exactly **1 success (HTTP 200)** and **19 failures (HTTP 4xx)**
5. Verifies exactly **1 row** in `ride_assignments`
6. Verifies idempotent retry returns the same success

---

## 4. What I Would Improve With More Time

### Replace in-process timers with a job queue (Bull / BullMQ)

Currently, batch timeout uses `setTimeout` inside the NestJS process. This works for the assignment scope but has limitations:

- Timers are lost if the process crashes or restarts
- Does not scale horizontally (each instance manages its own timers)

**Improvement:** Use BullMQ with delayed jobs keyed by `rideId + batchIndex`. On job fire, check Redis batch token before advancing. Jobs survive restarts and can be distributed across workers.

### Redis Cluster for horizontal scaling

A single Redis instance handles the assignment atomicity well, but at vybe cabs scale, GEO data and ride state would need Redis Cluster with hash-tag patterns (`{rideId}`) to keep related keys on the same shard for Lua script compatibility.

### Driver-in-batch validation

The current Lua script validates batch window expiry but does not verify the accepting driver was in the notified batch. A production system would store batch driver IDs in a Redis set and check membership inside the script.

### Ride completion and cancellation flows

States `COMPLETED` and `CANCELLED` exist in the enum but full API flows are not implemented. These would include driver/passenger-initiated cancellation and post-assignment lifecycle management.

### Structured observability

Add OpenTelemetry tracing across: ride request → GEO search → notification → accept → persist. Key metrics:

- `ride.search.batch.duration`
- `ride.accept.winner_latency`
- `ride.accept.conflict_count`
- `ride.timeout.rate`

---

## 5. Production Hardening Recommendations

### Scaling

| Concern | Recommendation |
|---------|----------------|
| API layer | Horizontal pod autoscaling (Kubernetes); stateless NestJS instances behind a load balancer |
| WebSocket | Sticky sessions or Redis adapter for Socket.IO cross-node broadcast |
| Redis | Redis Cluster with hash tags; separate read replicas for GEO queries if needed |
| PostgreSQL | Read replicas for ride history; primary for writes only |

### Failure recovery

- **Redis unavailable:** Circuit breaker on accept endpoint; queue accept attempts in Bull for retry; degrade to DB-only mode with advisory locks (slower but safe)
- **Process crash mid-search:** On startup, scan Redis for rides in `SEARCHING` with expired batch tokens and resume or timeout them
- **WebSocket disconnect:** Drivers fall back to polling `GET /rides/offers/:driverId` or receive push notifications via FCM/APNs

### Monitoring and alerting

- Alert on `ride.timeout.rate` exceeding threshold (supply/demand imbalance)
- Alert on Redis Lua script errors or elevated `LOST_RACE` rates (may indicate client bugs or abuse)
- Dashboard: active searches, assignment latency p50/p99, online driver count per zone

### Security

- JWT authentication for driver and passenger endpoints
- Rate limiting on accept endpoint per driver (prevent accept spam)
- Input validation via class-validator DTOs (already in place)
- Idempotency key TTL and scope enforcement

### Deployment

- Docker Compose for local/staging (included in repo)
- CI pipeline: lint → unit tests → concurrency integration test → build → deploy
- Database migrations via TypeORM migrations (replace `synchronize: true` used in development)

---

## Summary

This system delivers the core vybe cabs allocation workflow: **geo-based discovery, simultaneous multi-driver notification, atomic first-accept-wins assignment, batch timeout with retry, and idempotent acceptance** — all verifiable via included scripts and automated tests. The concurrency guarantee rests on Redis Lua atomicity rather than optimistic application logic, which is the approach I would stand behind in a production ride-hailing environment.

**Repository:** https://github.com/sajdeen-dev/driver-allocation-system-BE  
**Demo:** `./scripts/demo.sh` (normal flow) · `npm run test:concurrency` (concurrency proof)
