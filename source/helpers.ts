export class AzureResourceId {

	subscriptionId: string;
	group: string;
	provider: string;
	type: string;
	name: string;

	constructor(subscriptionId: string, group: string, provider: string, type: string, name: string) {
		this.subscriptionId = subscriptionId;
		this.group = group;
		this.provider = provider;
		this.type = type;
		this.name = name;
	}

	static FromString(resourceId: string, expectedType: string): AzureResourceId {
		const components = resourceId.split("/");
		if (components.length !== 9 || components[0] !== "" || components[1] !== "subscriptions")
			throw new Error(`Invalid resource ID: ${resourceId}`);
		if (`${components[6]}/${components[7]}` !== expectedType)
			throw new Error(`Invalid resource type: ${components[6]}/${components[7]}. Expected: ${expectedType}`);

		return new AzureResourceId(components[2], components[4], components[6], components[7], components[8]);
	}
}

import { PagedAsyncIterableIterator } from '@azure/core-paging';
export async function Flatten<T>(iterable: PagedAsyncIterableIterator<T>): Promise<T[]> {
	let result: T[] = [];
	for await (const page of iterable) {
		result = result.concat(page);
	}
	return result;
}

import fs = require("fs");
export function PathFiles(dir: fs.PathLike): string[] {
	const results: string[] = [];

	fs.readdirSync(dir).forEach((file) => {
		file = dir + "/" + file;
		const stat = fs.statSync(file);
		if (stat && stat.isDirectory())
			results.push(...PathFiles(file));

		else
			results.push(file);
	});

	return results;
}

export function CurrentTimeStamp(): string {
	const timeStamp = new Date();
	const revision = timeStamp.toISOString().replace(/[\-\:\T]/g, "").substring(0, 14);
	return revision;
}
