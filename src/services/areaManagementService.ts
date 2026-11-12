import { AnsiLogger, debugStringify } from 'matterbridge/logger';
import { ServiceArea } from 'matterbridge/matter/clusters';

import { ROUTINE_MAP_ID } from '../constants/ids.js';
import { MapInfo, RoomIndexMap, RoomMap } from '../core/application/models/index.js';
import { HomeEntity } from '../core/domain/entities/Home.js';
import { DeviceError } from '../errors/index.js';
import {
	type AreaInfo,
	getSupportedAreas,
	type SegmentInfo,
	type SupportedAreasResult,
	toSupportedMaps,
} from '../initialData/getSupportedAreas.js';
import { mergeSupportedAreasByMap } from '../initialData/mergeSupportedAreasByMap.js';
import { RoborockIoTApi } from '../roborockCommunication/api/iotClient.js';
import { HomeModelMapper, RawRoomMappingData, RoomDto } from '../roborockCommunication/models/home/index.js';
import { Scene } from '../roborockCommunication/models/index.js';
import { MessageRoutingService } from './index.js';

/** Background retry schedule for room resolution when startup queries return nothing. */
export const AREA_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

/** Manages cleaning areas, rooms, maps, and scenes. */
export class AreaManagementService {
	private supportedAreas = new Map<string, ServiceArea.Area[]>();
	private supportedMaps = new Map<string, ServiceArea.Map[]>();
	private supportedRoutines = new Map<string, ServiceArea.Area[]>();
	private selectedAreas = new Map<string, number[]>();
	private progress = new Map<string, ServiceArea.Progress[]>();
	private lastActivelyCleaningState = new Map<string, boolean>();
	private supportedAreaIndexMaps = new Map<string, RoomIndexMap>();
	private areasListeners = new Map<string, (areas: ServiceArea.Area[], maps: ServiceArea.Map[]) => void>();
	private refreshIntervals = new Map<string, NodeJS.Timeout>();
	private deviceRooms = new Map<string, RoomDto[]>();
	private iotApi: RoborockIoTApi | undefined;
	private mapInfoCache = new Map<string, MapInfo>();
	private currentMapFallbackDevices = new Set<string>();
	private v1RoomResolutionCache = new Map<string, { segmentId: number; resolvedAtMs: number }>();
	private v1PendingResolution = new Map<string, { segmentId: number; consecutiveCount: number }>();

	private areaRetryTimers = new Map<string, NodeJS.Timeout>();
	// Tokens also cover requests in flight, after their timer has fired.
	private areaRetryTokens = new Map<string, object>();
	private deviceHomeIds = new Map<string, number>();
	private roomNameRefreshAttempted = new Set<string>();

	private static readonly V1_SEGMENT_CONFIRMATION_THRESHOLD = 2;

	constructor(
		private readonly logger: AnsiLogger,
		private readonly serviceRouting: MessageRoutingService | undefined,
		private readonly liveMapUpdates = false,
		private readonly enableMultipleMap = true,
	) {}

	private getPrimaryMapId(duid: string): number | undefined {
		return this.mapInfoCache.get(duid)?.maps[0]?.id;
	}

	public isMultipleMapEnabled(): boolean {
		return this.enableMultipleMap;
	}

	public setIotApi(iotApi: RoborockIoTApi): void {
		this.iotApi = iotApi;
	}

	public setDeviceRooms(duid: string, rooms: RoomDto[]): void {
		this.deviceRooms.set(duid, rooms);
	}

	public getDeviceRooms(duid: string): RoomDto[] | undefined {
		return this.deviceRooms.get(duid);
	}

	public setSelectedAreas(duid: string, selectedAreas: number[]): void {
		this.logger.debug('AreaManagementService - setSelectedAreas', debugStringify(selectedAreas));
		this.selectedAreas.set(duid, selectedAreas);
	}

	public getSelectedAreas(duid: string): number[] {
		return this.selectedAreas.get(duid) ?? [];
	}

	public setProgress(duid: string, progress: ServiceArea.Progress[]): void {
		this.logger.debug('AreaManagementService - setProgress', debugStringify(progress));
		this.progress.set(duid, progress);
	}

	public getProgress(duid: string): ServiceArea.Progress[] {
		return this.progress.get(duid) ?? [];
	}

	/** Store the "was actively cleaning" state for a device. */
	public setLastActivelyCleaningState(duid: string, isActivelyCleaning: boolean): void {
		this.logger.debug('AreaManagementService - setLastActivelyCleaningState', { duid, isActivelyCleaning });
		this.lastActivelyCleaningState.set(duid, isActivelyCleaning);
	}

	/** Retrieve the stored "was actively cleaning" state for a device. */
	public getLastActivelyCleaningState(duid: string): boolean {
		return this.lastActivelyCleaningState.get(duid) ?? false;
	}

	public registerAreasListener(
		duid: string,
		callback: (areas: ServiceArea.Area[], maps: ServiceArea.Map[]) => void,
	): void {
		this.areasListeners.set(duid, callback);
	}

	public setSupportedMaps(duid: string, maps: ServiceArea.Map[]): void {
		this.supportedMaps.set(duid, maps);
	}

	public getSupportedMaps(duid: string): ServiceArea.Map[] {
		return this.supportedMaps.get(duid) ?? [];
	}

	public setSupportedAreas(duid: string, supportedAreas: ServiceArea.Area[]): void {
		this.supportedAreas.set(duid, supportedAreas);
		const maps = this.supportedMaps.get(duid) ?? [];
		this.areasListeners.get(duid)?.(supportedAreas, maps);
	}

	public setSupportedAreaIndexMap(duid: string, indexMap: RoomIndexMap): void {
		this.supportedAreaIndexMaps.set(duid, indexMap);
	}

	public setSupportedRoutines(duid: string, routineAsRooms: ServiceArea.Area[]): void {
		this.supportedRoutines.set(duid, routineAsRooms);
	}

	public getSupportedAreas(duid: string): ServiceArea.Area[] {
		return this.supportedAreas.get(duid) ?? [];
	}

	public getSupportedAreasIndexMap(duid: string): RoomIndexMap | undefined {
		return this.supportedAreaIndexMaps.get(duid);
	}

	public mergeSupportedAreasForMap(
		duid: string,
		mapId: number,
		incomingAreas: ServiceArea.Area[],
		incomingIndexMap: RoomIndexMap,
	): void {
		const existingAreas = this.getSupportedAreas(duid);
		const existingIndexMap = this.getSupportedAreasIndexMap(duid);
		const { supportedAreas, roomIndexMap } = mergeSupportedAreasByMap(
			existingAreas,
			incomingAreas,
			mapId,
			existingIndexMap,
			incomingIndexMap,
		);
		this.setSupportedAreaIndexMap(duid, roomIndexMap);
		this.setSupportedAreas(duid, supportedAreas);
	}

	public getSupportedRoutines(duid: string): ServiceArea.Area[] | undefined {
		return this.supportedRoutines.get(duid);
	}

	private async fetchAndApplyMapInfo(duid: string, isActive: () => boolean = () => true): Promise<MapInfo | undefined> {
		if (!this.serviceRouting) {
			throw new DeviceError('Service routing not initialized', duid);
		}

		const mapInfo = await this.serviceRouting.getMapInfo(duid);
		if (!isActive()) return undefined;
		// An empty timeout response must not discard a previously verified map.
		if (mapInfo.maps.length === 0) return mapInfo;
		this.currentMapFallbackDevices.delete(duid);
		this.mapInfoCache.set(duid, mapInfo);
		if (mapInfo.hasRooms) {
			await this.refreshRoomNamesIfNeeded(
				duid,
				mapInfo.allRooms.map((r) => r.iot_name_id),
				isActive,
			);
			if (!isActive()) return undefined;
			const rooms = this.deviceRooms.get(duid) ?? [];
			const roomMappings = mapInfo.allRooms.map((dto) => HomeModelMapper.toRoomMapping(dto, rooms));
			const homeEntity = new HomeEntity(0, '', new RoomMap(roomMappings), mapInfo, 0);
			this.applyAreasResult(duid, getSupportedAreas(homeEntity, this.logger, this.enableMultipleMap));
		} else if (mapInfo.maps.length > 0) {
			this.setSupportedMaps(duid, toSupportedMaps(mapInfo, this.enableMultipleMap));
		}
		return mapInfo;
	}

	private applyAreasResult(duid: string, result: SupportedAreasResult, mergeMapId?: number): void {
		this.setSupportedMaps(duid, result.supportedMaps);
		if (this.enableMultipleMap && mergeMapId !== undefined) {
			this.mergeSupportedAreasForMap(duid, mergeMapId, result.supportedAreas, result.roomIndexMap);
			return;
		}
		this.setSupportedAreaIndexMap(duid, result.roomIndexMap);
		this.setSupportedAreas(duid, result.supportedAreas);
	}

	/** Publish areas/maps from a computed {@link SupportedAreasResult} (live push path). */
	public applySupportedAreasResult(duid: string, result: SupportedAreasResult, mergeMapId?: number): void {
		this.applyAreasResult(duid, result, mergeMapId);
	}

	private isPhysicalMapId(mapId: number): boolean {
		return mapId >= 0 && mapId !== ROUTINE_MAP_ID;
	}

	private hasAreasForMap(duid: string, mapId: number): boolean {
		return this.getSupportedAreas(duid).some((a) => a.mapId === mapId);
	}

	private applyRoomMapData(duid: string, rawData: RawRoomMappingData, expectedMapId?: number): number | undefined {
		if (!rawData || rawData.length === 0) {
			return undefined;
		}

		const storedMapInfo = this.mapInfoCache.get(duid) ?? MapInfo.empty();
		const resolvedMapId = storedMapInfo.resolveMapIdForRoomData(rawData, expectedMapId);

		if (!this.enableMultipleMap) {
			const primaryMapId = this.getPrimaryMapId(duid);
			if (primaryMapId !== undefined && resolvedMapId !== primaryMapId) {
				return undefined;
			}
		}

		const rooms = this.deviceRooms.get(duid) ?? [];
		const roomMappings = HomeModelMapper.rawRoomDataToRoomMappings(rawData, resolvedMapId, storedMapInfo, rooms);
		const homeEntity = new HomeEntity(0, '', new RoomMap(roomMappings), storedMapInfo, 0);
		this.applyAreasResult(
			duid,
			getSupportedAreas(homeEntity, this.logger, this.enableMultipleMap),
			this.enableMultipleMap ? resolvedMapId : undefined,
		);
		return resolvedMapId;
	}

	private async fetchAndApplyRoomMap(
		duid: string,
		activeMap: number,
		expectedMapId?: number,
		isActive: () => boolean = () => true,
	): Promise<number | undefined> {
		if (!this.serviceRouting) {
			throw new DeviceError('Service routing not initialized', duid);
		}

		// Always ask for rooms, even if map-list discovery failed.
		const rawData = await this.serviceRouting.getRoomMap(duid, activeMap);
		if (!isActive() || !rawData?.length) return undefined;
		if (
			((this.mapInfoCache.get(duid)?.maps.length ?? 0) === 0 || this.currentMapFallbackDevices.has(duid)) &&
			expectedMapId === undefined &&
			this.serviceRouting.supportsCurrentMapQuery(duid)
		) {
			// V1 tuples contain segment/name/tag, NOT a map id. Never guess floor 0.
			const currentMapId = await this.serviceRouting.getCurrentMapId(duid);
			if (!isActive() || currentMapId === undefined || !this.isPhysicalMapId(currentMapId)) return undefined;
			this.mapInfoCache.set(
				duid,
				new MapInfo({
					max_multi_map: 0,
					max_bak_map: 0,
					multi_map_count: 1,
					map_info: [
						{ mapFlag: currentMapId, name: `Map ${currentMapId}`, add_time: 0, length: 0, bak_maps: [], rooms: [] },
					],
				}),
			);
			this.currentMapFallbackDevices.add(duid);
			expectedMapId = currentMapId;
		}
		await this.refreshRoomNamesIfNeeded(
			duid,
			rawData.map((entry) => entry[1]),
			isActive,
		);
		if (!isActive()) return undefined;
		return this.applyRoomMapData(duid, rawData, expectedMapId);
	}

	public async ensureAreasForMap(duid: string, mapId: number, options?: { switchFirst?: boolean }): Promise<boolean> {
		if (!this.isPhysicalMapId(mapId)) {
			return true;
		}
		if (!this.enableMultipleMap) {
			const primaryMapId = this.getPrimaryMapId(duid);
			if (primaryMapId !== undefined && mapId !== primaryMapId) {
				return this.hasAreasForMap(duid, mapId);
			}
		}
		if (this.hasAreasForMap(duid, mapId)) {
			return true;
		}

		try {
			if (options?.switchFirst === true && this.serviceRouting) {
				await this.serviceRouting.switchMap(duid, mapId);
			}
			await this.fetchAndApplyRoomMap(duid, mapId, mapId);
		} catch (err) {
			this.logger.error(`AreaManagementService - ensureAreasForMap failed for ${duid} map ${mapId}: ${String(err)}`);
			return false;
		}

		return this.hasAreasForMap(duid, mapId);
	}

	public async getMapInfo(duid: string): Promise<MapInfo | undefined> {
		this.logger.debug('AreaManagementService - getMapInfo', duid);
		if (this.liveMapUpdates) {
			if (!this.serviceRouting) {
				throw new DeviceError('Service routing not initialized', duid);
			}
			await this.serviceRouting.getMapInfoV2(duid);
			return undefined;
		}
		return this.fetchAndApplyMapInfo(duid);
	}

	public async getRoomMap(duid: string, activeMap: number): Promise<RawRoomMappingData | undefined> {
		this.logger.debug('AreaManagementService - getRoomMap', duid);
		if (this.liveMapUpdates) {
			if (!this.serviceRouting) {
				throw new DeviceError('Service routing not initialized', duid);
			}
			await this.serviceRouting.getRoomMapV2(duid, activeMap);
			return undefined;
		}
		if (!this.serviceRouting) {
			throw new DeviceError('Service routing not initialized', duid);
		}
		const rawData = await this.serviceRouting.getRoomMap(duid, activeMap);
		this.applyRoomMapData(duid, rawData);
		return rawData;
	}

	public async resolveInitialAreas(
		duid: string,
	): Promise<{ supportedAreas: ServiceArea.Area[]; supportedMaps: ServiceArea.Map[] }> {
		this.logger.debug('AreaManagementService - resolveInitialAreas', duid);

		try {
			let mapInfo: MapInfo | undefined;
			try {
				mapInfo = await this.fetchAndApplyMapInfo(duid);
			} catch (err) {
				this.logger.warn(`AreaManagementService - map list unavailable for ${duid}: ${String(err)}`);
			}
			const originalActiveMapId = await this.fetchAndApplyRoomMap(duid, -1);

			if (this.enableMultipleMap && mapInfo && this.serviceRouting) {
				for (const map of mapInfo.maps) {
					if (!this.isPhysicalMapId(map.id)) {
						continue;
					}
					if (this.hasAreasForMap(duid, map.id)) {
						continue;
					}
					await this.ensureAreasForMap(duid, map.id, { switchFirst: true });
				}

				if (originalActiveMapId !== undefined && this.isPhysicalMapId(originalActiveMapId)) {
					try {
						await this.serviceRouting.switchMap(duid, originalActiveMapId);
					} catch (err) {
						this.logger.warn(
							`AreaManagementService - resolveInitialAreas failed to restore active map ${originalActiveMapId} for ${duid}: ${String(err)}`,
						);
					}
				}

				this.sortSupportedAreasByMap(duid);
			}
		} catch (err) {
			this.logger.error(`AreaManagementService - resolveInitialAreas failed for ${duid}: ${String(err)}`);
		}

		const supportedAreas = this.getSupportedAreas(duid);
		const supportedMaps = this.getSupportedMaps(duid);

		return { supportedAreas, supportedMaps };
	}

	private sortSupportedAreasByMap(duid: string): void {
		const existingAreas = this.getSupportedAreas(duid);
		const existingIndexMap = this.getSupportedAreasIndexMap(duid);

		const indexedAreas = existingAreas.map((area, oldAreaId) => ({ area, oldAreaId }));
		const sortedIndexedAreas = [...indexedAreas].sort((a, b) => (a.area.mapId ?? 0) - (b.area.mapId ?? 0));

		const sortedAreas = sortedIndexedAreas.map(({ area }, newAreaId) => ({ ...area, areaId: newAreaId }));

		const areaInfos = new Map<number, AreaInfo>();
		const roomInfos = new Map<string, SegmentInfo>();

		sortedIndexedAreas.forEach(({ oldAreaId }, newAreaId) => {
			const info = existingIndexMap?.areaInfo.get(oldAreaId);
			if (!info) {
				return;
			}
			areaInfos.set(newAreaId, info);
			const mapId = info.mapId ?? 0;
			roomInfos.set(`${info.roomId}-${mapId}`, {
				areaId: newAreaId,
				mapId,
				roomName: info.roomName,
			});
		});

		const sortedIndexMap = new RoomIndexMap(areaInfos, roomInfos);
		this.setSupportedAreaIndexMap(duid, sortedIndexMap);
		this.setSupportedAreas(duid, sortedAreas);
	}

	/** True when at least one physical (non-routine) room area is published for the device. */
	public hasPhysicalAreas(duid: string): boolean {
		// getSupportedAreas() publishes an "Unknown - No Room" placeholder when the room map is empty.
		return this.getSupportedAreas(duid).some(
			(a) =>
				a.mapId !== null &&
				this.isPhysicalMapId(a.mapId) &&
				!(a.areaInfo.locationInfo?.locationName ?? '').startsWith('Unknown - '),
		);
	}

	/**
	 * Retry the request/response room resolution (get_multi_maps_list + get_room_mapping) in the
	 * background until physical rooms are known. Startup resolution can time out (MQTT only, robot
	 * busy/asleep, broker hiccup); 1.1.9 then kept an empty area list until the next restart because
	 * the periodic refresh is fire-and-forget when live map updates are enabled.
	 * Each successful apply notifies the registered areas listener, which updates the Matter attributes.
	 */
	public scheduleAreaResolutionRetry(duid: string, delaysMs: number[] = AREA_RETRY_DELAYS_MS): void {
		this.cancelAreaResolutionRetry(duid);
		if (this.hasPhysicalAreas(duid) || delaysMs.length === 0) {
			return;
		}
		const token = {};
		this.areaRetryTokens.set(duid, token);
		const [delay, ...rest] = delaysMs;
		const handle = setTimeout(() => {
			this.areaRetryTimers.delete(duid);
			const isActive = () => this.areaRetryTokens.get(duid) === token;
			void this.retryAreaResolution(duid, isActive).then((resolved) => {
				if (!isActive()) return;
				this.areaRetryTokens.delete(duid);
				if (!resolved && rest.length > 0) {
					this.scheduleAreaResolutionRetry(duid, rest);
				} else if (!resolved) {
					this.logger.warn(
						`AreaManagementService - rooms still unknown for ${duid} after all retries; map-list/room-mapping queries did not resolve physical areas`,
					);
				}
			});
		}, delay);
		handle.unref?.();
		this.areaRetryTimers.set(duid, handle);
	}

	public cancelAreaResolutionRetry(duid: string): void {
		this.areaRetryTokens.delete(duid);
		const handle = this.areaRetryTimers.get(duid);
		if (handle) {
			clearTimeout(handle);
			this.areaRetryTimers.delete(duid);
		}
	}

	private async retryAreaResolution(duid: string, isActive: () => boolean): Promise<boolean> {
		if (this.hasPhysicalAreas(duid)) {
			return true;
		}
		this.logger.info(`AreaManagementService - retrying room mapping for ${duid}`);
		try {
			try {
				await this.fetchAndApplyMapInfo(duid, isActive);
			} catch (err) {
				this.logger.warn(`AreaManagementService - map list unavailable for ${duid}: ${String(err)}`);
			}
			if (isActive() && !this.hasPhysicalAreas(duid)) {
				await this.fetchAndApplyRoomMap(duid, -1, undefined, isActive);
			}
		} catch (err) {
			this.logger.warn(`AreaManagementService - room mapping retry failed for ${duid}: ${String(err)}`);
		}
		const resolved = this.hasPhysicalAreas(duid);
		if (resolved) {
			this.logger.notice(
				`AreaManagementService - rooms resolved for ${duid}: ${this.getSupportedAreas(duid)
					.map((a) => a.areaInfo.locationInfo?.locationName)
					.join(', ')}`,
			);
		}
		return resolved;
	}

	/**
	 * Refresh room names from `/user/homes/{homeId}/rooms` when the device reports segment iot ids
	 * that are missing from the cached home data (same strategy as python-roborock's RoomsTrait).
	 */
	private async refreshRoomNamesIfNeeded(
		duid: string,
		iotIds: string[],
		isActive: () => boolean = () => true,
	): Promise<void> {
		const homeId = this.deviceHomeIds.get(duid);
		if (!this.iotApi || homeId === undefined || iotIds.length === 0) {
			return;
		}
		const known = new Set((this.deviceRooms.get(duid) ?? []).map((r) => String(r.id)));
		const unknown = iotIds.filter((id) => !known.has(id));
		if (unknown.length === 0 || unknown.every((id) => this.roomNameRefreshAttempted.has(`${duid}:${id}`))) {
			return;
		}
		unknown.forEach((id) => this.roomNameRefreshAttempted.add(`${duid}:${id}`));
		try {
			const rooms = await this.iotApi.getRooms(homeId);
			if (isActive() && rooms && rooms.length > 0) {
				this.logger.debug(`AreaManagementService - refreshed ${rooms.length} room names for ${duid}`);
				this.deviceRooms.set(duid, rooms);
			}
		} catch (err) {
			this.logger.debug(`AreaManagementService - room names refresh failed for ${duid}: ${String(err)}`);
		}
	}

	public setDeviceHomeId(duid: string, homeId: number): void {
		this.deviceHomeIds.set(duid, homeId);
	}

	public startPeriodicRefresh(duid: string, intervalMs = 5 * 60 * 1000): void {
		this.stopPeriodicRefresh(duid);
		const handle = setInterval(() => {
			this.logger.debug(`AreaManagementService - periodic area refresh for ${duid}`);
			this.getMapInfo(duid).catch((err: unknown) => {
				this.logger.error(`AreaManagementService - getMapInfo refresh failed for ${duid}: ${String(err)}`);
			});
		}, intervalMs);
		this.refreshIntervals.set(duid, handle);
	}

	public stopPeriodicRefresh(duid: string): void {
		const handle = this.refreshIntervals.get(duid);
		if (handle) {
			clearInterval(handle);
			this.refreshIntervals.delete(duid);
		}
	}

	public async getScenes(homeId: number): Promise<Scene[] | undefined> {
		if (!this.iotApi) {
			throw new DeviceError('IoT API not initialized');
		}

		return this.iotApi.getScenes(homeId);
	}

	public async startScene(sceneId: number): Promise<unknown> {
		if (!this.iotApi) {
			throw new DeviceError('IoT API not initialized');
		}

		return this.iotApi.startScene(sceneId);
	}

	public setV1ResolvedSegment(duid: string, segmentId: number): void {
		const pending = this.v1PendingResolution.get(duid);
		const consecutiveCount = pending && pending.segmentId === segmentId ? pending.consecutiveCount + 1 : 1;
		this.v1PendingResolution.set(duid, { segmentId, consecutiveCount });

		const confirmed = consecutiveCount >= AreaManagementService.V1_SEGMENT_CONFIRMATION_THRESHOLD;
		this.logger.debug('AreaManagementService - setV1ResolvedSegment', { duid, segmentId, consecutiveCount, confirmed });

		if (confirmed) {
			this.v1RoomResolutionCache.set(duid, { segmentId, resolvedAtMs: Date.now() });
		}
	}

	public getV1ResolvedSegment(duid: string, maxAgeMs = 30_000): number | undefined {
		const cached = this.v1RoomResolutionCache.get(duid);
		if (!cached) return undefined;
		if (Date.now() - cached.resolvedAtMs > maxAgeMs) return undefined;
		return cached.segmentId;
	}

	public async requestV1MapRefresh(duid: string): Promise<void> {
		if (!this.serviceRouting) return;
		try {
			await this.serviceRouting.requestHomeMapPush(duid);
		} catch (err: unknown) {
			this.logger.debug(`[${duid}] requestV1MapRefresh failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Clear all area management data and stop all refresh timers. */
	public clearAll(): void {
		for (const duid of this.refreshIntervals.keys()) {
			this.stopPeriodicRefresh(duid);
		}
		for (const duid of [...this.areaRetryTokens.keys()]) {
			this.cancelAreaResolutionRetry(duid);
		}
		this.deviceHomeIds.clear();
		this.roomNameRefreshAttempted.clear();
		this.supportedAreas.clear();
		this.supportedMaps.clear();
		this.supportedRoutines.clear();
		this.selectedAreas.clear();
		this.progress.clear();
		this.lastActivelyCleaningState.clear();
		this.supportedAreaIndexMaps.clear();
		this.areasListeners.clear();
		this.deviceRooms.clear();
		this.mapInfoCache.clear();
		this.currentMapFallbackDevices.clear();
		this.v1RoomResolutionCache.clear();
		this.v1PendingResolution.clear();
		this.logger.debug('AreaManagementService - All data cleared');
	}
}
