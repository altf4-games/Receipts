import Link from "next/link";
export default function NotFound() {
  return (
    <div className="slip mt-8 text-sm">
      <div className="font-bold">No such receipt.</div>
      <Link href="/" className="underline">Back to the feed</Link>
    </div>
  );
}
