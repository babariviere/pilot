// Image imports are explicit user actions. The host owns upload identities,
// credentials and storage. A failed upload retries the same bytes and ID.
import { Clipboard, Image, Picker, Text, View } from "nsh";
import type { StagedAttachmentRef } from "../../packages/protocol/src/transfers.ts";
import { call, windowId } from "./bridge";
import { feedbackDraft, feedbackImageBusy, feedbackMessage, feedbackPendingImage as pending } from "./feedbackView";
import { Action } from "./ui";

const MAX_IMAGE = 8 * 1024 * 1024;

export function FeedbackImages(props: { disabled: boolean }) {
	const discard = (id: string | null) => {
		const window = windowId();
		if (window && id) void call(window, "day.feedback.image", { uploadId: id });
	};
	const remove = (id: string) => {
		feedbackDraft.update((d) => ({ ...d, attachments: d.attachments?.filter((a) => a.uploadId !== id) }));
		discard(id);
	};
	const upload = async () => {
		const window = windowId();
		const image = pending();
		if (!window || !image) {
			feedbackMessage.set("Pilot is not connected. Your image has not been attached.");
			return;
		}
		feedbackImageBusy.set(true);
		try {
			if (!image.uploadId) {
				const r = await call(window, "day.feedback.image", {});
				if (!r.ok || typeof r.value.uploadId !== "string") throw new Error();
				image.uploadId = r.value.uploadId;
			}
			const r = await call(window, "day.feedback.image", image);
			if (!r.ok || !r.value.image) throw new Error();
			const reference = r.value.image as StagedAttachmentRef;
			feedbackDraft.update((d) => ({ ...d, attachments: [...(d.attachments ?? []), reference] }));
			pending.set(null);
			feedbackMessage.set("");
		} catch {
			feedbackMessage.set("The image did not upload. Retry it, or remove it before sending.");
		} finally {
			feedbackImageBusy.set(false);
		}
	};
	const attach = async (data: string) => {
		if (!data.startsWith("data:image/png;base64,") || data.length > (MAX_IMAGE * 4) / 3 + 64) {
			feedbackMessage.set("Choose a PNG image under 8 MiB.");
			return;
		}
		pending.set({ data, uploadId: null });
		await upload();
	};
	const choose = async () => {
		if (blocked()) return;
		feedbackImageBusy.set(true);
		try {
			const files = await Picker.pickFiles({ filters: [{ name: "PNG images", extensions: ["png"] }] });
			const file = files[0]?.file;
			if (!file) return;
			if (file.size > MAX_IMAGE) {
				feedbackMessage.set("Choose a PNG image under 8 MiB.");
				return;
			}
			const bytes = new Uint8Array(await file.arrayBuffer());
			let binary = "";
			for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
			await attach(`data:image/png;base64,${btoa(binary)}`);
		} catch {
			feedbackMessage.set("Pilot could not open that image. Choose a PNG image under 8 MiB.");
		} finally {
			feedbackImageBusy.set(false);
		}
	};
	const paste = async () => {
		if (blocked()) return;
		feedbackImageBusy.set(true);
		try {
			const image = await Clipboard.readImage();
			if (image) await attach(image.url);
			else feedbackMessage.set("No image on the clipboard. Copy a screenshot first.");
		} catch {
			feedbackMessage.set("Pilot could not paste that image. Choose a PNG image instead.");
		} finally {
			feedbackImageBusy.set(false);
		}
	};
	const blocked = () =>
		props.disabled || feedbackImageBusy() || pending() !== null || (feedbackDraft().attachments?.length ?? 0) >= 4;
	return (
		<View class="gap-2">
			<View class="flex-row items-center gap-3">
				<Action label="Add image…" testID="feedback-image-add" disabled={blocked()} onPress={() => void choose()} />
				<Action
					label="Paste image"
					testID="feedback-image-paste"
					disabled={blocked()}
					onPress={() => void paste()}
				/>
				<Text class="text-xs text-faint">PNG · up to four · 8 MiB each</Text>
			</View>
			<Each of={feedbackDraft().attachments ?? []} key={(r) => r.uploadId}>
				{(r, index) => (
					<View class="flex-row items-center gap-3">
						<Text class="flex-1 text-xs text-muted-foreground">{`Image ${index() + 1} attached`}</Text>
						<Action
							label="Remove"
							accessibilityLabel={`Remove image ${index() + 1}`}
							disabled={props.disabled || feedbackImageBusy()}
							onPress={() => remove(r().uploadId)}
						/>
					</View>
				)}
			</Each>
			<If when={pending()}>
				<View class="gap-2">
					<Image src={pending()?.data ?? ""} class="h-32 w-48" />
					<Text class="text-xs text-muted-foreground">
						{feedbackImageBusy() ? "Uploading image…" : "Image not attached"}
					</Text>
					<View class="flex-row gap-3">
						<Action
							label="Retry upload"
							testID="feedback-image-retry"
							disabled={feedbackImageBusy()}
							onPress={() => void upload()}
						/>
						<Action
							label="Remove image"
							disabled={feedbackImageBusy()}
							onPress={() => {
								discard(pending()?.uploadId ?? null);
								pending.set(null);
								feedbackMessage.set("");
							}}
						/>
					</View>
				</View>
			</If>
		</View>
	);
}
