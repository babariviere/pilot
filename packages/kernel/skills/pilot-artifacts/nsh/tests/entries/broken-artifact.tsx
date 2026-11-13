// An artifact that throws while it renders.
export default function Artifact(): never {
	throw new Error("rows is not iterable");
}
