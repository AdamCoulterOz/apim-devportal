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
	.action(async (apimResourceId, options) => {
		const client = new DevPortalClient(apimResourceId);
		if (options.export) await client.Export();
		if (options.delete) await client.Delete();
		if (options.import) await client.Import();
	});

program.parse(process.argv);