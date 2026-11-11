# Fork notes: `1.1.9-minis.1` (jmago17)

Fork of RinDevJunior/matterbridge-roborock-vacuum-plugin 1.1.9, branch `minis/native-rooms-20261111`.
Goal: publish the physical rooms of a Roborock V1 robot (tested target: Q8 Max, `roborock.vacuum.a73`) in the
Matter `ServiceArea` cluster so Apple Home can clean by room.

## Changes

1. **Background room-resolution retry** (`AreaManagementService.scheduleAreaResolutionRetry`).
   In 1.1.9 `resolveInitialAreas()` runs once before registration. When `get_multi_maps_list` /
   `get_room_mapping` time out (the dispatcher returns empty structures silently), the endpoint is
   registered with routines only, and with *Live Map Updates* ON the periodic refresh is fire-and-forget,
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
