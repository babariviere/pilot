export interface StagedAttachmentRef {
	uploadId: string;
	sha256: string;
	bytes: number;
}
export interface AttachmentUpload extends StagedAttachmentRef {
	origin: import("./operations.ts").OperationHost;
}
export interface AttachmentChatPayload<Request> {
	request: Request;
	attachments: StagedAttachmentRef[];
}
