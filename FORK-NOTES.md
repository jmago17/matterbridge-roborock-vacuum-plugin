# Fork notes: `1.1.9-minis.3` (jmago17)

Branch: `minis/local-ip-rooms-20261112`, based exactly on
`41bf7c82d5dded8da2dc80a164614233ed937625` (`1.1.9-minis.2`).
Private fork distribution only. No installation, restart, robot/HA access, npm
publication, upstream PR or authentication change in this phase.

## 1.1.9-minis.3: manual V1 LAN and configured rooms

- Optional `pluginConfiguration.deviceOverrides[]`, keyed by `serialNumber`,
  consistent with the existing per-device product-name override. `localIp` is
  strict IPv4 only (no hostname, URL, port, key or token). Duplicate serials,
  invalid IPv4, malformed room names/IDs or duplicate scoped segments fail
  configuration validation; untrusted values are not echoed by the validator.
- V1 manual IP takes precedence over cached IP and skips `get_network_info`
  entirely, even with cloud `online:false`. Uses the existing cloud-provided
  `localKey`, existing hello negotiation, TCP 58867, readiness and reconnection
  logic. No Xiaomi UDP 54321 token path. Without an override the previous
  discovery/MQTT-readiness fallback is unchanged. There is still no automatic
  retry over MQTT after a successfully sent LAN RPC times out.
- Bounded wire fix: only `V01MessageBodyBuilder` maps outer protocol 4 RPC
  payloads to DPS 101. Header stays 4. MQTT stays 101/101. Hello/ping, response,
  secure map security, A01/B01 and the already-correct L01 builder are unchanged.
  This affects all V1 LAN RPCs, not just this one robot, because the referenced
  protocol encoders both use DPS 101 independent of the outer RPC transport.
  References actually inspected at immutable commits:
  `mathiashornbek/homebridge-roborock-matter`
  `36c35800cb46335bdaedc5bc868317b0542942b9`,
  `roborockLib/lib/message.js`, lines 104–113; and
  `Python-roborock/python-roborock`
  `ed5f8591cccc204c1643b00b31d52d7ff43cede1`,
  `roborock/protocols/v1_protocol.py`, `RequestMessage._as_payload`.
  This supersedes the explicitly deferred DPS-4 limitation in the minis.2 notes.
- Preserve minis.2 MQTT-forced `get_multi_maps_list` with `params: []`, response
  listener armed before send, independent room-mapping fallback, verified
  `get_status` current map (`map_status >>> 2`, including map 0), and retry
  cancellation. Cloud offline warning no longer asserts a wrong account/region.
- `roomNames: [{segmentId, mapId?, name}]` only renames matching physical rooms,
  including live results. It does not create rooms. Exact-map entries take
  precedence; mapless names are used only with Multiple Maps OFF. IDs stay in
  the existing `RoomIndexMap`/Matter area-ID space, NOT segment IDs. Unicode
  names are supported, with a 64 UTF-8 byte limit and no control characters.
- Optional `staticRooms: {mapId, mapName?, segmentIds}` is an EXPLICIT UNVERIFIED
  fallback only after automatic startup resolution yields no physical areas.
  `mapId` is always mandatory, including single-map mode; 0 is valid and 999 is
  reserved for Routine. Known incompatible map metadata blocks fallback.
  Segment IDs must be integers 1–255, unique and finite. Fallback uses the same
  area/index conversion as automatic rooms and logs `source=configured, NOT
discovered/verified`; it never switches/loads maps. It does not overwrite any
  valid automatic physical mapping. Once configured rooms exist the existing
  missing-rooms retry stops; future live automatic mapping can replace them.
  Removing/changing fallback configuration requires a separately authorized
  reload/restart. Do not confuse configured data with robot verification.
- No routine dispatch, endpoint, pairing, persistence, auth, dependency versions,
  deployment target or permissions changes. Routine map 999 / area 9252134 are
  preserved. Single-map mode remains recommended; do not enable Multiple Maps
  for diagnosis because its pre-existing flow may switch robot maps.

### Configuration example (merge; do not replace authentication)

Replace `YOUR_ROBOT_SERIAL` with the serial already available in the plugin,
not a DUID, token or local key. No actual serial or DUID is included here.

```json
{
  "pluginConfiguration": {
    "enableMultipleMap": false,
    "sanitizeSensitiveLogs": true,
    "deviceOverrides": [{
      "serialNumber": "YOUR_ROBOT_SERIAL",
      "localIp": "192.168.31.116",
      "roomNames": [
        {"segmentId": 16, "mapId": 0, "name": "Juegos"},
        {"segmentId": 17, "mapId": 0, "name": "Dormitorio"},
        {"segmentId": 18, "mapId": 0, "name": "Logela"},
        {"segmentId": 19, "mapId": 0, "name": "Cocina"},
        {"segmentId": 20, "mapId": 0, "name": "Salón"},
        {"segmentId": 21, "mapId": 0, "name": "Pasillo"},
        {"segmentId": 22, "mapId": 0, "name": "Baño2"},
        {"segmentId": 23, "mapId": 0, "name": "Baño1"}
      ]
    }]
  }
}
```

Only if explicit configured fallback is wanted, add inside that same device:

```json
"staticRooms": {
  "mapId": 0,
  "mapName": "Casa (configurada)",
  "segmentIds": [16, 17, 18, 19, 20, 21, 22, 23]
}
```

Map 0 and these names are supplied configuration/HA metadata, not newly
verified robot output. No user layout is hardcoded into production code.
New sanitized source log lines (no IP, serial, DUID or key):
`[ConnectionService] Using configured V1 LAN address (source: manual override)`
and `[AreaManagementService] Publishing explicit configured static rooms;
source=configured, NOT discovered/verified`.

### Validation and limits

Mac LAN, new directory outside iCloud `~/tmp/rrfork-local-ip-20261112`.
Node 24.22.2 isolated official Darwin arm64 archive (global Node 25.8.1 untouched),
npm 11.19.1, Matterbridge 3.11.2 linked from `/tmp/mbg/node_modules/matterbridge`.
Node archive SHA256 `aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a`
matches official SHASUMS256.txt. `npm ci --ignore-scripts` used unchanged lockfile;
25 inherited npm audit findings (3 low, 16 moderate, 6 high); no audit fix or
claim of a full dependency security review.

Offline full suite: **2593 tests / 201 files PASS** (baseline 2548 / 198).
TypeScript noEmit and build, scoped ESLint and formatting are validated before
packaging. Additional tests cover invalid config/no sends, device scoping,
offline manual IP bypass/cache precedence, V1-only override, encrypted LAN
outer-4/DPS-101 mapping and status with incoming outer-4/DPS-102, wrong-ID
rejection, map 0, configured/automatic names, static-only-when-empty, Unicode,
map-specific ambiguity, routine coexistence, exact area-to-segment 16–23
translation without invoking cleaning, empty selection and shutdown cancellation.

This is NOT a real robot interoperability test or visual Apple Home validation.
No robot/HA sockets or commands were used. Subsequent authorized read-only
phase should: keep Multiple Maps OFF; use the EXISTING cloud key/session (never
log it) and confirmed IP on TCP 58867; inspect `get_room_mapping` and `get_status`
over LAN, record only method/channel/correlation/result summary; verify map 0
from raw map_status and match segment/name metadata from existing cloud/HA
information. Inspect ServiceArea supported maps/areas and index translation,
routine 999/9252134, endpoint 5 identity and untouched hass endpoint 1. Do not
start cleaning to test selection. No `app_segment_clean`, execute, routine,
`load_multi_map`, reset, pairing or login. Installation/restart is a separate
phase and is NOT authorized by this artifact preparation.

## Historical 1.1.9-minis.2

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
