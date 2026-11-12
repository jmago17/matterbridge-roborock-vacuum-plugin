import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROUTINE_MAP_ID } from '../../constants/ids.js';
import { MapInfo } from '../../core/application/models/MapInfo.js';
import { AreaManagementService } from '../../services/areaManagementService.js';
import { asType } from '../helpers/testUtils.js';

const duid = 'fallback-v1';
const logger = { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warn: vi.fn(), error: vi.fn() };
const rawRooms = [
	[16, '101', 14],
	[17, '102', 9],
];
const verifiedMap = () =>
	new MapInfo({
		max_multi_map: 1,
		max_bak_map: 0,
		multi_map_count: 1,
		map_info: [{ mapFlag: 2, name: 'Upstairs', add_time: 0, length: 0, bak_maps: [], rooms: [] }],
	});

describe('AreaManagementService V1 mapping fallback and shutdown', () => {
	let service: AreaManagementService;
	let routing: {
		supportsCurrentMapQuery: ReturnType<typeof vi.fn>;
		getMapInfo: ReturnType<typeof vi.fn>;
		getRoomMap: ReturnType<typeof vi.fn>;
		getCurrentMapId: ReturnType<typeof vi.fn>;
		switchMap: ReturnType<typeof vi.fn>;
	};
	beforeEach(() => {
		vi.useFakeTimers();
		routing = {
			supportsCurrentMapQuery: vi.fn().mockReturnValue(true),
			getMapInfo: vi.fn().mockResolvedValue(MapInfo.empty()),
			getRoomMap: vi.fn().mockResolvedValue(rawRooms),
			getCurrentMapId: vi.fn().mockResolvedValue(2),
			switchMap: vi.fn(),
		};
		service = new AreaManagementService(asType(logger), asType(routing), true, false);
		service.setDeviceRooms(duid, [
			{ id: 101, name: 'Kitchen' },
			{ id: 102, name: 'Study' },
		]);
	});
	afterEach(() => {
		service.clearAll();
		vi.useRealTimers();
	});

	it.each(['empty', 'throw'])(
		'resolves native rooms after %s map list, verifies current map AFTER room mapping',
		async (failure) => {
			if (failure === 'throw') routing.getMapInfo.mockRejectedValue(new Error('fixture map-list failure'));
			const routine = {
				areaId: 9252134,
				mapId: ROUTINE_MAP_ID,
				areaInfo: {
					locationInfo: { locationName: 'Full clean', floorNumber: null, areaType: null },
					landmarkInfo: null,
				},
			};
			service.setSupportedRoutines(duid, [routine]);
			const publish = vi.fn();
			service.registerAreasListener(duid, (areas, maps) =>
				publish(
					[...areas, ...(service.getSupportedRoutines(duid) ?? [])],
					[...maps, { mapId: ROUTINE_MAP_ID, name: 'Routine' }],
				),
			);
			const result = await service.resolveInitialAreas(duid);
			expect(routing.getRoomMap).toHaveBeenCalledWith(duid, -1);
			expect(routing.getCurrentMapId.mock.invocationCallOrder[0]).toBeGreaterThan(
				routing.getRoomMap.mock.invocationCallOrder[0],
			);
			expect(result.supportedAreas.map((a) => [a.areaId, a.mapId, a.areaInfo.locationInfo?.locationName])).toEqual([
				[0, 2, 'Kitchen'],
				[1, 2, 'Study'],
			]);
			expect(result.supportedMaps).toEqual([{ mapId: 2, name: 'Map 2' }]);
			expect(service.getSupportedAreasIndexMap(duid)?.getAreaId(16, 2)).toBe(0);
			expect(publish.mock.lastCall?.[0].at(-1)).toEqual(routine);
			expect(routing.switchMap).not.toHaveBeenCalled();
		},
	);

	it('re-verifies fallback map identity rather than caching a possibly switched floor', async () => {
		await service.resolveInitialAreas(duid);
		routing.getCurrentMapId.mockResolvedValue(0);
		await service.resolveInitialAreas(duid);
		expect(routing.getCurrentMapId).toHaveBeenCalledTimes(2);
		expect(service.getSupportedAreas(duid).map((a) => a.mapId)).toEqual([0, 0]);
		expect(service.getSupportedMaps(duid)).toEqual([{ mapId: 0, name: 'Map 0' }]);
	});

	it('preserves the legacy room path for dispatchers without V1 current-map capability', async () => {
		routing.supportsCurrentMapQuery.mockReturnValue(false);
		await service.resolveInitialAreas(duid);
		expect(routing.getCurrentMapId).not.toHaveBeenCalled();
		expect(service.hasPhysicalAreas(duid)).toBe(true);
	});

	it('does not publish rooms under assumed map 0 if current-map verification fails', async () => {
		routing.getCurrentMapId.mockResolvedValue(undefined);
		await service.resolveInitialAreas(duid);
		expect(routing.getRoomMap).toHaveBeenCalled();
		expect(service.hasPhysicalAreas(duid)).toBe(false);
	});

	it('does not fetch status when no room mapping arrived', async () => {
		routing.getRoomMap.mockResolvedValue([]);
		await service.resolveInitialAreas(duid);
		expect(routing.getCurrentMapId).not.toHaveBeenCalled();
	});

	it('background fallback works even when map-list request rejects', async () => {
		routing.getMapInfo.mockRejectedValue(new Error('fixture'));
		service.scheduleAreaResolutionRetry(duid, [10, 20]);
		await vi.advanceTimersByTimeAsync(10);
		expect(service.hasPhysicalAreas(duid)).toBe(true);
		await vi.advanceTimersByTimeAsync(100);
		expect(routing.getRoomMap).toHaveBeenCalledOnce();
		expect(routing.switchMap).not.toHaveBeenCalled();
	});

	it.each(['cancel', 'clear'])(
		'does not apply or re-arm a retry cancelled during map-list request (%s)',
		async (stop) => {
			let finish!: (value: MapInfo) => void;
			routing.getMapInfo.mockImplementation(
				() =>
					new Promise<MapInfo>((resolve) => {
						finish = resolve;
					}),
			);
			const publish = vi.fn();
			service.registerAreasListener(duid, publish);
			service.scheduleAreaResolutionRetry(duid, [10, 20]);
			await vi.advanceTimersByTimeAsync(10);
			if (stop === 'clear') service.clearAll();
			else service.cancelAreaResolutionRetry(duid);
			finish(verifiedMap());
			await vi.advanceTimersByTimeAsync(100);
			expect(routing.getMapInfo).toHaveBeenCalledOnce();
			expect(routing.getRoomMap).not.toHaveBeenCalled();
			expect(publish).not.toHaveBeenCalled();
			expect(service.getSupportedMaps(duid)).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it('does not repopulate room names after clearAll during an in-flight cloud refresh', async () => {
		service.setDeviceHomeId(duid, 42);
		service.setDeviceRooms(duid, []);
		let finish!: (value: unknown) => void;
		const getRooms = vi.fn(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		service.setIotApi(asType({ getRooms }));
		service.scheduleAreaResolutionRetry(duid, [10, 20]);
		await vi.advanceTimersByTimeAsync(10);
		expect(getRooms).toHaveBeenCalledOnce();
		service.clearAll();
		finish([{ id: 101, name: 'Kitchen' }]);
		await vi.advanceTimersByTimeAsync(100);
		expect(service.getDeviceRooms(duid)).toBeUndefined();
		expect(service.getSupportedAreas(duid)).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('ignores room mapping finishing after clearAll', async () => {
		routing.getMapInfo.mockResolvedValue(verifiedMap());
		let finish!: (value: unknown) => void;
		routing.getRoomMap.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		service.scheduleAreaResolutionRetry(duid, [10, 20]);
		await vi.advanceTimersByTimeAsync(10);
		service.clearAll();
		finish(rawRooms);
		await vi.advanceTimersByTimeAsync(100);
		expect(service.getSupportedAreas(duid)).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
