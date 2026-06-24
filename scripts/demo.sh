#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

echo "==> Register driver"
DRIVER_JSON=$(curl -s -X POST "$BASE_URL/drivers" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","phone":"+1555000'"$RANDOM"'"}')
echo "$DRIVER_JSON" | python3 -m json.tool
DRIVER_ID=$(echo "$DRIVER_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

echo ""
echo "==> Set location"
curl -s -X PATCH "$BASE_URL/drivers/$DRIVER_ID/location" \
  -H "Content-Type: application/json" \
  -d '{"latitude":12.9716,"longitude":77.5946}' | python3 -m json.tool

echo ""
echo "==> Go online"
curl -s -X PATCH "$BASE_URL/drivers/$DRIVER_ID/status" \
  -H "Content-Type: application/json" \
  -d '{"status":"ONLINE"}' | python3 -m json.tool

echo ""
echo "==> Request ride"
RIDE_JSON=$(curl -s -X POST "$BASE_URL/rides" \
  -H "Content-Type: application/json" \
  -d '{"passengerId":"p1","pickupLatitude":12.9716,"pickupLongitude":77.5946}')
echo "$RIDE_JSON" | python3 -m json.tool
RIDE_ID=$(echo "$RIDE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

echo ""
echo "==> Accept ride"
curl -s -X POST "$BASE_URL/rides/$RIDE_ID/accept" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: accept-1" \
  -d "{\"driverId\":\"$DRIVER_ID\"}" | python3 -m json.tool

echo ""
echo "Done. driverId=$DRIVER_ID rideId=$RIDE_ID"
