import { describe, expect, it } from 'vitest';

import { validateDeviceOverrides } from '../../platform/deviceOverrides.js';

const base = { serialNumber: 'fixture-serial' };

describe('device override validation (no network)', () => {
	it('accepts IPv4, map zero, Unicode names and explicit fallback', () => {
		expect(() =>
			validateDeviceOverrides([
				{
					...base,
					localIp: '192.168.31.116',
					roomNames: [{ segmentId: 16, mapId: 0, name: 'Salón 🏠' }],
					staticRooms: { mapId: 0, segmentIds: [16, 23] },
				},
			]),
		).not.toThrow();
	});
	it.each([
		'http://192.168.1.2',
		'192.168.1.2:58867',
		'256.0.0.1',
		'192.168.01.2',
		'::1',
		'robot.local',
		'',
		'1.2.3.4 secret',
		'0.0.0.0',
		'255.255.255.255',
		'224.0.0.1',
	])('rejects unsafe localIp %s', (localIp) => {
		expect(() => validateDeviceOverrides([{ ...base, localIp }])).toThrow('Invalid deviceOverrides');
	});
	it.each([NaN, Infinity, -1, 0, 1.5, 256, '16', 9252134])('rejects invalid segment %s', (segmentId) => {
		expect(() => validateDeviceOverrides([{ ...base, roomNames: [{ segmentId, name: 'Room' }] }])).toThrow();
	});
	it.each([undefined, NaN, Infinity, -1, 0.5, 999, 0x100000000])(
		'requires explicit valid non-routine fallback map %s',
		(mapId) => {
			expect(() => validateDeviceOverrides([{ ...base, staticRooms: { mapId, segmentIds: [16] } }])).toThrow();
		},
	);
	it.each(['', ' ', 'bad\nname', 'é'.repeat(33)])('rejects invalid name %s', (name) => {
		expect(() => validateDeviceOverrides([{ ...base, roomNames: [{ segmentId: 16, name }] }])).toThrow();
	});
	it('rejects duplicate serials, duplicate segments and duplicate scoped names', () => {
		expect(() => validateDeviceOverrides([base, base])).toThrow();
		expect(() => validateDeviceOverrides([{ ...base, staticRooms: { mapId: 0, segmentIds: [16, 16] } }])).toThrow();
		expect(() =>
			validateDeviceOverrides([
				{
					...base,
					roomNames: [
						{ segmentId: 16, name: 'A' },
						{ segmentId: 16, name: 'B' },
					],
				},
			]),
		).toThrow();
	});
	it('allows repeated segments on distinct maps and leaves absent config unchanged', () => {
		expect(() => validateDeviceOverrides(undefined)).not.toThrow();
		expect(() =>
			validateDeviceOverrides([
				{
					...base,
					roomNames: [
						{ segmentId: 16, mapId: 0, name: 'A' },
						{ segmentId: 16, mapId: 1, name: 'B' },
					],
				},
			]),
		).not.toThrow();
	});
});
