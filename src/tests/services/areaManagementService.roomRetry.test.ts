import { ServiceArea } from 'matterbridge/matter/clusters';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROUTINE_MAP_ID } from '../../constants/ids.js';
import { MapInfo } from '../../core/application/models/index.js';
import { MultipleMapDto, RawRoomMappingData, RoomDto } from '../../roborockCommunication/models/home/index.js';
import { AreaManagementService } from '../../services/areaManagementService.js';

/**
 * Regression tests for the fork fix: a Q8 Max (roborock.vacuum.a73, V1) whose startup
 * get_multi_maps_list / get_room_mapping queries time out must still end up publishing its
 * physical rooms once the robot answers, instead of staying at "routines only" until restart.
 */
describe('AreaManagementService - room resolution retry', () => {
	const duid = 'q8max-duid';

	// Same layout HA reports for the real robot (map "Casa", flag 0, segments 16..23).
	const q8MaxMultiMap: MultipleMapDto = {
		max_multi_map: 4,
		max_bak_map: 1,
		multi_map_count: 1,
		map_info: [
			{
				mapFlag: 0,
				add_time: 1761811644,
				length: 4,
				name: 'Casa',
				bak_maps: [],
				rooms: [
					{ id: 16, tag: 0, iot_name_id: '9001' },
					{ id: 17, tag: 0, iot_name_id: '9002' },
					{ id: 18, tag: 0, iot_name_id: '9003' },
					{ id: 19, tag: 0, iot_name_id: '9004' },
					{ id: 20, tag: 0, iot_name_id: '9005' },
					{ id: 21, tag: 0, iot_name_id: '9006' },
					{ id: 22, tag: 0, iot_name_id: '9007' },
					{ id: 23, tag: 0, iot_name_id: '9008' },
				],
			},
		],
	} as unknown as MultipleMapDto;

	const roomNames: RoomDto[] = [
		{ id: 9001, name: 'Juegos' },
		{ id: 9002, name: 'Dormitorio' },
		{ id: 9003, name: 'Logela' },
		{ id: 9004, name: 'Cocina' },
		{ id: 9005, name: 'Salón' },
		{ id: 9006, name: 'Pasillo' },
		{ id: 9007, name: 'Baño 2' },
		{ id: 9008, name: 'Baño 1' },
	];

	const rawRoomMapping: RawRoomMappingData = [
		[16, '9001', 0],
		[17, '9002', 0],
		[18, '9003', 0],
		[19, '9004', 0],
		[20, '9005', 0],
		[21, '9006', 0],
		[22, '9007', 0],
		[23, '9008', 0],
	];

	const routineArea: ServiceArea.Area = {
		areaId: 9252134,
		mapId: ROUTINE_MAP_ID,
		areaInfo: { locationInfo: { locationName: 'Limpieza completa', floorNumber: null, areaType: null }, landmarkInfo: null },
	};

	let logger: any;
	let routing: { getMapInfo: ReturnType<typeof vi.fn>; getRoomMap: ReturnType<typeof vi.fn>; switchMap: ReturnType<typeof vi.fn> };
	let iotApi: { getRooms: ReturnType<typeof vi.fn>; getScenes: ReturnType<typeof vi.fn>; startScene: ReturnType<typeof vi.fn> };
	let service: AreaManagementService;

	beforeEach(() => {
		vi.useFakeTimers();
		logger = { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warn: vi.fn(), error: vi.fn() };
		routing = { getMapInfo: vi.fn(), getRoomMap: vi.fn(), switchMap: vi.fn() };
		iotApi = { getRooms: vi.fn(), getScenes: vi.fn(), startScene: vi.fn() };
		// Plugin options used by Josu: live map updates ON, multiple maps OFF.
		service = new AreaManagementService(logger, routing as any, true, false);
		service.setIotApi(iotApi as any);
		service.setDeviceRooms(duid, roomNames);
		service.setDeviceHomeId(duid, 4497972);
	});

	afterEach(() => {
		service.clearAll();
		vi.useRealTimers();
	});

	function areaNames(areas: ServiceArea.Area[]): (string | undefined)[] {
		return areas.map((a) => a.areaInfo.locationInfo?.locationName);
	}

	it('startup timeout leaves no physical rooms (reproduces 1.1.9 behaviour)', async () => {
		// Dispatcher returns empty structures when the OneShotResponseListener times out.
		routing.getMapInfo.mockResolvedValue(MapInfo.empty());
		routing.getRoomMap.mockResolvedValue([]);

		const result = await service.resolveInitialAreas(duid);

		expect(result.supportedAreas).toEqual([]);
		expect(service.hasPhysicalAreas(duid)).toBe(false);
	});

	it('publishes physical rooms (with routines kept) after a background retry succeeds', async () => {
		routing.getMapInfo.mockResolvedValueOnce(MapInfo.empty()).mockResolvedValue(new MapInfo(q8MaxMultiMap));
		routing.getRoomMap.mockResolvedValue([]);

		await service.resolveInitialAreas(duid);
		expect(service.hasPhysicalAreas(duid)).toBe(false);

		// Same listener wiring as DeviceConfigurator: rooms + routines, maps + "Routine" map.
		service.setSupportedRoutines(duid, [routineArea]);
		const published: { areas: ServiceArea.Area[]; maps: ServiceArea.Map[] }[] = [];
		service.registerAreasListener(duid, (areas, maps) => {
			const routines = service.getSupportedRoutines(duid) ?? [];
			const allMaps = routines.length > 0 ? [...maps, { mapId: ROUTINE_MAP_ID, name: 'Routine' }] : maps;
			published.push({ areas: [...areas, ...routines], maps: allMaps });
		});

		service.scheduleAreaResolutionRetry(duid, [1_000, 2_000]);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(service.hasPhysicalAreas(duid)).toBe(true);
		const last = published.at(-1);
		expect(last).toBeDefined();
		expect(areaNames(last!.areas)).toEqual([
			'Juegos',
			'Dormitorio',
			'Logela',
			'Cocina',
			'Salón',
			'Pasillo',
			'Baño 2',
			'Baño 1',
			'Limpieza completa',
		]);
		expect(last!.maps).toEqual([
			{ mapId: 0, name: 'Casa' },
			{ mapId: ROUTINE_MAP_ID, name: 'Routine' },
		]);
		// Matter coherence: every area references a published map and areaIds are unique.
		const mapIds = new Set(last!.maps.map((m) => m.mapId));
		expect(last!.areas.every((a) => a.mapId !== null && mapIds.has(a.mapId))).toBe(true);
		expect(new Set(last!.areas.map((a) => a.areaId)).size).toBe(last!.areas.length);
		// No further retries once rooms are known.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(routing.getMapInfo).toHaveBeenCalledTimes(2);
	});

	it('falls back to get_room_mapping when the map list has no rooms and keeps retrying with backoff', async () => {
		routing.getMapInfo.mockResolvedValue(MapInfo.empty());
		routing.getRoomMap.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue(rawRoomMapping);

		await service.resolveInitialAreas(duid);
		service.scheduleAreaResolutionRetry(duid, [1_000, 5_000]);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(service.hasPhysicalAreas(duid)).toBe(false);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(service.hasPhysicalAreas(duid)).toBe(true);
		expect(areaNames(service.getSupportedAreas(duid))).toContain('Salón');
	});

	it('gives up after the last retry and logs a hint about account/region', async () => {
		routing.getMapInfo.mockResolvedValue(MapInfo.empty());
		routing.getRoomMap.mockResolvedValue([]);

		service.scheduleAreaResolutionRetry(duid, [1_000]);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(service.hasPhysicalAreas(duid)).toBe(false);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('after all retries'));
	});

	it('does not schedule anything when rooms are already known', async () => {
		routing.getMapInfo.mockResolvedValue(new MapInfo(q8MaxMultiMap));
		await service.resolveInitialAreas(duid);
		expect(service.hasPhysicalAreas(duid)).toBe(true);

		service.scheduleAreaResolutionRetry(duid, [1_000]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(routing.getMapInfo).toHaveBeenCalledTimes(1);
	});

	it('treats the "Unknown - No Room" placeholder and routines as non-physical', () => {
		service.setSupportedAreas(duid, [
			{
				areaId: 1,
				mapId: 0,
				areaInfo: { locationInfo: { locationName: 'Unknown - No Room', floorNumber: 0, areaType: null }, landmarkInfo: null },
			},
			routineArea,
		]);
		expect(service.hasPhysicalAreas(duid)).toBe(false);
	});

	it('refreshes stale home room names from /user/homes/{id}/rooms when segment iot ids are unknown', async () => {
		// Cached home data only knows old names; the device maps segments to newer iot ids.
		service.setDeviceRooms(duid, [{ id: 1, name: 'Old room' }]);
		iotApi.getRooms.mockResolvedValue(roomNames);
		routing.getMapInfo.mockResolvedValue(MapInfo.empty());
		routing.getRoomMap.mockResolvedValue(rawRoomMapping);

		await service.resolveInitialAreas(duid);

		expect(iotApi.getRooms).toHaveBeenCalledWith(4497972);
		expect(areaNames(service.getSupportedAreas(duid))).toEqual([
			'Juegos',
			'Dormitorio',
			'Logela',
			'Cocina',
			'Salón',
			'Pasillo',
			'Baño 2',
			'Baño 1',
		]);

		// Only one refresh per unknown id.
		await service.resolveInitialAreas(duid);
		expect(iotApi.getRooms).toHaveBeenCalledTimes(1);
	});

	it('cancels pending retries on clearAll', async () => {
		routing.getMapInfo.mockResolvedValue(MapInfo.empty());
		routing.getRoomMap.mockResolvedValue([]);
		service.scheduleAreaResolutionRetry(duid, [1_000]);
		service.clearAll();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(routing.getMapInfo).not.toHaveBeenCalled();
	});
});
