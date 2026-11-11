import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelIdentity } from "../core/types.js";

export function identityOf(
	model: Model<Api> | undefined,
): ModelIdentity | undefined {
	if (!model) {
		return undefined;
	}
	return { provider: String(model.provider), id: String(model.id) };
}

export function modelKey(model: Model<Api> | undefined): string {
	const identity = identityOf(model);
	return identity ? `${identity.provider}/${identity.id}` : "<none>";
}
