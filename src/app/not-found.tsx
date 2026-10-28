import Link from "next/link";

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>Page not found</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          The page you were looking for does not exist, or you no longer have access to it.
        </p>
        <Link href="/" className="btn btn-primary">
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
