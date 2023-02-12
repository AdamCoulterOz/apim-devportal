import { Command } from '@commander-js/extra-typings';
import figlet from "figlet";
import DevPortalClient from './DevPortalClient';

console.log(figlet.textSync("APIM  DevPortal"));

const program = (new Command())
	.version("0.1.0")
	.argument('<apimResourceId>')
	.option('--export', 'Export the DevPortal content')
	.option('--delete', 'Delete the DevPortal content')
	.option('--import', 'Import the DevPortal content')
	.option('--path <folder>', 'Path to the folder for import/export', ".")
	.option('--publish [name]', 'Publish the DevPortal content, optionally specifying a name for the publish revision')
	.action(async (apimResourceId, options) => {
		const path = options.path;
		const client = new DevPortalClient(apimResourceId, path);
		if (options.export) await client.Export();
		if (options.delete) await client.Delete();
		if (options.import) await client.Import();
		if (options.publish) await client.Publish(options.publish !== true ? options.publish : undefined);
	});

program.parse(process.argv);