import path = require("path");
import mime = require('mime-types')
import fs = require("fs");
import { ApiManagementClient, ContentItemContract, ContentTypeContract, PortalRevisionContract } from "@azure/arm-apimanagement";
import { DefaultAzureCredential } from "@azure/identity";
import { ContainerClient } from "@azure/storage-blob";
import { RestClient } from "typed-rest-client/RestClient";
import { BearerCredentialHandler } from 'typed-rest-client/Handlers';
import { AzureResourceId, Flatten, PathFiles } from "./helpers";

export default class DevPortalClient {
	readonly folder: string = "./dump";
	readonly baseUrl: string;
	readonly client: ApiManagementClient;
	readonly resourceGroupName: string;
	readonly serviceName: string;
	readonly endpoint: string;
	readonly mediaFolder = path.join(this.folder, "media");
	readonly dataFolder = path.join(this.folder, "data");

	public constructor(serviceId: string, endpoint?: string) {
		const resourceId = AzureResourceId.FromString(serviceId, "Microsoft.ApiManagement/service");
		this.resourceGroupName = resourceId.group;
		this.serviceName = resourceId.name;
		this.endpoint = endpoint ?? "management.azure.com";
		this.client = new ApiManagementClient(new DefaultAzureCredential(), resourceId.subscriptionId, { $host: this.endpoint });
		this.baseUrl = `https://${this.endpoint}${serviceId}`;
	}

	private async getContentTypes(): Promise<ContentTypeContract[]> {
		return await Flatten(this.client.contentType.listByService(this.resourceGroupName, this.serviceName));
	}

	private async getContentItems(contentTypeId: string): Promise<ContentItemContract[]> {
		return Flatten(this.client.contentItem.listByService(this.resourceGroupName, this.serviceName, contentTypeId));
	}

	/**
	 * Uploads media files to storage of specified API Management service.
	 */
	private async getContainerClient(): Promise<ContainerClient> {

		const credential = new DefaultAzureCredential();
		const token = await credential.getToken(`https://${this.endpoint}//.default`);

		// Get storage SAS URL
		let restClient = new RestClient("DevPortalClient", this.baseUrl, [new BearerCredentialHandler(token.token)]);
		let result = await restClient.create<{ containerSasUrl: string }>('portalSettings/mediaContent/listSecrets?api-version=2021-08-01', {});
		if (!result.result)
			throw new Error("Unable to get storage SAS URL.");
		const blobStorageUrl = result.result.containerSasUrl;

		// Get container client
		return new ContainerClient(blobStorageUrl);
	}

	/**
	 * Downloads media files from storage of specified API Management service.
	 */
	private async downloadBlobs() {
		const containerClient = await this.getContainerClient();
		let blobs = containerClient.listBlobsFlat();

		const downloadJobs = [];

		for await (const blob of blobs) {
			const contentType = blob.properties.contentType ?? "application/octet-stream";
			const ext = mime.extension(contentType);
			if (!ext)
				throw new Error(`Unable to determine file extension for content type ${contentType}.`);
			const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
			let filePath = path.join(this.mediaFolder, blob.name);
			// append the extension if it's missing
			if (!path.extname(filePath))
				filePath += `.${ext}`;

			const job = (async () => {
				await fs.promises.mkdir(path.resolve(path.dirname(filePath)), { recursive: true });
				await blockBlobClient.downloadToFile(filePath);
			})();
			downloadJobs.push(job);
		}

		// wait for all downloads to complete
		await Promise.all(downloadJobs);
	}

	private async uploadBlobs() {

		if (!fs.existsSync(this.mediaFolder)) {
			console.info("No media files found. Skipping media upload...");
			return;
		}

		const containerClient = await this.getContainerClient();
		const fileNames = PathFiles(this.mediaFolder);

		const uploadJobs = [];

		for (const fileName of fileNames) {

			// determine blob name and content type
			let blobName = path.relative(this.mediaFolder, fileName);
			let ext: string = path.extname(blobName);
			let contentType = mime.lookup(fileName);
			if (!contentType)
				throw new Error(`Unable to determine content type for file ${fileName}.`);

			// remote the extension if the blob doesnt have a sub folder
			if (path.dirname(blobName) == ".")
				blobName = path.basename(blobName, ext);

			// upload file
			const blockBlobClient = containerClient.getBlockBlobClient(blobName);
			const job = blockBlobClient.uploadFile(fileName, {
				blobHTTPHeaders: {
					blobContentType: contentType
				}
			});
			uploadJobs.push(job);
		}

		// wait for all uploads to complete
		await Promise.all(uploadJobs);
	}

	/**
	 * Deletes media files from storage of specified API Management service.
	 */
	private async deleteBlobs() {
		const containerClient = await this.getContainerClient();

		let blobs = containerClient.listBlobsFlat();
		const deleteJobs = [];

		for await (const blob of blobs) {
			const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
			const job = blockBlobClient.delete();
			deleteJobs.push(job);
		}

		// wait for all deletes to complete
		await Promise.all(deleteJobs);
	}

	/**
	 * Captures the content of specified API Management service into snapshot.
	 */
	private async downloadContent() {

		const contentTypes = await this.getContentTypes();
		const downloadJobs = [];
		for (const contentType of contentTypes) {
			const job = (async () => {
				const contentItems = await this.getContentItems(contentType.name!);
				const contentFolder = path.join(this.dataFolder, contentType.name!);
				if (contentItems.length > 0)
					await fs.promises.mkdir(contentFolder, { recursive: true });
				for (const contentItem of contentItems) {
					fs.writeFileSync(
						path.join(contentFolder, `${contentItem.name}.json`),
						JSON.stringify(contentItem, null, 2));
				}
			})();
			downloadJobs.push(job);
		}
		// wait for all downloads to complete
		await Promise.all(downloadJobs);
	}

	/**
	 * Deletes the content in specified API Management service.
	 */
	private async deleteContent() {
		const contentTypes = await this.getContentTypes();
		const deleteJobs: Promise<void>[] = [];
		for (const contentType of contentTypes) {
			const contentItems = await this.getContentItems(contentType.name!);
			for (const contentItem of contentItems) {
				const job = this.client.contentItem.delete(this.resourceGroupName, this.serviceName, contentType.name!, contentItem.name!, "*");
				deleteJobs.push(job);
			}
		}
		await Promise.all(deleteJobs);
	}

	/**
	 * Generates the content in specified API Management service from snapshot.
	 */
	private async uploadContent() {

		if (!fs.existsSync(this.dataFolder)) {
			console.info("No content files found. Skipping content upload...");
			return;
		}

		const fileNames = PathFiles(this.dataFolder);
		const uploadJobs = [];

		for (const fileName of fileNames) {
			let contentItemFile = path.relative(this.dataFolder, fileName);
			const contentItemJson = fs.readFileSync(fileName, "utf8");
			const contentItem = JSON.parse(contentItemJson) as ContentItemContract;
			const expectedContentType = path.dirname(contentItemFile);
			const expectedItemName = path.basename(contentItemFile, ".json");
			const actualItemType = contentItem.id?.split("/")[2];
			if (contentItem.name !== expectedItemName || actualItemType !== expectedContentType)
				throw new Error(`Content item ${contentItem.id} does not match expected name ${expectedItemName} or type ${expectedContentType}.`);
			const job = this.client.contentItem.createOrUpdate(this.resourceGroupName, this.serviceName, expectedContentType, expectedItemName, contentItem);
			uploadJobs.push(job);
		}
		await Promise.all(uploadJobs);
	}


	/**
	 * Deletes the content and media files in specfied service.
	 */
	async Delete() {
		console.log("Cleaning up...");

		try {
			await this.deleteContent();
			await this.deleteBlobs();
			console.log("Cleanup DONE");
		}
		catch (error: any) {
			throw new Error(`Unable to complete cleanup. ${error.message}`);
		}
	}

	/**
	 * Exports the content and media files from specfied service.
	 */
	async Export() {
		console.log("Exporting...");

		try {
			await this.downloadContent();
			await this.downloadBlobs();
			console.log("Export DONE");
		}
		catch (error: any) {
			throw new Error(`Unable to complete export. ${error.message}... inner error: ${error.stack}`);
		}
	}

	/**
	 * Imports the content and media files into specfied service.
	 */
	async Import() {
		console.log("Importing...");

		try {
			await this.uploadContent();
			await this.uploadBlobs();
			console.log("Import DONE");
		}
		catch (error: any) {
			throw new Error(`Unable to complete import. ${error.message}`);
		}
	}

	/**
	 * Publishes the content of the specified APIM service.
	 */
	async publish() {
		const timeStamp = new Date();
		const revision = timeStamp.toISOString().replace(/[\-\:\T]/g, "").substring(0, 14);
		const body: PortalRevisionContract = {
			description: `Migration ${revision}.`,
			isCurrent: true
		};

		await this.client.portalRevision.beginUpdateAndWait(this.resourceGroupName, this.serviceName, revision, "*", body);
	}

	/**
	 * Replaces existing URLs of API Management service with specified URLs.
	 */
	async updateContentUrl(existingUrls: any, replaceableUrls: any) {
		if (existingUrls.Count != replaceableUrls.Count) {
			throw new Error(`Existing URL and Replaceable URLs count mismatch.`);
		}

		const contentTypeId = "url";
		const contentItems = await this.getContentItems(contentTypeId);

		console.log("Number of urls found in portal: " + contentItems.length);

		for (const contentItem of contentItems) {
			var count = -1;
			console.log(" url found in portal: " + contentItem.properties?.permalink);

			for (const existingUrl of existingUrls) {
				count++;
				if (!contentItem.properties)
					continue;
				if (contentItem.properties.permalink == existingUrl) {
					contentItem.properties.permalink = replaceableUrls[count];
					console.log("updating URL content... for no. " + count + " link: " + contentItem.properties.permalink);
					console.log(" updated URL content : for no. " + count + " content item: " + JSON.stringify(contentItem));

					const response = await this.client.contentItem.createOrUpdate(this.resourceGroupName, this.serviceName, contentTypeId, contentItem.name!, contentItem);

					console.log(" response : " + JSON.stringify(response));
				}
			};
		};
	}
}
