import { isIPv4 } from 'node:net';

import type { DeviceOverride } from '../model/RoborockPluginPlatformConfig.js';

const validMapId = (id: unknown): id is number =>
	typeof id === 'number' && Number.isInteger(id) && id >= 0 && id <= 0xffffffff && id !== 999;
const validSegmentId = (id: unknown): id is number =>
	typeof id === 'number' && Number.isInteger(id) && id >= 1 && id <= 255;
const validName = (name: unknown): name is string =>
	typeof name === 'string' &&
	name.trim().length > 0 &&
	new TextEncoder().encode(name).length <= 64 &&
	Array.from(name).every((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code >= 32 && code !== 127;
	});

/** Reject the whole override, never log its untrusted contents or partially apply it. */
export function validateDeviceOverrides(value: unknown): asserts value is DeviceOverride[] | undefined {
	if (value === undefined) return;
	const fail = (): never => {
		throw new Error('Invalid deviceOverrides configuration (check serial, IPv4, map/segment IDs and names)');
	};
	if (!Array.isArray(value)) fail();
	const serials = new Set<string>();
	for (const entry of value as DeviceOverride[]) {
		if (
			!entry ||
			typeof entry !== 'object' ||
			typeof entry.serialNumber !== 'string' ||
			!entry.serialNumber.trim() ||
			serials.has(entry.serialNumber)
		)
			fail();
		serials.add(entry.serialNumber);
		if (
			entry.localIp !== undefined &&
			(typeof entry.localIp !== 'string' ||
				!isIPv4(entry.localIp) ||
				entry.localIp === '0.0.0.0' ||
				entry.localIp === '255.255.255.255' ||
				Number(entry.localIp.split('.')[0]) >= 224)
		)
			fail();
		if (entry.roomNames !== undefined) {
			if (!Array.isArray(entry.roomNames)) fail();
			const keys = new Set<string>();
			for (const room of entry.roomNames) {
				if (
					!room ||
					!validSegmentId(room.segmentId) ||
					!validName(room.name) ||
					(room.mapId !== undefined && !validMapId(room.mapId))
				)
					fail();
				const key = `${room.mapId ?? '*'}:${room.segmentId}`;
				if (keys.has(key)) fail();
				keys.add(key);
			}
		}
		if (entry.staticRooms !== undefined) {
			const rooms = entry.staticRooms;
			if (
				!rooms ||
				!validMapId(rooms.mapId) ||
				(rooms.mapName !== undefined && !validName(rooms.mapName)) ||
				!Array.isArray(rooms.segmentIds) ||
				rooms.segmentIds.length === 0 ||
				rooms.segmentIds.length > 255 ||
				rooms.segmentIds.some((id) => !validSegmentId(id)) ||
				new Set(rooms.segmentIds).size !== rooms.segmentIds.length
			)
				fail();
		}
	}
}
