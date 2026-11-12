import { afterEach, describe, expect, it, vi } from 'vitest';

import { ROUTINE_MAP_ID } from '../../../constants/ids.js';
import { MessageContext, Protocol, RequestMessage, UserData } from '../../../roborockCommunication/models/index.js';
import { V01MessageBodyBuilder } from '../../../roborockCommunication/protocol/builders/V01MessageBodyBuilder.js';
import { MessageDeserializer } from '../../../roborockCommunication/protocol/deserializers/messageDeserializer.js';
import { V10MessageDispatcher } from '../../../roborockCommunication/protocol/dispatcher/V10MessageDispatcher.js';
import { MessageSerializer } from '../../../roborockCommunication/protocol/serializers/messageSerializer.js';
import { ClientRouter } from '../../../roborockCommunication/routing/clientRouter.js';
import { AreaManagementService } from '../../../services/areaManagementService.js';
import { MessageRoutingService } from '../../../services/messageRoutingService.js';
import { asPartial, asType } from '../../helpers/testUtils.js';

const duid = 'v1-fixture';
const user = asPartial<UserData>({
	rriot: { k: 'fixture', u: 'u', s: 's', h: 'h', r: { m: 'mqtt://localhost', a: '', l: '', r: 'EU' } },
});
const logger = { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warn: vi.fn(), error: vi.fn() };
const maps = {
	max_multi_map: 4,
	max_bak_map: 1,
	multi_map_count: 1,
	map_info: [{ mapFlag: 0, name: 'Home', rooms: [] }],
};

function harness() {
	const router = new ClientRouter(asType(logger), user);
	router.registerDevice(duid, '0123456789abcdef', '1.0', 1234);
	const context = router['context'];
	const serializer = new MessageSerializer(context, asType(logger));
	const deserializer = new MessageDeserializer(context, asType(logger));
	const mqtt = { send: vi.fn(), disconnect: vi.fn() };
	const local = { send: vi.fn(), isReady: vi.fn().mockReturnValue(true) };
	router['mqttClient'] = asType(mqtt);
	router['localClients'].set(duid, asType(local));
	const dispatcher = new V10MessageDispatcher(asType(logger), router);
	async function reply(id: number, result: unknown, target = duid, protocol = Protocol.rpc_response) {
		const request = new RequestMessage({
			protocol,
			body: JSON.stringify({ dps: { 102: JSON.stringify({ id, result }) } }),
		});
		const { buffer } = serializer.serialize(duid, request);
		await router['broadcasterFactory'].onMessage(deserializer.deserialize(target, buffer, 'fixture'));
	}
	return { router, dispatcher, mqtt, local, context, serializer, deserializer, reply };
}

afterEach(() => vi.useRealTimers());

describe('V1 native map transport (no network)', () => {
	it('uses MQTT outer 101 / DPS 101 / params [] even with ready LAN; correlates a fast encrypted reply', async () => {
		const h = harness();
		h.mqtt.send.mockImplementation(async (_duid, request: RequestMessage) => {
			expect(request.forceMqtt).toBe(true);
			expect(request.secure).toBe(false);
			const { buffer } = h.serializer.serialize(duid, request);
			expect(buffer.readUInt16BE(15)).toBe(101);
			const payload = new V01MessageBodyBuilder().buildPayload(request, h.context);
			const dps = JSON.parse(payload).dps;
			expect(Object.keys(dps)).toEqual(['101']);
			expect(JSON.parse(dps[101])).toEqual({ id: request.messageId, method: 'get_multi_maps_list', params: [] });
			await h.reply(request.messageId + 1, [maps]); // wrong id ignored
			await h.reply(request.messageId, [maps], 'other-device'); // wrong device ignored
			await h.reply(request.messageId, [maps]); // before send resolves
		});
		const result = await h.dispatcher.getMapInfo(duid);
		expect(result.maps[0]?.id).toBe(0);
		expect(result.maps[0]?.name).toBe('Home');
		expect(h.local.send).not.toHaveBeenCalled();
	});

	it('publishes native areas through real routing/dispatcher from encrypted replies while keeping routine IDs', async () => {
		const h = harness();
		const routing = new MessageRoutingService(asType(logger));
		routing.registerMessageDispatcher(duid, h.dispatcher);
		const service = new AreaManagementService(asType(logger), routing, true, false);
		service.setDeviceRooms(duid, [{ id: 101, name: 'Kitchen' }]);
		const routine = {
			areaId: 9252134,
			mapId: ROUTINE_MAP_ID,
			areaInfo: { locationInfo: { locationName: 'Full clean', floorNumber: null, areaType: null }, landmarkInfo: null },
		};
		service.setSupportedRoutines(duid, [routine]);
		const publish = vi.fn();
		service.registerAreasListener(duid, (areas, supportedMaps) =>
			publish([...areas, ...(service.getSupportedRoutines(duid) ?? [])], supportedMaps),
		);
		h.mqtt.send.mockImplementation(async (_duid, request: RequestMessage) => h.reply(request.messageId, [maps]));
		h.local.send.mockImplementation(async (_duid, request: RequestMessage) =>
			h.reply(request.messageId, [[16, '101', 14]]),
		);
		try {
			await service.resolveInitialAreas(duid);
			expect(publish.mock.lastCall?.[0].map((a: { areaId: number; mapId: number }) => [a.areaId, a.mapId])).toEqual([
				[0, 0],
				[9252134, ROUTINE_MAP_ID],
			]);
			expect(service.getSupportedAreasIndexMap(duid)?.getAreaId(16, 0)).toBe(0);
			expect(service.getSupportedMaps(duid)).toEqual([{ mapId: 0, name: 'Home' }]);
		} finally {
			service.clearAll();
		}
	});

	it('uses the same MQTT contract for the live/fire-and-forget map-list path', async () => {
		const h = harness();
		await h.dispatcher.getMapInfoV2(duid);
		expect(h.mqtt.send).toHaveBeenCalledWith(
			duid,
			expect.objectContaining({ forceMqtt: true, secure: false, params: [] }),
		);
		expect(h.local.send).not.toHaveBeenCalled();
	});

	it('keeps room mapping on LAN, with MQTT fallback when LAN is not ready', async () => {
		const h = harness();
		const rooms = [[16, 'room-name-id', 0]];
		h.local.send.mockImplementation(async (_duid, request: RequestMessage) => {
			expect(request.params).toEqual([]);
			await h.reply(request.messageId, rooms);
		});
		expect(await h.dispatcher.getRoomMap(duid, -1)).toEqual(rooms);
		h.local.isReady.mockReturnValue(false);
		h.mqtt.send.mockImplementation(async (_duid, request: RequestMessage) => h.reply(request.messageId, rooms));
		expect(await h.dispatcher.getRoomMap(duid, -1)).toEqual(rooms);
		expect(h.mqtt.send).toHaveBeenCalledOnce();
	});

	it('round-trips encrypted V1 LAN mapping/status with outer 4 / DPS 101 and incoming outer 4 / DPS 102', async () => {
		const h = harness();
		h.local.send.mockImplementation(async (_duid, request: RequestMessage) => {
			const localRequest = request.toLocalRequest('1.0');
			const { buffer } = h.serializer.serialize(duid, localRequest);
			expect(buffer.readUInt16BE(15)).toBe(4);
			const decoded = h.deserializer.deserialize(duid, buffer, 'fixture');
			const rpc = JSON.parse(decoded.get(Protocol.rpc_request) as string);
			expect(rpc).toEqual({ id: request.messageId, method: request.method, params: [] });
			expect(decoded.get(Protocol.general_request)).toBeUndefined();
			const result = request.method === 'get_status' ? [{ map_status: 0 }] : [[16, 'cloud-room', 0]];
			await h.reply(request.messageId + 1, result, duid, Protocol.general_request);
			await h.reply(request.messageId, result, duid, Protocol.general_request);
		});
		expect(await h.dispatcher.getRoomMap(duid, -1)).toEqual([[16, 'cloud-room', 0]]);
		expect(await h.dispatcher.getCurrentMapId(duid)).toBe(0);
		expect(h.mqtt.send).not.toHaveBeenCalled();
	});

	it('uses outer 4 / DPS 101 for V1 LAN RPC without changing secure map requests', () => {
		const context = new MessageContext(user);
		const builder = new V01MessageBodyBuilder();
		const request = new RequestMessage({ method: 'get_status', params: [], nonce: 5678 });
		const local = request.toLocalRequest('1.0');
		expect(local.protocol).toBe(4);
		expect(JSON.parse(builder.buildPayload(local, context)).dps['101']).toBeDefined();
		expect(JSON.parse(builder.buildPayload(local, context)).dps['4']).toBeUndefined();
		const secure = new RequestMessage({ method: 'get_map_v1', secure: true, nonce: 5678 });
		const data = JSON.parse(JSON.parse(builder.buildPayload(secure, context)).dps['101']);
		expect(data.security).toEqual({ endpoint: context.getEndpoint(), nonce: context.getSerializeNonceAsHex() });
		expect(data.security.nonce).not.toBe(String(secure.nonce));
		expect(new RequestMessage({ forceMqtt: true }).toLocalRequest().forceMqtt).toBe(true);
	});

	it.each([
		[0, 0],
		[8, 2],
		[11, 2],
		[undefined, undefined],
		[-1, undefined],
		[1.5, undefined],
		[0x100000000, undefined],
	])('verifies map_status %s as current map %s', async (mapStatus, expected) => {
		const h = harness();
		h.local.send.mockImplementation(async (_duid, request: RequestMessage) => {
			expect(request.method).toBe('get_status');
			expect(request.params).toEqual([]);
			await h.reply(request.messageId, [{ map_status: mapStatus }]);
		});
		expect(await h.dispatcher.getCurrentMapId(duid)).toBe(expected);
	});

	it('cleans the response timer and listener after send failure or timeout', async () => {
		vi.useFakeTimers();
		const h = harness();
		const deregister = vi.spyOn(h.router['broadcasterFactory'], 'deregister');
		h.mqtt.send.mockRejectedValueOnce(new Error('synthetic send failure'));
		const request = new RequestMessage({ forceMqtt: true });
		expect(await h.router.query(duid, request, () => undefined, 100)).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		const pending = h.router.query(duid, request, () => undefined, 100);
		await vi.advanceTimersByTimeAsync(100);
		expect(await pending).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		expect(deregister).toHaveBeenCalledTimes(2);
	});
});
