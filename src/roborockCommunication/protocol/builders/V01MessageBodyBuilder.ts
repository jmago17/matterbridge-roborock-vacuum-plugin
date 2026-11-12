import { DpsPayload, MessageContext, Protocol, RequestMessage } from '../../models/index.js';
import { AbstractMessageBodyBuilder } from './abstractMessageBodyBuilder.js';

export class V01MessageBodyBuilder implements AbstractMessageBodyBuilder {
	buildPayload(request: RequestMessage, context: MessageContext): string {
		const data: DpsPayload = {
			id: request.messageId,
			method: request.method ?? '',
			params: request.params,
			security: undefined,
			result: undefined,
		};

		if (request.secure) {
			data.security = {
				endpoint: context.getEndpoint(),
				nonce: context.getSerializeNonceAsHex(),
			};
		}

		const payload = {
			dps: {
				// V1 LAN RPC uses outer protocol 4, but the RPC datapoint is 101.
				// Do not alter hello/ping, response, A01/B01 or secure map framing.
				[request.protocol === Protocol.general_request ? Protocol.rpc_request : request.protocol]: JSON.stringify(data),
			},
			t: request.timestamp,
		};

		return JSON.stringify(payload);
	}
}
