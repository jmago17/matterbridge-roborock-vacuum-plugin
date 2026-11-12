import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapInfo } from '../../core/application/models/MapInfo.js';
import { AreaManagementService } from '../../services/areaManagementService.js';
import { RoborockService } from '../../services/roborockService.js';
import { asType } from '../helpers/testUtils.js';

const duid = 'configured-fixture';
const logger = { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ids = [16, 17, 18, 19, 20, 21, 22, 23];
const names = ['Juegos', 'Dormitorio', 'Logela', 'Cocina', 'Salón', 'Pasillo', 'Baño2', 'Baño1'];
const roomNames = ids.map((segmentId, i) => ({ segmentId, mapId: 0, name: names[i] }));
const services: AreaManagementService[] = [];
function harness(multiple = false) {
	const routing = {
		getMapInfo: vi.fn().mockResolvedValue(MapInfo.empty()),
		getRoomMap: vi.fn().mockResolvedValue([]),
		supportsCurrentMapQuery: vi.fn().mockReturnValue(true),
		getCurrentMapId: vi.fn().mockResolvedValue(0),
		switchMap: vi.fn(),
	};
	const service = new AreaManagementService(asType(logger), asType(routing), false, multiple);
	service.setDeviceOverride(duid, {
		serialNumber: 'fixture-serial',
		roomNames,
		staticRooms: { mapId: 0, mapName: 'Configured Casa', segmentIds: ids },
	});
	services.push(service);
	return { service, routing };
}
afterEach(() => {
	services.splice(0).forEach((service) => service.clearAll());
});

describe('configured room names and explicit static fallback', () => {
	it('uses standard area IDs and maps selections exactly to segments 16–23, preserving routine identity', async () => {
		const { service } = harness();
		const routine = {
			areaId: 9252134,
			mapId: 999,
			areaInfo: {
				locationInfo: { locationName: 'Limpieza completa', floorNumber: null, areaType: null },
				landmarkInfo: null,
			},
		};
		service.setSupportedRoutines(duid, [routine]);
		await service.resolveInitialAreas(duid);
		expect(service.getSupportedAreas(duid).map((a) => a.areaId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(service.getSupportedAreas(duid).map((a) => a.areaInfo.locationInfo?.locationName)).toEqual(names);
		const facade = Object.create(RoborockService.prototype) as RoborockService;
		Object.defineProperty(facade, 'areaService', { value: service });
		for (const [index, segmentId] of ids.entries()) {
			service.setSelectedAreas(duid, [index]);
			expect(facade['buildCleanCommand'](duid)).toEqual({ type: 'room', roomIds: [segmentId] });
		}
		service.setSelectedAreas(duid, [9252134]);
		expect(facade['buildCleanCommand'](duid).type).toBe('routine');
		service.setSelectedAreas(duid, []);
		expect(service.getSelectedAreas(duid)).toEqual([]);
		expect(service.getSupportedRoutines(duid)).toEqual([routine]);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('NOT discovered/verified'));
	});
	it('does not replace automatic mapping and still overrides its display names', async () => {
		const { service, routing } = harness();
		routing.getRoomMap.mockResolvedValue([[20, 'cloud-id', 0]]);
		await service.resolveInitialAreas(duid);
		expect(service.getSupportedAreas(duid)).toHaveLength(1);
		expect(service.getSupportedAreasIndexMap(duid)?.getRoomId(0)).toBe(20);
		expect(service.getSupportedAreas(duid)[0].areaInfo.locationInfo?.locationName).toBe('Salón');
		expect(service.getSupportedMaps(duid)).toEqual([{ mapId: 0, name: 'Map 0' }]);
	});
	it('does not synthesize rooms from roomNames alone', async () => {
		const { service } = harness();
		service.setDeviceOverride(duid, { serialNumber: 'fixture-serial', roomNames });
		await service.resolveInitialAreas(duid);
		expect(service.getSupportedAreas(duid)).toEqual([]);
	});
	it('requires matching explicit map IDs and does not switch/load maps for fallback', async () => {
		const { service, routing } = harness(true);
		service.setDeviceOverride(duid, {
			serialNumber: 'fixture-serial',
			roomNames: [
				{ segmentId: 16, name: 'Ambiguous' },
				{ segmentId: 16, mapId: 0, name: 'Scoped' },
			],
			staticRooms: { mapId: 0, segmentIds: [16] },
		});
		await service.resolveInitialAreas(duid);
		expect(service.getSupportedAreas(duid)[0].areaInfo.locationInfo?.locationName).toBe('Scoped');
		expect(routing.switchMap).not.toHaveBeenCalled();
	});
	it('ignores mapless names in multiple-map mode', async () => {
		const { service } = harness(true);
		service.setDeviceOverride(duid, {
			serialNumber: 'fixture-serial',
			roomNames: [{ segmentId: 16, name: 'Ambiguous' }],
			staticRooms: { mapId: 2, segmentIds: [16] },
		});
		await service.resolveInitialAreas(duid);
		expect(service.getSupportedAreas(duid)[0].areaInfo.locationInfo?.locationName).toBe('Configured room 16');
		expect(service.getSupportedAreasIndexMap(duid)?.getAreaId(16, 2)).toBe(0);
	});
	it('does not resurrect configured fallback after shutdown during an automatic request', async () => {
		const { service, routing } = harness();
		let release!: (map: MapInfo) => void;
		routing.getMapInfo.mockImplementation(
			() =>
				new Promise<MapInfo>((resolve) => {
					release = resolve;
				}),
		);
		const pending = service.resolveInitialAreas(duid);
		service.clearAll();
		release(MapInfo.empty());
		await pending;
		expect(service.getSupportedAreas(duid)).toEqual([]);
	});
});
