import { describe, expect, it, vi } from 'vitest';

import { RoborockPluginPlatformConfig } from '../../model/RoborockPluginPlatformConfig.js';
import { PlatformConfigManager } from '../../platform/platformConfigManager.js';
import { ProtocolVersion } from '../../roborockCommunication/enums/protocolVersion.js';
import { Device, DeviceModel } from '../../roborockCommunication/models/index.js';
import { ConnectionService } from '../../services/connectionService.js';
import { asPartial, asType, makeLocalClientStub, makeLogger, makeMockClientRouter } from '../testUtils.js';

function harness(overrides?: unknown) {
	const logger = makeLogger();
	const config = PlatformConfigManager.create(
		asPartial<RoborockPluginPlatformConfig>({ pluginConfiguration: asType({ deviceOverrides: overrides }) }),
		logger,
	);
	const router = makeMockClientRouter();
	const local = makeLocalClientStub();
	vi.mocked(router.registerClient).mockReturnValue(asType(local));
	const service = new ConnectionService(asType({}), logger, asType({ registerMessageDispatcher: vi.fn() }), config);
	service.clientRouter = asType(router);
	service.setDeviceNotify(vi.fn());
	const device = asPartial<Device>({
		duid: 'fixture',
		serialNumber: 'fixture-serial',
		localKey: '0123456789abcdef',
		online: false,
		pv: ProtocolVersion.V1,
		specs: asType({ protocol: ProtocolVersion.V1, model: DeviceModel.S6 }),
	});
	return { service, router, local, device, logger };
}

describe('manual V1 local IP (no sockets)', () => {
	it('uses the confirmed override while cloud offline, bypasses cache and network-info RPC', async () => {
		const h = harness([{ serialNumber: 'fixture-serial', localIp: '192.168.31.116' }]);
		h.service.ipMap.set('fixture', '192.168.1.99');
		expect(await h.service.initializeMessageClientForLocal(h.device)).toBe(true);
		expect(h.router.registerClient).toHaveBeenCalledWith('fixture', '192.168.31.116');
		expect(h.router.query).not.toHaveBeenCalled();
		expect(h.local.connect).toHaveBeenCalledOnce();
		expect(h.service.ipMap.get('fixture')).toBe('192.168.31.116');
		await h.service.shutdown();
	});
	it('leaves automatic discovery as default and keeps overrides device-scoped', async () => {
		const h = harness([{ serialNumber: 'another-device', localIp: '192.168.31.116' }]);
		vi.mocked(h.router.query).mockResolvedValue(undefined);
		expect(await h.service.initializeMessageClientForLocal(h.device)).toBe(false);
		expect(h.router.query).toHaveBeenCalled();
		expect(h.router.registerClient).not.toHaveBeenCalled();
		await h.service.shutdown();
	});
	it('still connects using ordinary network-info discovery when no override exists', async () => {
		const h = harness();
		vi.mocked(h.router.query).mockResolvedValue({ ip: '192.168.31.117' });
		expect(await h.service.initializeMessageClientForLocal(h.device)).toBe(true);
		expect(h.router.query).toHaveBeenCalledWith(
			'fixture',
			expect.objectContaining({ method: 'get_network_info' }),
			expect.any(Function),
		);
		expect(h.router.registerClient).toHaveBeenCalledWith('fixture', '192.168.31.117');
		await h.service.shutdown();
	});
	it('rejects malformed config before queries or connections, without echoing input', async () => {
		const h = harness([{ serialNumber: 'fixture-serial', localIp: 'https://user:secret@host' }]);
		await expect(h.service.initializeMessageClientForLocal(h.device)).rejects.toThrow('Invalid deviceOverrides');
		expect(h.router.query).not.toHaveBeenCalled();
		expect(h.router.registerClient).not.toHaveBeenCalled();
		expect(JSON.stringify(h.logger)).not.toContain('secret');
		await h.service.shutdown();
	});
	it('does not extend manual TCP configuration to B01', async () => {
		const h = harness([{ serialNumber: 'fixture-serial', localIp: '192.168.31.116' }]);
		h.device.pv = ProtocolVersion.B01;
		await expect(h.service.initializeMessageClientForLocal(h.device)).rejects.toThrow('only for Roborock V1');
		expect(h.router.query).not.toHaveBeenCalled();
		expect(h.router.registerClient).not.toHaveBeenCalled();
		await h.service.shutdown();
	});
});
