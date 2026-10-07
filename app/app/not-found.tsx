import Link from "next/link";
export default function NotFound() {
  return (
    <div className="slip mt-8 text-sm">
      <h1 className="font-bold">No such receipt.</h1>
      <Link href="/" className="underline">Back to the feed</Link>
    </div>
  );
}
