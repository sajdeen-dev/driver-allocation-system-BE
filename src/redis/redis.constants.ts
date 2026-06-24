/**
 * Atomic ride acceptance Lua script.
 *
 * Concurrency design:
 * - All acceptance checks and mutations run in a single Redis EVAL — no read-modify-write races.
 * - SETNX on assignment key ensures exactly one driver wins across concurrent accept calls.
 * - Idempotency keys are stored with SET NX so duplicate retries return the original outcome.
 * - Batch expiry is checked inside the script so late accepts fail even if HTTP arrives after timeout.
 *
 * KEYS:
 *   [1] ride:{rideId}:assignment   — winner record (JSON)
 *   [2] ride:{rideId}:state        — cached ride state
 *   [3] ride:{rideId}:batch:active — active batch token (expires with batch TTL)
 *   [4] idempotency:{key}          — optional idempotency record
 *
 * ARGV:
 *   [1] driverId
 *   [2] rideId
 *   [3] assignmentTime (ISO-8601)
 *   [4] idempotencyKey (empty string if absent)
 *   [5] assignedState
 *   [6] idempotencyTtlSeconds
 *
 * Returns JSON string:
 *   { success, code, rideId, driverId?, assignmentTime?, message? }
 */
export const ACCEPT_RIDE_LUA = `
local assignmentKey = KEYS[1]
local stateKey = KEYS[2]
local batchKey = KEYS[3]
local idempotencyKey = KEYS[4]

local driverId = ARGV[1]
local rideId = ARGV[2]
local assignmentTime = ARGV[3]
local idempotencyToken = ARGV[4]
local assignedState = ARGV[5]
local idempotencyTtl = tonumber(ARGV[6])

local function respond(success, code, message, winnerDriverId, winnerAssignmentTime)
  return cjson.encode({
    success = success,
    code = code,
    rideId = rideId,
    driverId = winnerDriverId,
    assignmentTime = winnerAssignmentTime,
    message = message
  })
end

-- Idempotent replay: same client token always gets the same stored response.
if idempotencyToken ~= '' then
  local cached = redis.call('GET', idempotencyKey)
  if cached then
    return cached
  end
end

local existing = redis.call('GET', assignmentKey)
if existing then
  local parsed = cjson.decode(existing)
  if parsed.driverId == driverId then
    local result = respond(true, 'ALREADY_ASSIGNED', 'Ride already assigned to this driver (idempotent).', parsed.driverId, parsed.assignmentTime)
    if idempotencyToken ~= '' then
      redis.call('SET', idempotencyKey, result, 'EX', idempotencyTtl, 'NX')
    end
    return result
  end
  local result = respond(false, 'ALREADY_CLAIMED', 'Ride already assigned to another driver.', parsed.driverId, parsed.assignmentTime)
  if idempotencyToken ~= '' then
    redis.call('SET', idempotencyKey, result, 'EX', idempotencyTtl, 'NX')
  end
  return result
end

local currentState = redis.call('GET', stateKey)
if currentState == 'TIMEOUT' or currentState == 'CANCELLED' or currentState == 'COMPLETED' then
  return respond(false, 'RIDE_NOT_ACCEPTABLE', 'Ride is no longer accepting drivers.', nil, nil)
end

if currentState ~= 'SEARCHING' then
  return respond(false, 'INVALID_STATE', 'Ride is not in SEARCHING state.', nil, nil)
end

-- Batch token missing means this search window expired; late accepts must fail.
if redis.call('EXISTS', batchKey) == 0 then
  return respond(false, 'BATCH_EXPIRED', 'Acceptance window expired for current driver batch.', nil, nil)
end

local payload = cjson.encode({
  rideId = rideId,
  driverId = driverId,
  assignmentTime = assignmentTime
})

-- Atomic claim: only the first SETNX succeeds under concurrent load.
local claimed = redis.call('SET', assignmentKey, payload, 'NX')
if not claimed then
  local winner = redis.call('GET', assignmentKey)
  if winner then
    local parsed = cjson.decode(winner)
    if parsed.driverId == driverId then
      return respond(true, 'ALREADY_ASSIGNED', 'Ride already assigned to this driver (idempotent).', parsed.driverId, parsed.assignmentTime)
    end
    return respond(false, 'LOST_RACE', 'Another driver claimed the ride first.', parsed.driverId, parsed.assignmentTime)
  end
  return respond(false, 'LOST_RACE', 'Another driver claimed the ride first.', nil, nil)
end

redis.call('SET', stateKey, assignedState)
redis.call('DEL', batchKey)

local result = respond(true, 'ASSIGNED', 'Ride assigned successfully.', driverId, assignmentTime)
if idempotencyToken ~= '' then
  redis.call('SET', idempotencyKey, result, 'EX', idempotencyTtl, 'NX')
end
return result
`;

export const REDIS_KEYS = {
  driversGeo: 'drivers:geo',
  driversOnline: 'drivers:online',
  driverStatus: (driverId: string) => `driver:${driverId}:status`,
  rideState: (rideId: string) => `ride:${rideId}:state`,
  rideAssignment: (rideId: string) => `ride:${rideId}:assignment`,
  rideBatchActive: (rideId: string) => `ride:${rideId}:batch:active`,
  rideNotifiedDrivers: (rideId: string) => `ride:${rideId}:notified`,
  rideBatchDrivers: (rideId: string, batchIndex: number) =>
    `ride:${rideId}:batch:${batchIndex}:drivers`,
  idempotency: (key: string) => `idempotency:${key}`,
} as const;
