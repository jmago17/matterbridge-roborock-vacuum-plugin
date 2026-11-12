# Fork notes: `1.1.9-minis.2` (jmago17)

Current branch: `minis/v1-map-transport-20261112`, based on `ed8c7a5`.
Private local/fork distribution only; no npm publication or upstream PR.

## 1.1.9-minis.2: V1 map transport (offline validation)

### Evidence and bounded changes

- `V10MessageDispatcher.getMapInfo` and `getMapInfoV2` now explicitly send
  `get_multi_maps_list` with `params: []` and `forceMqtt: true`. Previously a ready
  LAN client could receive the request and `params` was omitted from JSON.
- `forceMqtt` is a request routing option, independent of `secure`. The map-list
  request remains ordinary JSON RPC (outer protocol 101, DPS 101, correlated DPS
  id, reply protocol 102), NOT a binary-map request. It does not add security.
  `get_room_mapping` also has explicit `params: []`, retaining LAN when ready
  and the existing MQTT fallback when LAN is absent/not ready/reconnecting.
  This is not a new retry-after-LAN-timeout policy.
- `ClientRouter.query` now arms its response promise before sending. An immediate
  reply during `send` previously marked the listener settled before a resolver
  existed, then its later `waitFor` could never resolve or reject. A synthetic
  encrypted reply delivered before publish completion reproduces the ordering
  and verifies the corrected path. Timers/listeners are disposed after send
  failure, timeout or successful response.
- Startup and background retries still request room mapping if map-list lookup
  throws or returns an empty timeout result. Without map metadata, room tuples
  carry segment/name-id/tag, not a map identity. Only AFTER obtaining nonempty
  mapping, V1 can verify a current map with a read-only `get_status` RPC:
  integer `map_status >>> 2` (zero is valid). If verification is unavailable,
  nothing is published under an assumed floor 0. A verified fallback map is
  named `Map <id>` until a real map list supplies its name; there is no hardcoded
  Casa/layout/HA dependency. A fallback floor is re-verified on the next query.
- The push listener no longer assigns a bare V1 room response to map 0 when it
  has never received map metadata; the query fallback handles that situation.
- Retry generation tokens prevent cancelled/replaced/in-flight work from
  publishing areas, repopulating room names after shutdown or scheduling another
  retry. `clearAll` cancels both timers and requests-in-flight logically; it does
  not abort an already transmitted RPC or the transport itself. The existing
  30s/60s/120s/300s/600s sequential schedule is unchanged. Exhaustion diagnostics
  no longer suggest a different account/region as though it were a diagnosis.
- No auth/login, room-cleaning command, routine, endpoint identity, pairing or
  permission changes. Version/lock metadata updated; `private: true` retained.

### References checked at immutable commits

1. `mathiashornbek/homebridge-roborock-matter`
   `36c35800cb46335bdaedc5bc868317b0542942b9`:
   `roborockLib/lib/messageQueueHandler.js` forces cloud for map list;
   `message.js` uses DPS 101 on both transports and security for MQTT;
   `vacuum.js` requests room mapping before the status fallback, decoding
   raw map_status with a two-bit shift.
2. `Python-roborock/python-roborock`
   `ed5f8591cccc204c1643b00b31d52d7ff43cede1`:
   `roborock/devices/traits/v1/maps.py` declares MapsTrait on mqtt_rpc_channel.

The absence of `security` is NOT established as the cause of this robot's
failures. Do not blindly set `secure: true` to select MQTT. The existing secure
get_map_v1 nonce/endpoint path is unchanged and regression-tested separately
from the per-frame nonce. Global LAN outer-4/DPS-4 behavior is also unchanged:
this patch makes map-list requests outer-101/DPS-101 by choosing MQTT. A global
DPS/security migration remains a separate interoperability change, not silently
included here. LAN timeout recovery beyond readiness fallback is not solved.

### Validation and next stage

Offline Mac validation on 2026-11-12: **2548 tests / 198 files PASS**, TypeScript
`tsc --noEmit` PASS, production TypeScript build PASS, scoped ESLint PASS and
formatting PASS. Baseline was 2523 tests / 196 files. Environment: Node 25.8.1,
npm 11.11.0, Matterbridge 3.11.2 (linked locally after npm ci). Node 24, the
package's declared runtime, was not available in this environment; no Node or
system package installation was performed to hide that limitation.

Tests cover MQTT selection with a ready LAN, both query/live map-list paths,
explicit parameters, DPS/header separation, session security nonce versus frame
nonce, encrypted protocol-102 round-trip with wrong id/device rejection and a
reply before send completes, fallback mapping after failed lists, valid map 0,
nonzero map identity, unchanged routine/area IDs, and cancellation during list,
room and name requests. Full-suite/build/package evidence is recorded in the
project ESTADO and the release validation report alongside the tarball.

This release has NOT been installed or exercised against a real robot. MQTT
selection/params and the response race are code-level findings, not a proven
root cause of the five real timeouts on minis.1. The same EU account was already
verified in HA and the plugin; do not change authentication to test this patch.
Future authorized validation must be read-only, with multiple-map switching
OFF: inspect get_multi_maps_list/get_room_mapping (get_status only if needed),
then ServiceArea, identities, routine, Matter reachability and the untouched
hass endpoint 1. Never invoke load_multi_map, cleaning, execute/reset/pairing.

## Historical 1.1.9-minis.1

Fork of RinDevJunior/matterbridge-roborock-vacuum-plugin 1.1.9, branch `minis/native-rooms-20261111`.
Goal: publish the physical rooms of a Roborock V1 robot (tested target: Q8 Max, `roborock.vacuum.a73`) in the
Matter `ServiceArea` cluster so Apple Home can clean by room.

## Changes

1. **Background room-resolution retry** (`AreaManagementService.scheduleAreaResolutionRetry`).
   In 1.1.9 `resolveInitialAreas()` runs once before registration. When `get_multi_maps_list` /
   `get_room_mapping` time out (the dispatcher returns empty structures silently), the endpoint is
   registered with routines only, and with _Live Map Updates_ ON the periodic refresh is fire-and-forget,
   so rooms never appear until a restart. The fork retries at 30 s, 1 min, 2 min, 5 min and 10 min
   (request/response path, independent of live map updates) until at least one physical room is known,
   then publishes `supportedMaps` + `supportedAreas` through the existing areas listener (routines kept).
2. **Room names from `/user/homes/{homeId}/rooms`** (read-only GET, same strategy as python-roborock
   `RoomsTrait`): only when the device reports segment iot ids that are missing from the cached home
   data; at most once per unknown id. `MapInfoListener` (live map push path) uses the refreshed names too.
3. **Diagnostics**: warning when the cloud reports the robot `online: false` for the configured
   account/region (map queries cannot succeed in that case), and a warning when startup produced no rooms.
4. `package.json`: version `1.1.9-minis.1`, `private: true` so Matterbridge (>= 3.11) reinstalls it from the
   uploaded tarball in `.matterbridge/uploads/` instead of npm after a container recreation.

No cleaning/movement commands were added or changed.
